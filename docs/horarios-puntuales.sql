-- =====================================================================
--  Horarios PUNTUALES con Supabase (pg_cron + pg_net)
--
--  Por qué: el cron de GitHub Actions llega con 4-6 horas de atraso en este
--  repositorio (el informe de las 7 p. m. salía pasada la medianoche y el
--  recordatorio "cada 30 min" corre ~5 veces al día). pg_cron de Supabase sí
--  es puntual, y le pide a GitHub que corra el workflow en ese instante
--  (workflow_dispatch no se atrasa).
--
--  Pasos (una sola vez, en Supabase → SQL Editor):
--   1. En GitHub: Settings → Developer settings → Personal access tokens →
--      Fine-grained → repo infoadmilac-design/rastreo-judicial → permiso
--      "Actions: Read and write". Copia el token.
--   2. Ejecuta el BLOQUE A cambiando PEGA_AQUI_EL_TOKEN (solo ese texto).
--   3. Ejecuta el BLOQUE B.
--  Horas en UTC (Colombia = UTC-5).
-- =====================================================================

-- ---------- BLOQUE A: extensiones, token guardado en Vault y función ----------
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('PEGA_AQUI_EL_TOKEN', 'github_pat');

create or replace function disparar_workflow(wf text, inputs jsonb default '{}'::jsonb)
returns void language plpgsql security definer as $$
declare tok text;
begin
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'github_pat';
  perform net.http_post(
    url := 'https://api.github.com/repos/infoadmilac-design/rastreo-judicial/actions/workflows/' || wf || '/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || tok,
      'Accept', 'application/vnd.github+json',
      'User-Agent', 'supabase-pg-cron',
      'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'main', 'inputs', inputs));
end $$;

-- ---------- BLOQUE B: horarios ----------
-- Revisión de procesos: 7:07 a. m. y 12:37 p. m. (Colombia)
select cron.schedule('rastreo-manana',  '7 12 * * *',  $$ select disparar_workflow('rastreo.yml') $$);
select cron.schedule('rastreo-mediodia', '37 17 * * *', $$ select disparar_workflow('rastreo.yml') $$);
-- Informe diario 6:00 p. m. (todos los días) y semanal viernes 6:30 p. m.
select cron.schedule('informe-diario',  '0 23 * * *',  $$ select disparar_workflow('informe.yml', '{"tipo":"diario"}') $$);
select cron.schedule('informe-semanal', '30 23 * * 5', $$ select disparar_workflow('informe.yml', '{"tipo":"semanal"}') $$);
-- Recordatorios de audiencias/vencimientos: cada 30 minutos
select cron.schedule('recordatorios',   '*/30 * * * *', $$ select disparar_workflow('recordatorios.yml') $$);

-- Para ver/quitar:  select * from cron.job;   select cron.unschedule('informe-diario');
