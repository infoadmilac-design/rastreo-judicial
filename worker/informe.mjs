// =====================================================================
//  informe.mjs · Informe diario (6:00 p. m.) y semanal (viernes 6:30 p. m.)
//  Junta los procesos que tuvieron movimiento en el período (alertas:
//  nueva_actuacion, audiencia_proxima, vencimiento_termino), arma un PDF con
//  la plantilla de worker/informe-pdf.mjs, lo guarda en la tabla "informes"
//  (respaldo/consulta desde el dashboard) y lo manda por WhatsApp como
//  ARCHIVO ADJUNTO real (plantilla "informe_procesos", encabezado de
//  documento) — no depende de que el dashboard (Render gratis) esté despierto.
//
//  Uso:  node informe.mjs [diario|semanal|auto]
//    diario  → informe del día (hoy, hora Colombia)
//    semanal → informe de lunes a hoy
//    auto    → diario, y además semanal si hoy es viernes (por defecto; lo
//              usa el disparo manual)
//  Variable ESPERAR_HASTA="18:00" (hora Colombia): el workflow arranca unos
//  minutos antes y el script espera a esa hora exacta para enviar, así el
//  informe llega a la hora aunque GitHub Actions adelante el disparo.
//
//  Usa las mismas variables de entorno que notify/whatsapp.mjs (WHATSAPP_TOKEN,
//  WHATSAPP_PHONE_ID, WHATSAPP_CENTRAL, WHATSAPP_LANG).
// =====================================================================
import { createClient } from '@supabase/supabase-js';
import { subirMedia, enviarPlantillaConDocumento } from '../notify/whatsapp.mjs';
import { generarPDF } from './informe-pdf.mjs';

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('Falta SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });
const waCentral = process.env.WHATSAPP_CENTRAL;
const MODO = (process.argv[2] || 'auto').toLowerCase();
const ESPERAR_HASTA = process.env.ESPERAR_HASTA || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- fechas en hora Colombia (UTC-5, sin horario de verano) ----------
function ahoraBogota() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return { fecha: `${g('year')}-${g('month')}-${g('day')}`, min: Number(g('hour')) * 60 + Number(g('minute')) };
}
// Si GitHub retrasó tanto el disparo que ya pasó la medianoche, el informe sigue siendo el del día anterior.
function fechaDelInforme() {
  const { fecha, min } = ahoraBogota();
  return min < 6 * 60 ? sumarDias(fecha, -1) : fecha;
}
function sumarDias(fechaISO, n) {
  const d = new Date(fechaISO + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const diaSemana = fechaISO => new Date(fechaISO + 'T12:00:00Z').getUTCDay(); // 0=domingo … 5=viernes
const fmtCorta = f => f.split('-').reverse().join('/');
const fmtLarga = f => new Date(f + 'T12:00:00Z').toLocaleDateString('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtDiaCorto = f => { const t = new Date(f + 'T12:00:00Z').toLocaleDateString('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric' }); return t.charAt(0).toUpperCase() + t.slice(1); };
const horaBogota = iso => new Date(iso).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit' });
const fechaBogota = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(iso));

async function esperarHasta(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const objetivo = h * 60 + m;
  const inicio = Date.now();
  while (true) {
    const { min } = ahoraBogota();
    if (min >= objetivo || min < 6 * 60) return;            // ya es la hora (o el disparo llegó muy tarde): enviar
    if (Date.now() - inicio > 50 * 60000) return;          // tope de seguridad
    console.log(`Esperando hasta las ${hhmm} (hora Colombia)…`);
    await sleep(Math.min(30000, (objetivo - min) * 60000));
  }
}

// ---------- datos del período ----------
const sinEnlaces = s => String(s || '').replace(/\s*(Boletín completo|Documento):\s*https?:\/\/\S+/gi, '').replace(/https?:\/\/\S+/g, '').trim();
const recorte = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

async function datosRango(desde, hasta) {
  const desdeTs = `${desde}T00:00:00-05:00`;
  const hastaTs = `${sumarDias(hasta, 1)}T00:00:00-05:00`;

  const { data: alertas, error: errA } = await db.from('alertas')
    .select(`id, tipo, titulo, detalle, creado_en,
      procesos(id, radicado, origen_id_raw, demandado, demandante, clientes(nombre)),
      actuaciones(fecha_actuacion, anotacion),
      audiencias(fecha, hora, descripcion, clientes(nombre))`)
    .gte('creado_en', desdeTs).lt('creado_en', hastaTs)
    .order('creado_en', { ascending: true });
  if (errA) throw errA;

  const { data: runs, error: errR } = await db.from('rastreo_runs')
    .select('estado, total, procesados, con_cambios, errores, iniciado_en, terminado_en')
    .gte('iniciado_en', desdeTs).lt('iniciado_en', hastaTs)
    .order('iniciado_en', { ascending: true });
  if (errR) throw errR;

  const { data: ultima } = await db.from('rastreo_runs')
    .select('estado, total, procesados, errores, iniciado_en, terminado_en')
    .order('iniciado_en', { ascending: false }).limit(1).maybeSingle();

  return { alertas: alertas || [], runs: runs || [], ultima };
}

// Una fila por proceso (con todos sus movimientos del período) para la tabla principal.
function armarFilas(alertas) {
  const porProceso = new Map();
  for (const a of alertas) {
    if (a.tipo !== 'nueva_actuacion') continue;
    const p = a.procesos;
    const id = p?.radicado || p?.origen_id_raw || a.titulo || a.id;
    const fecha = a.actuaciones?.fecha_actuacion || fechaBogota(a.creado_en);
    const texto = sinEnlaces(a.actuaciones?.anotacion || a.detalle || a.titulo);
    if (!porProceso.has(id)) porProceso.set(id, {
      id, cliente: p?.clientes?.nombre || '-', demandado: p?.demandado || p?.demandante || '-', movs: [],
    });
    porProceso.get(id).movs.push({ fecha, texto, creado: a.creado_en });
  }
  const filas = [...porProceso.values()].map(f => {
    f.movs.sort((x, y) => (y.fecha + y.creado).localeCompare(x.fecha + x.creado));
    const unico = f.movs.length === 1;
    const texto = unico
      ? recorte(f.movs[0].texto, 420)
      : f.movs.slice(0, 3).map(m => `• ${fmtCorta(m.fecha).slice(0, 5)}: ${recorte(m.texto, 160)}`).join('\n')
        + (f.movs.length > 3 ? `\n+ ${f.movs.length - 3} movimiento(s) más` : '');
    return { id: f.id, cliente: f.cliente, demandado: f.demandado, fecha: fmtCorta(f.movs[0].fecha), fechaISO: f.movs[0].fecha, texto, n: f.movs.length };
  });
  filas.sort((a, b) => b.fechaISO.localeCompare(a.fechaISO) || a.id.localeCompare(b.id));
  return filas;
}

function armarAudiencias(alertas) {
  return alertas.filter(a => a.tipo !== 'nueva_actuacion').map(a => ({
    fecha: a.audiencias?.fecha ? fmtCorta(a.audiencias.fecha) : fmtCorta(fechaBogota(a.creado_en)),
    hora: a.audiencias?.hora || '-',
    cliente: a.audiencias?.clientes?.nombre || a.procesos?.clientes?.nombre || '-',
    descripcion: recorte(sinEnlaces(a.audiencias?.descripcion || a.detalle || a.titulo), 260),
  }));
}

function textoRevision(ultima) {
  if (!ultima) return null;
  if (ultima.estado === 'corriendo')
    return `Revisión en curso al generar este informe: ${ultima.procesados}/${ultima.total} procesos revisados. Lo que se detecte después irá en el siguiente informe.`;
  const hora = ultima.terminado_en ? horaBogota(ultima.terminado_en) : null;
  return `Última revisión ${ultima.estado === 'completado' ? 'completada' : 'interrumpida'}${hora ? ` a las ${hora}` : ''}: ${ultima.procesados}/${ultima.total} procesos revisados, ${ultima.errores} sin respuesta del portal.`;
}

// ---------- generar, guardar y enviar ----------
async function generarYEnviar(tipo, desde, hasta) {
  const { alertas, runs, ultima } = await datosRango(desde, hasta);
  const filas = armarFilas(alertas);
  const audiencias = armarAudiencias(alertas);
  const movimientos = filas.reduce((s, f) => s + f.n, 0);
  const revisiones = runs.reduce((s, r) => s + (r.procesados || 0), 0);
  const errores = runs.reduce((s, r) => s + (r.errores || 0), 0);
  const resumen = { corridas: runs.length, procesados: revisiones, conMovimiento: filas.length, errores };

  let porDia = null;
  if (tipo === 'semanal') {
    porDia = [];
    for (let f = desde; f <= hasta; f = sumarDias(f, 1)) {
      const delDia = alertas.filter(a => a.tipo === 'nueva_actuacion' && fechaBogota(a.creado_en) === f);
      porDia.push({
        dia: fmtDiaCorto(f),
        procesos: new Set(delDia.map(a => a.procesos?.radicado || a.procesos?.origen_id_raw || a.id)).size,
        movimientos: delDia.length,
      });
    }
  }

  const pdfBuffer = await generarPDF({
    tipo,
    titulo: tipo === 'semanal' ? 'INFORME SEMANAL' : 'INFORME DIARIO',
    subtitulo: tipo === 'semanal' ? `Semana del ${fmtCorta(desde)} al ${fmtCorta(hasta)}` : fmtLarga(hasta),
    kpis: [
      { valor: filas.length, etiqueta: 'Procesos con movimiento' },
      { valor: movimientos, etiqueta: 'Movimientos registrados' },
      { valor: revisiones, etiqueta: 'Revisiones realizadas' },
      { valor: errores, etiqueta: 'Sin respuesta del portal' },
    ],
    estadoRevision: textoRevision(ultima),
    filas, audiencias, porDia,
  });

  const { data: row, error } = await db.from('informes')
    .insert({ tipo, fecha_desde: desde, fecha_hasta: hasta, pdf_base64: pdfBuffer.toString('base64'), resumen })
    .select('id').single();
  if (error) throw error;

  console.log(`Informe ${tipo} (${desde} a ${hasta}): ${filas.length} proceso(s) con movimiento, ${movimientos} movimiento(s), ${revisiones} revisiones, ${errores} errores (id ${row.id})`);

  if (!waCentral) { console.log('Falta WHATSAPP_CENTRAL — informe generado pero no enviado.'); return; }

  const rango = desde === hasta ? desde : `${desde} al ${hasta}`;
  const filename = `informe-${tipo}-${desde}${desde === hasta ? '' : `-a-${hasta}`}.pdf`;
  try {
    // El archivo se sube directo a los servidores de WhatsApp/Meta.
    const mediaId = await subirMedia({ buffer: pdfBuffer, filename, mimeType: 'application/pdf' });
    await enviarPlantillaConDocumento({
      to: waCentral, mediaId, filename,
      params: [tipo === 'semanal' ? 'informe semanal' : 'informe diario', rango, String(filas.length), String(revisiones)],
    });
    console.log(`✅ Informe ${tipo} enviado por WhatsApp como documento adjunto.`);
  } catch (e) {
    console.error(`❌ No se pudo enviar el informe ${tipo} como documento:`, e.message);
    process.exitCode = 1;
  }
}

// ---------- main ----------
const hoy = fechaDelInforme();
if (ESPERAR_HASTA) await esperarHasta(ESPERAR_HASTA);

if (MODO === 'diario' || MODO === 'auto') await generarYEnviar('diario', hoy, hoy);
if (MODO === 'semanal' || (MODO === 'auto' && diaSemana(hoy) === 5)) {
  const lunes = sumarDias(hoy, -((diaSemana(hoy) + 6) % 7));   // lunes de la semana de "hoy"
  await generarYEnviar('semanal', lunes, hoy);
}
