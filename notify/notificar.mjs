// =====================================================================
//  notificar.mjs  ·  Fase 3 (correo + WhatsApp)
//  Toma las alertas 'pendiente' y las envía por correo (Resend) y/o
//  WhatsApp (Meta Cloud API) al buzón/número central. Cada canal es
//  independiente: si uno falla, el otro igual se intenta. Idempotente.
//
//  Modos:
//    node notificar.mjs --dry-run   → no envía; genera un HTML de muestra y lo imprime
//    node notificar.mjs             → contra Supabase + Resend + WhatsApp (usa .env)
// =====================================================================
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderAlertaEmail } from './plantillas.mjs';
import { enviarEmail } from './resend.mjs';
import { enviarPlantilla } from './whatsapp.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------
async function correrDryRun() {
  // Alerta de ejemplo con datos reales del proceso del Tribunal Administrativo
  const ejemplo = {
    radicado: '25000233600020210033100',
    cliente: 'ALFREDO GARZON NIÑO',
    despacho: 'TRIBUNAL ADMINISTRATIVO - SECCIÓN TERCERA - ORAL - BOGOTÁ',
    actuaciones: [
      { fechaActuacion: '2026-07-24', tipo: 'Recibe memoriales', anotacion: 'IYA-CORREO ELECTR. SECRETARIA SECCION TERCERA SUBSECCION C TAC. ALLEGA RESPUESTA OFICIO 00120-HABM-2026.' },
      { fechaActuacion: '2026-07-22', tipo: 'Constancia secretarial', anotacion: 'DVG-Se deja constancia de la elaboración y remisión del oficio ordenado en providencia judicial dictada el 21 de julio de 2026.' },
    ],
  };
  const { subject, html, text } = renderAlertaEmail(ejemplo);
  const out = join(__dirname, 'output');
  await mkdir(out, { recursive: true });
  const file = join(out, 'muestra-correo.html');
  await writeFile(file, html);
  console.log('ASUNTO:', subject);
  console.log('\n--- TEXTO PLANO ---\n' + text);
  console.log('\n✅ Vista previa HTML escrita en notify/output/muestra-correo.html');
}

// ---------------------------------------------------------------------
async function correrProduccion() {
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  const emailCentral = process.env.EMAIL_CENTRAL;
  const waCentral = process.env.WHATSAPP_CENTRAL;
  if (!url || !key) { console.error('Falta SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
  if (!emailCentral && !waCentral) { console.error('Falta EMAIL_CENTRAL y/o WHATSAPP_CENTRAL (a dónde llegan las alertas)'); process.exit(1); }
  const db = createClient(url, key, { auth: { persistSession: false } });

  // Alertas pendientes con su contexto. Tope de seguridad: si por algún bug o
  // corrida duplicada aparecen cientos de alertas de golpe, no se manda un
  // bombardeo de WhatsApp/correo — se manda un aviso de que hay que revisar
  // a mano en vez de saturar al número central (ver LIMITE_SEGURIDAD abajo).
  const LIMITE_SEGURIDAD = 30;
  const dashboardUrl = process.env.DASHBOARD_URL || 'https://rastreo-judicial.onrender.com';
  const { data: alertas, error } = await db
    .from('alertas')
    .select('id, tipo, detalle, proceso_id, actuacion_id, procesos(radicado, despacho, clientes(nombre)), actuaciones(fecha_actuacion, tipo, anotacion, con_documentos)')
    .eq('estado', 'pendiente').order('creado_en', { ascending: true }).limit(LIMITE_SEGURIDAD + 1);
  if (error) throw error;
  if (!alertas.length) { console.log('No hay alertas pendientes.'); return; }
  if (alertas.length > LIMITE_SEGURIDAD) {
    console.error(`⚠️  Hay más de ${LIMITE_SEGURIDAD} alertas pendientes de golpe (posible corrida duplicada u otro problema). ` +
      `No se envía nada por WhatsApp/correo para evitar un bombardeo — revisa la tabla "alertas" en Supabase antes de continuar.`);
    process.exit(1);
  }

  console.log(`Enviando ${alertas.length} alerta(s)…`);
  let enviadas = 0, fallidas = 0;
  for (const al of alertas) {
    const p = al.procesos || {};
    const act = al.actuaciones ? [al.actuaciones] : [];
    const primera = act[0] || {};
    let algunaOk = false;

    if (emailCentral) {
      const { subject, html, text } = renderAlertaEmail({
        radicado: p.radicado, cliente: p.clientes?.nombre, despacho: p.despacho,
        actuaciones: act.map(a => ({ fechaActuacion: a.fecha_actuacion, tipo: a.tipo, anotacion: a.anotacion })),
      });
      const { data: notif } = await db.from('notificaciones').insert({
        alerta_id: al.id, canal: 'email', destinatario_tipo: 'centro',
        destinatario_valor: emailCentral, cuerpo: text, estado: 'pendiente',
      }).select('id').single();
      try {
        const msgId = await enviarEmail({ to: emailCentral, subject, html, text });
        await db.from('notificaciones').update({ estado: 'enviada', proveedor_msg_id: msgId, enviada_en: new Date().toISOString() }).eq('id', notif.id);
        algunaOk = true;
      } catch (e) {
        await db.from('notificaciones').update({ estado: 'fallida', error: e.message }).eq('id', notif.id);
        console.log(`   ❌ [email] ${p.radicado}: ${e.message}`);
      }
    }

    if (waCentral) {
      const link = p.radicado ? `${dashboardUrl}/?radicado=${encodeURIComponent(p.radicado)}` : dashboardUrl;
      const docs = primera.con_documentos ? ' 📎 Con documentos para descargar.' : '';
      const resumen = `${primera.tipo || 'Novedad'} (${primera.fecha_actuacion || 'sin fecha'}).${docs} Ver detalle: ${link}`;
      const cuerpo = `${p.radicado} · ${p.clientes?.nombre || 'sin cliente'} · ${resumen}`;
      const { data: notif } = await db.from('notificaciones').insert({
        alerta_id: al.id, canal: 'whatsapp', destinatario_tipo: 'centro',
        destinatario_valor: waCentral, cuerpo, estado: 'pendiente',
      }).select('id').single();
      try {
        const msgId = await enviarPlantilla({
          to: waCentral,
          params: [p.radicado || '—', p.clientes?.nombre || 'sin cliente', resumen],
        });
        await db.from('notificaciones').update({ estado: 'enviada', proveedor_msg_id: msgId, enviada_en: new Date().toISOString() }).eq('id', notif.id);
        algunaOk = true;
      } catch (e) {
        await db.from('notificaciones').update({ estado: 'fallida', error: e.message }).eq('id', notif.id);
        console.log(`   ❌ [whatsapp] ${p.radicado}: ${e.message}`);
      }
    }

    if (algunaOk) { await db.from('alertas').update({ estado: 'notificada' }).eq('id', al.id); enviadas++; }
    else fallidas++;
  }
  console.log(`\n===== RESUMEN =====\nEnviadas: ${enviadas}  Fallidas: ${fallidas}`);
}

// ---------------------------------------------------------------------
(DRY ? correrDryRun() : correrProduccion()).catch(e => { console.error(e); process.exit(1); });
