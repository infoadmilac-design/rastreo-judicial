// =====================================================================
//  informe.mjs · Informe diario (todos los días) y semanal (viernes)
//  Junta los cambios de procesos del período (alertas: nueva_actuacion,
//  audiencia_proxima, vencimiento_termino), arma un PDF, lo guarda en la
//  tabla "informes" y manda un WhatsApp con el enlace para descargarlo
//  (la plantilla aprobada de Meta solo soporta texto, no adjuntos —
//  ver notas en README/INSTRUCCIONES sobre cómo pasar a PDF real).
//
//  Uso:  node --env-file=.env informe.mjs
// =====================================================================
import { createClient } from '@supabase/supabase-js';
import PDFDocument from 'pdfkit';
import { enviarPlantilla } from '../notify/whatsapp.mjs';

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('Falta SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });
const waCentral = process.env.WHATSAPP_CENTRAL;
const dashboardUrl = process.env.DASHBOARD_URL || 'https://rastreo-judicial.onrender.com';

// ---------- fechas en hora Colombia (UTC-5, sin horario de verano) ----------
const hoyBogota = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const diaSemanaBogota = () =>
  new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', weekday: 'long' }).format(new Date()).toLowerCase();
function sumarDias(fechaISO, n) {
  const d = new Date(fechaISO + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- datos del período ----------
async function datosRango(desde, hasta) {
  const desdeTs = `${desde}T00:00:00-05:00`;
  const hastaTs = `${sumarDias(hasta, 1)}T00:00:00-05:00`;

  const { data: alertas, error: errA } = await db.from('alertas')
    .select(`id, tipo, titulo, detalle, creado_en,
      procesos(radicado, origen_id_raw, juzgado, despacho, clientes(nombre)),
      audiencias(fecha, hora, descripcion, clientes(nombre))`)
    .gte('creado_en', desdeTs).lt('creado_en', hastaTs)
    .order('creado_en', { ascending: true });
  if (errA) throw errA;

  const { data: runs, error: errR } = await db.from('rastreo_runs')
    .select('estado, total, procesados, con_cambios, errores, iniciado_en, terminado_en')
    .gte('iniciado_en', desdeTs).lt('iniciado_en', hastaTs)
    .order('iniciado_en', { ascending: true });
  if (errR) throw errR;

  return { alertas: alertas || [], runs: runs || [] };
}

// ---------- armar el PDF ----------
function generarPDF({ tipo, desde, hasta, alertas, runs }) {
  return new Promise(resolve => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const titulo = tipo === 'semanal' ? 'Informe semanal' : 'Informe diario';
    doc.fontSize(18).font('Helvetica-Bold').text(`${titulo} — Rastreo de procesos judiciales`);
    doc.fontSize(10).font('Helvetica').fillColor('#555')
      .text(desde === hasta ? `Fecha: ${desde}` : `Del ${desde} al ${hasta}`);
    doc.moveDown();

    const procesados = runs.reduce((s, r) => s + (r.procesados || 0), 0);
    const errores = runs.reduce((s, r) => s + (r.errores || 0), 0);
    const idProc = a => a.procesos?.radicado || a.procesos?.origen_id_raw || (a.audiencias ? `audiencia-${a.id}` : a.id);
    const procesosUnicos = new Set(alertas.map(idProc));

    doc.fillColor('black').fontSize(13).font('Helvetica-Bold').text('Resumen');
    doc.fontSize(10).font('Helvetica').fillColor('black');
    doc.text(`•  ${runs.length} corrida(s) automática(s) de rastreo en el período`);
    doc.text(`•  ${procesados} revisión(es) de proceso realizadas (vía API oficial)`);
    doc.text(`•  ${procesosUnicos.size} proceso(s)/evento(s) distinto(s) con movimiento`);
    doc.text(`•  ${errores} error(es) durante el rastreo`);
    doc.moveDown();

    doc.fontSize(13).font('Helvetica-Bold').text('Procesos con movimiento');
    doc.moveDown(0.3);
    if (!alertas.length) {
      doc.fontSize(10).font('Helvetica').fillColor('#555').text('No se detectaron cambios en este período.');
    } else {
      for (const a of alertas) {
        const p = a.procesos, aud = a.audiencias;
        const idTxt = p?.radicado || p?.origen_id_raw || (aud ? 'Audiencia/Vencimiento' : '—');
        const cliente = p?.clientes?.nombre || aud?.clientes?.nombre || '—';
        const ubicacion = p?.juzgado || p?.despacho || '';
        const fecha = new Date(a.creado_en).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'short' });

        if (doc.y > 740) doc.addPage();
        doc.fontSize(10).font('Helvetica-Bold').fillColor('black').text(`${idTxt} — ${cliente}`);
        doc.font('Helvetica').fillColor('#333').text(`${ubicacion ? ubicacion + ' · ' : ''}${fecha} · ${a.tipo}`);
        doc.fillColor('black').text((a.titulo || '') + (a.detalle ? `: ${a.detalle}` : ''), { width: 500 });
        doc.moveDown(0.6);
      }
    }
    doc.end();
  });
}

// ---------- generar, guardar y enviar ----------
async function generarYEnviar(tipo, desde, hasta) {
  const { alertas, runs } = await datosRango(desde, hasta);
  const pdfBuffer = await generarPDF({ tipo, desde, hasta, alertas, runs });

  const idProc = a => a.procesos?.radicado || a.procesos?.origen_id_raw || (a.audiencias ? `audiencia-${a.id}` : a.id);
  const resumen = {
    corridas: runs.length,
    procesados: runs.reduce((s, r) => s + (r.procesados || 0), 0),
    conMovimiento: new Set(alertas.map(idProc)).size,
    errores: runs.reduce((s, r) => s + (r.errores || 0), 0),
  };

  const { data: row, error } = await db.from('informes')
    .insert({ tipo, fecha_desde: desde, fecha_hasta: hasta, pdf_base64: pdfBuffer.toString('base64'), resumen })
    .select('id').single();
  if (error) throw error;

  const link = `${dashboardUrl}/api/informes/${row.id}.pdf`;
  console.log(`Informe ${tipo} (${desde} a ${hasta}): ${resumen.conMovimiento} con movimiento, ${resumen.procesados} revisiones, ${resumen.errores} errores -> ${link}`);

  // "Despertar" el dashboard antes de mandar el enlace: en el plan gratis de
  // Render la instancia se duerme tras inactividad y la primera visita puede
  // tardar ~50s o fallar en el navegador de WhatsApp si no espera. Si sigue
  // sin responder tras el reintento, se manda el enlace de todos modos.
  for (let intento = 1; intento <= 2; intento++) {
    try {
      const r = await fetch(link, { signal: AbortSignal.timeout(60000) });
      if (r.ok) { console.log(`Dashboard despierto (intento ${intento}).`); break; }
      console.log(`Aviso: el dashboard respondió ${r.status} al despertarlo (intento ${intento}).`);
    } catch (e) {
      console.log(`Aviso: no se pudo despertar el dashboard (intento ${intento}): ${e.message}`);
    }
  }

  if (!waCentral) { console.log('Falta WHATSAPP_CENTRAL — informe generado pero no enviado.'); return; }
  const encabezado = tipo === 'semanal' ? '📅 Informe semanal' : '📋 Informe diario';
  const linea2 = `${resumen.conMovimiento} proceso(s)/evento(s) con movimiento · ${resumen.procesados} revisión(es)`;
  try {
    await enviarPlantilla({ to: waCentral, params: [encabezado, linea2, `Ver PDF: ${link}`] });
    console.log(`✅ Informe ${tipo} enviado por WhatsApp.`);
  } catch (e) {
    console.error(`❌ No se pudo enviar el informe ${tipo}:`, e.message);
  }
}

// ---------- main ----------
const hoy = hoyBogota();
await generarYEnviar('diario', hoy, hoy);

if (diaSemanaBogota() === 'viernes') {
  const lunes = sumarDias(hoy, -4);
  await generarYEnviar('semanal', lunes, hoy);
}
