// =====================================================================
//  recordatorios.mjs  ·  Recordatorios de audiencias y vencimientos
//  Revisa la tabla "audiencias" y crea una alerta (tipo audiencia_proxima)
//  en dos momentos por evento: 1 día antes y 1 hora antes (si el evento
//  tiene hora). No duplica — cada momento se recuerda una sola vez.
//  Pensado para correr cada ~30 min (ver .github/workflows/recordatorios.yml).
//
//  Uso:  node --env-file=.env recordatorios.mjs
// =====================================================================
const { createClient } = await import('@supabase/supabase-js');
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('Falta SUPABASE_URL / SUPABASE_SERVICE_KEY en .env'); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });

const ahora = new Date();
const hoy = ahora.toISOString().slice(0, 10);
const mañana = new Date(ahora.getTime() + 86400000).toISOString().slice(0, 10);
// Ventana ancha (2 días) para traer todo lo candidato; el filtro fino de "1 día antes"
// y "1 hora antes" se hace en JS con la fecha+hora exactas de cada evento.
const limiteAncho = new Date(ahora.getTime() + 2 * 86400000).toISOString().slice(0, 10);

const { data: audiencias, error } = await db.from('audiencias')
  .select('id, proceso_id, fecha, hora, descripcion, lugar, clientes(nombre), procesos(radicado)')
  .gte('fecha', hoy).lte('fecha', limiteAncho);
if (error) throw error;

const { data: existentes } = await db.from('alertas')
  .select('audiencia_id, titulo').not('audiencia_id', 'is', null);
const yaAvisado = (audienciaId, etiqueta) =>
  (existentes || []).some(a => a.audiencia_id === audienciaId && a.titulo?.includes(etiqueta));

async function crearRecordatorio(a, etiqueta) {
  const cliente = a.clientes?.nombre ? ` · ${a.clientes.nombre}` : '';
  const radicado = a.procesos?.radicado ? ` (${a.procesos.radicado})` : '';
  const titulo = `${etiqueta} ${a.descripcion || 'evento'} el ${a.fecha}${a.hora ? ' ' + a.hora : ''}`;
  const detalle = `${a.descripcion || ''}${cliente}${radicado}${a.lugar ? ' · ' + a.lugar : ''}`.trim();
  const { error: errIns } = await db.from('alertas').insert({
    proceso_id: a.proceso_id || null, audiencia_id: a.id, tipo: 'audiencia_proxima',
    titulo, detalle, estado: 'pendiente',
  });
  if (errIns) console.log(`  ❌ ${titulo}: ${errIns.message}`);
  else console.log(`  🔔 ${titulo}`);
  return !errIns;
}

let creados = 0;
for (const a of audiencias) {
  // 1 día antes: el evento es mañana (no depende de la hora).
  if (a.fecha === mañana && !yaAvisado(a.id, '[1 día antes]')) {
    if (await crearRecordatorio(a, '[1 día antes]')) creados++;
  }
  // 1 hora antes: solo si el evento tiene hora. Ventana de 45-75 min para
  // tolerar que este script corre cada ~30 min, no exactamente a la hora.
  if (a.hora && !yaAvisado(a.id, '[1 hora antes]')) {
    const [h, m] = a.hora.split(':').map(Number);
    const momentoEvento = new Date(`${a.fecha}T${String(h).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}:00`);
    const minutosFaltan = (momentoEvento - ahora) / 60000;
    if (minutosFaltan >= 45 && minutosFaltan <= 75) {
      if (await crearRecordatorio(a, '[1 hora antes]')) creados++;
    }
  }
}
console.log(`\n===== RESUMEN =====\nEventos revisados   : ${audiencias.length}\nRecordatorios nuevos: ${creados}`);
