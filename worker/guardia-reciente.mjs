// =====================================================================
//  guardia-reciente.mjs · Evita corridas de rastreo repetidas
//  El cron de GitHub se atrasa horas; si el disparo puntual (workflow_dispatch)
//  ya corrió hace poco, el cron tardío no debe repetir la revisión completa.
//  Escribe omitir=true|false en $GITHUB_OUTPUT.  Uso: node guardia-reciente.mjs [horas]
// =====================================================================
import { createClient } from '@supabase/supabase-js';
import { appendFileSync } from 'node:fs';

const horas = Number(process.argv[2] || 6);
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const { data: ultima } = await db.from('rastreo_runs').select('iniciado_en, estado')
  .order('iniciado_en', { ascending: false }).limit(1).maybeSingle();
const hace = ultima ? (Date.now() - new Date(ultima.iniciado_en)) / 3600000 : Infinity;
const omitir = hace < horas;
console.log(omitir ? `Ya hubo una revisión hace ${hace.toFixed(1)} h (< ${horas} h): se omite este disparo.` : 'Hace falta revisar: se continúa.');
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `omitir=${omitir}\n`);
