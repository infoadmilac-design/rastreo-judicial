// =====================================================================
//  resumen-corrida.mjs  ·  Envía por WhatsApp un informe al terminar
//  cada corrida de rastrear.mjs: procesados, cambios, errores, duración
//  y próximas audiencias/vencimientos (próximos 3 días).
//
//  Uso:  node --env-file=.env resumen-corrida.mjs
// =====================================================================
const { createClient } = await import('@supabase/supabase-js');
const { enviarPlantilla } = await import('../notify/whatsapp.mjs');

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
const waCentral = process.env.WHATSAPP_CENTRAL;
if (!url || !key) { console.error('Falta SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
if (!waCentral) { console.log('Falta WHATSAPP_CENTRAL — no se envía el informe de la corrida.'); process.exit(0); }
const db = createClient(url, key, { auth: { persistSession: false } });
const dashboardUrl = process.env.DASHBOARD_URL || 'https://rastreo-judicial.onrender.com';

const { data: run, error } = await db.from('rastreo_runs')
  .select('*').order('iniciado_en', { ascending: false }).limit(1).maybeSingle();
if (error) throw error;
if (!run) { console.log('No hay ninguna corrida registrada todavía.'); process.exit(0); }

const duracionMin = run.terminado_en
  ? Math.round((new Date(run.terminado_en) - new Date(run.iniciado_en)) / 60000)
  : null;

const hoy = new Date().toISOString().slice(0, 10);
const limite = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
const { count: proximas } = await db.from('audiencias').select('*', { count: 'exact', head: true })
  .gte('fecha', hoy).lte('fecha', limite);

const estadoTxt = run.estado === 'completado' ? '✅ Completada' : (run.estado === 'error' ? '❌ Se interrumpió' : '⏳ En curso');
const linea2 = `${run.procesados}/${run.total} procesados${duracionMin != null ? ` en ${duracionMin} min` : ''}`;
const linea3 = `${run.con_cambios} con cambios · ${run.errores} error(es)` +
  (proximas ? ` · ${proximas} audiencia(s)/vencimiento(s) en los próximos 3 días` : '') +
  ` · Ver dashboard: ${dashboardUrl}`;

console.log(`Enviando informe de corrida: ${estadoTxt} — ${linea2} — ${linea3}`);
try {
  const msgId = await enviarPlantilla({ to: waCentral, params: [`📊 ${estadoTxt}`, linea2, linea3] });
  console.log('✅ Informe enviado. ID:', msgId);
} catch (e) {
  console.error('❌ No se pudo enviar el informe:', e.message);
}
