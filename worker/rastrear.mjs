// =====================================================================
//  rastrear.mjs  ·  Motor de rastreo (Fase 2)
//  Consulta el API CPNU, detecta actuaciones nuevas y genera alertas.
//
//  Modos:
//    node rastrear.mjs --dry-run [--limit N]   → sin base de datos, estado local
//    node rastrear.mjs                          → contra Supabase (usa .env)
//
//  Detección de cambios: compara fechaUltimaActuacion; si cambió, trae
//  actuaciones y marca como nuevas las de consActuacion mayor a la guardada.
// =====================================================================
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { consultarPorRadicado, obtenerActuaciones, sleep } from './cpnu.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1], 10) : Infinity; })();
// El servidor de la Rama bloquea (HTTP 403) si se le consulta muy rápido en ráfaga.
// Con ~163 procesos, 500ms nos bloqueó tras ~71 (2026-07-30). Ajuste conservador:
// pausa corta entre procesos + tandas pequeñas con respiro de 3 a 5 minutos.
const PAUSA_MS = 5000;              // ritmo entre procesos (5s)
const RESPIRO_CADA = 10;            // cada N procesos, pausa larga
const RESPIRO_MIN_MS = 180000;      // 3 min
const RESPIRO_MAX_MS = 300000;      // 5 min
const respiroAleatorio = () => RESPIRO_MIN_MS + Math.floor(Math.random() * (RESPIRO_MAX_MS - RESPIRO_MIN_MS));
const SOLO_PENDIENTES = args.includes('--solo-pendientes'); // saltar los que ya tienen estado guardado

// ---------------------------------------------------------------------
//  Núcleo común: procesa un radicado y devuelve las actuaciones nuevas
// ---------------------------------------------------------------------
async function revisarProceso({ radicado, idProceso, consGuardada, fechaGuardada }) {
  const info = await consultarPorRadicado(radicado);
  if (!info) return { ok: false, motivo: 'no encontrado', radicado };

  // Check barato: si la fecha de última actuación no cambió, no traemos el detalle
  const cambioProbable = !fechaGuardada || info.fechaUltimaActuacion !== fechaGuardada;
  let nuevas = [];
  let actuaciones = null;
  if (cambioProbable) {
    actuaciones = await obtenerActuaciones(info.idProceso);
    const tope = consGuardada ?? -1;
    nuevas = actuaciones.filter(a => (a.consActuacion ?? 0) > tope);
  }
  const maxCons = actuaciones ? Math.max(consGuardada ?? 0, ...actuaciones.map(a => a.consActuacion ?? 0)) : consGuardada;
  return {
    ok: true, radicado, idProceso: info.idProceso, despacho: info.despacho,
    fechaUltimaActuacion: info.fechaUltimaActuacion, maxCons,
    nuevas, actuaciones, cambioProbable,
  };
}

// =====================================================================
//  MODO DRY-RUN  (sin base de datos)
// =====================================================================
async function correrDryRun() {
  const procPath = join(__dirname, '..', 'migration', 'output', 'normalized', 'procesos.json');
  const estadoPath = join(__dirname, '.estado-dryrun.json');
  const procesos = JSON.parse(await readFile(procPath, 'utf8'))
    .filter(p => p.api_trackable && p.radicado);
  let estado = {};
  try { estado = JSON.parse(await readFile(estadoPath, 'utf8')); } catch { /* primera corrida */ }

  let objetivo = procesos;
  if (SOLO_PENDIENTES) objetivo = objetivo.filter(p => !estado[p.radicado]);
  objetivo = objetivo.slice(0, LIMIT);
  console.log(`\n🔎 DRY-RUN · ${objetivo.length}/${procesos.length} procesos rastreables${SOLO_PENDIENTES ? ' (solo pendientes)' : ''}\n`);

  let conCambios = 0, totalNuevas = 0, errores = 0;
  for (let i = 0; i < objetivo.length; i++) {
    const p = objetivo[i];
    const prev = estado[p.radicado] || {};
    try {
      const r = await revisarProceso({
        radicado: p.radicado, idProceso: prev.idProceso,
        consGuardada: prev.maxCons, fechaGuardada: prev.fechaUltimaActuacion,
      });
      if (!r.ok) { console.log(`   ⚠️  ${p.radicado}  (${r.motivo})`); errores++; continue; }

      const esPrimera = prev.maxCons === undefined;
      if (esPrimera) {
        console.log(`   • ${p.radicado}  base registrada (${r.actuaciones?.length ?? 0} actuaciones) — ${r.despacho?.slice(0, 45) || ''}`);
      } else if (r.nuevas.length > 0) {
        conCambios++; totalNuevas += r.nuevas.length;
        console.log(`   🔔 ${p.radicado}  ${r.nuevas.length} NUEVA(S):`);
        for (const a of r.nuevas.slice(0, 3))
          console.log(`        [${a.fechaActuacion}] ${a.tipo}: ${a.anotacion.slice(0, 80)}`);
      } else {
        console.log(`   ✓ ${p.radicado}  sin cambios`);
      }
      estado[p.radicado] = { idProceso: r.idProceso, maxCons: r.maxCons, fechaUltimaActuacion: r.fechaUltimaActuacion };
    } catch (e) {
      console.log(`   ❌ ${p.radicado}  ${e.message}`); errores++;
    }
    // Guarda avance por si el servidor corta a mitad de camino
    await writeFile(estadoPath, JSON.stringify(estado, null, 2));
    await sleep(PAUSA_MS);
    // Respiro largo (3-5 min) cada N procesos para no gatillar el bloqueo anti-robots
    if ((i + 1) % RESPIRO_CADA === 0 && i + 1 < objetivo.length) {
      const ms = respiroAleatorio();
      console.log(`   … respiro de ${Math.round(ms / 1000)}s (${i + 1}/${objetivo.length})`);
      await sleep(ms);
    }
  }
  await writeFile(estadoPath, JSON.stringify(estado, null, 2));
  console.log(`\n===== RESUMEN =====`);
  console.log(`Procesos con novedades : ${conCambios}`);
  console.log(`Actuaciones nuevas     : ${totalNuevas}`);
  console.log(`Errores/no encontrados : ${errores}`);
  console.log(`Estado guardado en     : worker/.estado-dryrun.json`);
  console.log(`(La próxima corrida solo alertará lo que aparezca DESPUÉS de esta base.)`);
}

// =====================================================================
//  MODO SUPABASE  (producción)
// =====================================================================
async function correrSupabase() {
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.error('Falta SUPABASE_URL / SUPABASE_SERVICE_KEY en .env'); process.exit(1); }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: procesos, error } = await db
    .from('procesos').select('id, radicado, id_cpnu, fecha_ultima_actuacion, hash_ultima_actuacion')
    .eq('api_trackable', true).not('radicado', 'is', null).limit(LIMIT === Infinity ? 5000 : LIMIT);
  if (error) throw error;
  console.log(`\n🔎 Rastreando ${procesos.length} procesos contra el API…\n`);

  let conCambios = 0, totalNuevas = 0, errores = 0;
  for (const p of procesos) {
    try {
      // consGuardada = mayor consActuacion ya almacenado para este proceso
      const { data: ult } = await db.from('actuaciones')
        .select('cons_actuacion').eq('proceso_id', p.id)
        .order('cons_actuacion', { ascending: false }).limit(1).maybeSingle();
      const consGuardada = ult?.cons_actuacion ?? -1;
      const fechaGuardada = p.fecha_ultima_actuacion || null;

      const r = await revisarProceso({ radicado: p.radicado, idProceso: p.id_cpnu, consGuardada, fechaGuardada });
      if (!r.ok) { errores++; continue; }

      if (r.nuevas?.length) {
        // Insertar actuaciones nuevas (idempotente por idRegActuacion)
        const rows = r.nuevas.map(a => ({
          proceso_id: p.id, id_reg_actuacion: a.idRegActuacion, cons_actuacion: a.consActuacion,
          fecha_actuacion: a.fechaActuacion, fecha_registro: a.fechaRegistro,
          tipo: a.tipo, anotacion: a.anotacion, con_documentos: a.conDocumentos, es_nueva: true,
        }));
        const { data: ins } = await db.from('actuaciones')
          .upsert(rows, { onConflict: 'id_reg_actuacion', ignoreDuplicates: true }).select('id, anotacion, fecha_actuacion');
        // Crear una alerta por cada actuación nueva insertada
        if (ins?.length) {
          conCambios++; totalNuevas += ins.length;
          await db.from('alertas').insert(ins.map(a => ({
            proceso_id: p.id, actuacion_id: a.id, tipo: 'nueva_actuacion',
            titulo: `Nueva actuación en ${p.radicado}`, detalle: a.anotacion?.slice(0, 500), estado: 'pendiente',
          })));
        }
      }
      // Actualizar cache del proceso
      await db.from('procesos').update({
        id_cpnu: r.idProceso, fecha_ultima_actuacion: r.fechaUltimaActuacion,
        ultima_actuacion_texto: r.nuevas?.[0]?.anotacion?.slice(0, 500) ?? undefined,
        ultimo_check_en: new Date().toISOString(),
      }).eq('id', p.id);
    } catch (e) { console.log(`   ❌ ${p.radicado} ${e.message}`); errores++; }
    await sleep(PAUSA_MS);
  }
  console.log(`\n===== RESUMEN =====`);
  console.log(`Procesos con novedades : ${conCambios}`);
  console.log(`Actuaciones nuevas     : ${totalNuevas}  (alertas creadas, pendientes de notificar)`);
  console.log(`Errores                : ${errores}`);
}

// ---------------------------------------------------------------------
(DRY ? correrDryRun() : correrSupabase()).catch(e => { console.error(e); process.exit(1); });
