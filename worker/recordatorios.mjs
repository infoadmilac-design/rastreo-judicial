// =====================================================================
//  recordatorios.mjs  ·  Recordatorios de audiencias y vencimientos
//  Revisa la tabla "audiencias" y crea una alerta (tipo audiencia_proxima)
//  para cada evento que caiga dentro de la ventana de aviso configurada
//  (configuracion.dias_aviso_vencimiento, por defecto 3 días), si todavía
//  no se le había creado una. notificar.mjs se encarga de enviarlas.
//
//  Uso:  node --env-file=.env recordatorios.mjs
// =====================================================================
const { createClient } = await import('@supabase/supabase-js');
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('Falta SUPABASE_URL / SUPABASE_SERVICE_KEY en .env'); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });

const { data: cfg } = await db.from('configuracion').select('valor').eq('clave', 'dias_aviso_vencimiento').maybeSingle();
const dias = parseInt(cfg?.valor, 10) || 3;

const hoy = new Date().toISOString().slice(0, 10);
const limite = new Date(Date.now() + dias * 86400000).toISOString().slice(0, 10);

const { data: audiencias, error } = await db.from('audiencias')
  .select('id, proceso_id, fecha, hora, descripcion, lugar, clientes(nombre), procesos(radicado)')
  .gte('fecha', hoy).lte('fecha', limite);
if (error) throw error;

console.log(`\n🗓️  ${audiencias.length} evento(s) entre hoy y ${limite} (ventana de ${dias} día(s))…\n`);

let creadas = 0, yaExistian = 0;
for (const a of audiencias) {
  const { data: existente } = await db.from('alertas').select('id').eq('audiencia_id', a.id).maybeSingle();
  if (existente) { yaExistian++; continue; }

  const cliente = a.clientes?.nombre ? ` · ${a.clientes.nombre}` : '';
  const radicado = a.procesos?.radicado ? ` (${a.procesos.radicado})` : '';
  const titulo = `Recordatorio: ${a.descripcion || 'evento'} el ${a.fecha}${a.hora ? ' ' + a.hora : ''}`;
  const detalle = `${a.descripcion || ''}${cliente}${radicado}${a.lugar ? ' · ' + a.lugar : ''}`.trim();

  const { error: errIns } = await db.from('alertas').insert({
    proceso_id: a.proceso_id || null, audiencia_id: a.id, tipo: 'audiencia_proxima',
    titulo, detalle, estado: 'pendiente',
  });
  if (errIns) { console.log(`  ❌ ${titulo}: ${errIns.message}`); continue; }
  console.log(`  🔔 ${titulo}`);
  creadas++;
}
console.log(`\n===== RESUMEN =====\nRecordatorios nuevos : ${creadas}\nYa existían          : ${yaExistian}`);
