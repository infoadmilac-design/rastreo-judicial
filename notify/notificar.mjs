// =====================================================================
//  notificar.mjs  ·  Fase 3 (correo)
//  Toma las alertas 'pendiente' y envía un correo al buzón central.
//  Marca la notificación y la alerta como enviadas. Idempotente.
//
//  Modos:
//    node notificar.mjs --dry-run   → no envía; genera un HTML de muestra y lo imprime
//    node notificar.mjs             → contra Supabase + Resend (usa .env)
// =====================================================================
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderAlertaEmail } from './plantillas.mjs';
import { enviarEmail } from './resend.mjs';

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
  const central = process.env.EMAIL_CENTRAL;
  if (!url || !key) { console.error('Falta SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
  if (!central) { console.error('Falta EMAIL_CENTRAL (buzón que recibe las alertas)'); process.exit(1); }
  const db = createClient(url, key, { auth: { persistSession: false } });

  // Alertas pendientes con su contexto
  const { data: alertas, error } = await db
    .from('alertas')
    .select('id, tipo, detalle, proceso_id, actuacion_id, procesos(radicado, despacho, clientes(nombre)), actuaciones(fecha_actuacion, tipo, anotacion)')
    .eq('estado', 'pendiente').limit(200);
  if (error) throw error;
  if (!alertas.length) { console.log('No hay alertas pendientes.'); return; }

  console.log(`Enviando ${alertas.length} alerta(s) al buzón central ${central}…`);
  let enviadas = 0, fallidas = 0;
  for (const al of alertas) {
    const p = al.procesos || {};
    const act = al.actuaciones ? [al.actuaciones] : [];
    const { subject, html, text } = renderAlertaEmail({
      radicado: p.radicado, cliente: p.clientes?.nombre, despacho: p.despacho,
      actuaciones: act.map(a => ({ fechaActuacion: a.fecha_actuacion, tipo: a.tipo, anotacion: a.anotacion })),
    });
    // Registrar intento
    const { data: notif } = await db.from('notificaciones').insert({
      alerta_id: al.id, canal: 'email', destinatario_tipo: 'centro',
      destinatario_valor: central, cuerpo: text, estado: 'pendiente',
    }).select('id').single();

    try {
      const msgId = await enviarEmail({ to: central, subject, html, text });
      await db.from('notificaciones').update({ estado: 'enviada', proveedor_msg_id: msgId, enviada_en: new Date().toISOString() }).eq('id', notif.id);
      await db.from('alertas').update({ estado: 'notificada' }).eq('id', al.id);
      enviadas++;
    } catch (e) {
      await db.from('notificaciones').update({ estado: 'fallida', error: e.message }).eq('id', notif.id);
      fallidas++;
      console.log(`   ❌ ${p.radicado}: ${e.message}`);
    }
  }
  console.log(`\n===== RESUMEN =====\nEnviadas: ${enviadas}  Fallidas: ${fallidas}`);
}

// ---------------------------------------------------------------------
(DRY ? correrDryRun() : correrProduccion()).catch(e => { console.error(e); process.exit(1); });
