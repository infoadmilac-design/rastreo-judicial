// =====================================================================
//  server.mjs  ·  Dashboard de control (Fase 4)
//  - Sin credenciales Supabase => MODO DEMO (lee migration/output/normalized)
//  - Con SUPABASE_URL + SUPABASE_SERVICE_KEY => MODO REAL con CRUD
//  Uso:  node server.mjs   (abre http://localhost:3000)
// =====================================================================
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { consultarPorRadicado, consultarPorNombre, obtenerActuaciones } from '../worker/cpnu.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HAS_DB = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);

// ---------------------------------------------------------------------
//  Capa de datos
// ---------------------------------------------------------------------
let db = null;
if (HAS_DB) {
  const { createClient } = await import('@supabase/supabase-js');
  db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

// --- MODO DEMO: cargar los JSON normalizados ---
let demo = null;
async function cargarDemo() {
  if (demo) return demo;
  const base = join(__dirname, '..', 'migration', 'output', 'normalized');
  const j = async f => JSON.parse(await readFile(join(base, f), 'utf8'));
  const [procesos, clientes, audiencias] = await Promise.all([j('procesos.json'), j('clientes.json'), j('audiencias.json')]);
  const cli = new Map(clientes.map(c => [c.id, c.nombre]));
  demo = {
    procesos: procesos.map(p => ({ ...p, cliente: cli.get(p.cliente_id) || null })),
    audiencias: audiencias.map(a => ({ ...a, cliente: cli.get(a.cliente_id) || null })),
    plantillas: PLANTILLAS_DEMO,
  };
  return demo;
}

const PLANTILLAS_DEMO = [
  { id: '1', nombre: 'Acuse de novedad al cliente', canal: 'email', cuerpo: 'Estimado/a {{cliente}}, le informamos que su proceso {{radicado}} registró una nueva actuación: {{actuacion}}. Quedamos atentos.' },
  { id: '2', nombre: 'Solicitud de expediente', canal: 'email', cuerpo: 'Comedidamente solicito copia del expediente del proceso {{radicado}} para revisión.' },
  { id: '3', nombre: 'Recordatorio de audiencia', canal: 'whatsapp', cuerpo: 'Recordatorio: audiencia del proceso {{radicado}} el {{fecha}}. Cliente: {{cliente}}.' },
];

// ---------------------------------------------------------------------
//  Consultas (abstraen demo vs real)
// ---------------------------------------------------------------------
const data = {
  async stats() {
    if (!HAS_DB) {
      const d = await cargarDemo();
      return {
        modo: 'demo', procesos: d.procesos.length,
        rastreables: d.procesos.filter(p => p.api_trackable).length,
        activos: d.procesos.filter(p => p.estado === 'activo').length,
        archivados: d.procesos.filter(p => p.estado === 'archivado').length,
        alertasPendientes: 0, audiencias: d.audiencias.length,
      };
    }
    const one = async (t, f) => (await db.from(t).select('*', { count: 'exact', head: true }).match(f || {})).count || 0;
    const rastreables = (await db.from('procesos').select('*', { count: 'exact', head: true }).eq('api_trackable', true)).count || 0;
    const revisados = (await db.from('procesos').select('*', { count: 'exact', head: true }).eq('api_trackable', true).not('ultimo_check_en', 'is', null)).count || 0;
    const { data: ult } = await db.from('procesos').select('ultimo_check_en').not('ultimo_check_en', 'is', null).order('ultimo_check_en', { ascending: false }).limit(1).maybeSingle();
    return {
      modo: 'real',
      procesos: await one('procesos'),
      rastreables,
      revisados,
      ultimaRevision: ult?.ultimo_check_en || null,
      activos: (await db.from('procesos').select('*', { count: 'exact', head: true }).eq('estado', 'activo')).count || 0,
      archivados: (await db.from('procesos').select('*', { count: 'exact', head: true }).eq('estado', 'archivado')).count || 0,
      alertasPendientes: (await db.from('alertas').select('*', { count: 'exact', head: true }).eq('estado', 'pendiente')).count || 0,
      audiencias: await one('audiencias'),
      clientes: await one('clientes'),
    };
  },

  async procesos(q = '', sort = '') {
    if (!HAS_DB) {
      const d = await cargarDemo();
      const s = q.toLowerCase();
      return d.procesos.filter(p =>
        !s || (p.radicado || '').includes(s) || (p.cliente || '').toLowerCase().includes(s) ||
        (p.origen_id_raw || '').toLowerCase().includes(s)).slice(0, 500);
    }
    let query = db.from('procesos').select('id, radicado, origen_id_raw, tipo_id, api_trackable, estado, sede, demandado, despacho, fecha_ultima_actuacion, ultima_actuacion_texto, ultimo_check_en, clientes(nombre), abogados(nombre)').limit(500);
    if (q) {
      // Buscar también por nombre de cliente (no solo radicado/ID), uniendo por cliente_id
      const { data: clientesMatch } = await db.from('clientes').select('id').ilike('nombre', `%${q}%`).limit(200);
      const idsCliente = (clientesMatch || []).map(c => c.id);
      const orParts = [`radicado.ilike.%${q}%`, `origen_id_raw.ilike.%${q}%`, `demandado.ilike.%${q}%`];
      if (idsCliente.length) orParts.push(`cliente_id.in.(${idsCliente.join(',')})`);
      query = query.or(orParts.join(','));
    }
    if (sort === 'recientes') query = query.order('ultimo_check_en', { ascending: false, nullsFirst: false });
    else if (sort === 'antiguos') query = query.order('ultimo_check_en', { ascending: true, nullsFirst: false });
    const { data: rows } = await query;
    return (rows || []).map(p => ({ ...p, cliente: p.clientes?.nombre, abogado: p.abogados?.nombre }));
  },

  // --- Progreso en vivo de la corrida de rastreo (para el widget de Inicio) ---
  async rastreoActual() {
    if (!HAS_DB) return null;
    const { data: run } = await db.from('rastreo_runs')
      .select('id, estado, total, procesados, con_cambios, errores, proceso_actual, iniciado_en, actualizado_en, terminado_en')
      .order('iniciado_en', { ascending: false }).limit(1).maybeSingle();
    return run || null;
  },

  async cambios() {
    if (!HAS_DB) return [];   // en demo aún no hay actuaciones detectadas
    const { data: rows } = await db.from('alertas')
      .select('id, tipo, titulo, detalle, estado, creado_en, procesos(radicado, clientes(nombre)), actuaciones(con_documentos)')
      .order('creado_en', { ascending: false }).limit(200);
    return (rows || []).map(a => ({
      ...a, radicado: a.procesos?.radicado, cliente: a.procesos?.clientes?.nombre,
      conDocumentos: !!a.actuaciones?.con_documentos,
    }));
  },

  async notificaciones() {
    if (!HAS_DB) return [];
    const { data: rows } = await db.from('notificaciones')
      .select('id, canal, destinatario_tipo, destinatario_valor, estado, enviada_en, alertas(titulo, procesos(radicado))')
      .order('creado_en', { ascending: false }).limit(200);
    return (rows || []).map(n => ({ ...n, titulo: n.alertas?.titulo, radicado: n.alertas?.procesos?.radicado }));
  },

  async vencimientos() {
    if (!HAS_DB) { const d = await cargarDemo(); return d.audiencias.filter(a => a.fecha).sort((x, y) => (x.fecha || '').localeCompare(y.fecha)); }
    const { data: rows } = await db.from('audiencias').select('id, fecha, hora, descripcion, lugar, clientes(nombre)').order('fecha').limit(200);
    return (rows || []).map(a => ({ ...a, cliente: a.clientes?.nombre }));
  },

  async plantillas() {
    if (!HAS_DB) { const d = await cargarDemo(); return d.plantillas; }
    const { data: rows } = await db.from('plantillas').select('*').eq('activa', true).order('nombre');
    return rows || [];
  },

  // --- Consulta en vivo contra la Rama Judicial (por radicado o por nombre) ---
  async consultaViva(qRaw) {
    const q = (qRaw || '').trim();
    if (!q) return { tipo: 'vacio' };
    const esRadicado = /^\d{23}$/.test(q);

    if (esRadicado) {
      const info = await consultarPorRadicado(q);
      if (!info) return { tipo: 'radicado', encontrado: false, radicado: q };
      const actuaciones = await obtenerActuaciones(info.idProceso, { max: 60 });

      let enBaseLocal = false, revision = null, clienteLocal = null;
      if (HAS_DB) {
        const { data: proc } = await db.from('procesos')
          .select('id, clientes(nombre)').eq('radicado', q).maybeSingle();
        if (proc) {
          enBaseLocal = true;
          clienteLocal = proc.clientes?.nombre || null;
          const { data: ult } = await db.from('actuaciones')
            .select('cons_actuacion').eq('proceso_id', proc.id)
            .order('cons_actuacion', { ascending: false }).limit(1).maybeSingle();
          const esPrimeraVez = !ult;
          const tope = ult?.cons_actuacion ?? -1;
          const nuevas = actuaciones.filter(a => (a.consActuacion ?? 0) > tope);

          let guardadas = 0;
          if (nuevas.length) {
            const rows = nuevas.map(a => ({
              proceso_id: proc.id, id_reg_actuacion: a.idRegActuacion, cons_actuacion: a.consActuacion,
              fecha_actuacion: a.fechaActuacion, fecha_registro: a.fechaRegistro,
              tipo: a.tipo, anotacion: a.anotacion, con_documentos: a.conDocumentos, es_nueva: !esPrimeraVez,
            }));
            const { data: ins, error: errIns } = await db.from('actuaciones')
              .upsert(rows, { onConflict: 'id_reg_actuacion', ignoreDuplicates: true })
              .select('id, anotacion, fecha_actuacion');
            if (errIns) {
              throw new Error('No se pudo guardar la revisión: ' + errIns.message);
            }
            if (ins?.length && !esPrimeraVez) {
              guardadas = ins.length;
              await db.from('alertas').insert(ins.map(a => ({
                proceso_id: proc.id, actuacion_id: a.id, tipo: 'nueva_actuacion',
                titulo: `Nueva actuación en ${q}`, detalle: a.anotacion?.slice(0, 500), estado: 'pendiente',
              })));
            }
          }
          await db.from('procesos').update({
            id_cpnu: info.idProceso, fecha_ultima_actuacion: info.fechaUltimaActuacion,
            ultima_actuacion_texto: actuaciones[0]?.anotacion?.slice(0, 500),
            ultimo_check_en: new Date().toISOString(),
          }).eq('id', proc.id);
          revision = { hecha: true, nuevasGuardadas: guardadas };
        }
      }
      return { tipo: 'radicado', encontrado: true, info, cliente: clienteLocal, actuaciones: actuaciones.slice(0, 10), enBaseLocal, revision };
    }

    // Búsqueda por nombre / razón social
    const resultados = await consultarPorNombre(q);
    let radicadosLocales = new Set();
    if (HAS_DB && resultados.length) {
      const radicados = resultados.map(r => r.llaveProceso).filter(Boolean);
      if (radicados.length) {
        const { data: locales } = await db.from('procesos').select('radicado').in('radicado', radicados);
        radicadosLocales = new Set((locales || []).map(l => l.radicado));
      }
    }
    return {
      tipo: 'nombre',
      resultados: resultados.slice(0, 15).map(r => ({
        idProceso: r.idProceso, radicado: r.llaveProceso, despacho: r.despacho, departamento: r.departamento,
        fechaUltimaActuacion: r.fechaUltimaActuacion, sujetos: r.sujetosProcesales,
        enBaseLocal: radicadosLocales.has(r.llaveProceso),
      })),
    };
  },

  // --- CRUD (solo modo real) ---
  async crearProceso(body) { const { data: r, error } = await db.from('procesos').insert(body).select().single(); if (error) throw error; return r; },
  async editarProceso(id, body) { const { data: r, error } = await db.from('procesos').update(body).eq('id', id).select().single(); if (error) throw error; return r; },
  async borrarProceso(id) { const { error } = await db.from('procesos').delete().eq('id', id); if (error) throw error; return { ok: true }; },

  // --- Carga masiva de radicados (Rama Judicial / Superfinanciera / SIC) ---
  async ingestarProcesos({ fuente, radicados }) {
    const lista = (radicados || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (!lista.length) return { creados: 0, omitidos: 0 };
    const esRama = fuente === 'rama_judicial';
    const rows = lista.map(radicado => {
      const esRadicado23 = /^\d{23}$/.test(radicado);
      return {
        radicado, fuente: fuente || 'rama_judicial',
        tipo_id: esRama && esRadicado23 ? 'radicado_23' : 'otro',
        api_trackable: esRama && esRadicado23,   // solo Rama Judicial tiene rastreo automático
        estado: 'activo', sede: 'generales',
      };
    });
    const { data: ins, error } = await db.from('procesos')
      .upsert(rows, { onConflict: 'radicado', ignoreDuplicates: true }).select('id');
    if (error) throw error;
    return { creados: ins?.length || 0, omitidos: lista.length - (ins?.length || 0) };
  },

  // --- Clientes (CRM) ---
  async clientes(q = '', tipo = '') {
    if (!HAS_DB) return [];
    let query = db.from('clientes').select('id, nombre, tipo, documento, telefono, whatsapp, email, creado_en, procesos(count)');
    if (tipo) query = query.eq('tipo', tipo);
    if (q) query = query.or(`nombre.ilike.%${q}%,documento.ilike.%${q}%,email.ilike.%${q}%`);
    const { data: rows } = await query.order('nombre');
    return (rows || []).map(c => ({ ...c, numProcesos: c.procesos?.[0]?.count || 0 }));
  },
  async crearCliente(body) { const { data: r, error } = await db.from('clientes').insert(body).select().single(); if (error) throw error; return r; },
  async editarCliente(id, body) { const { data: r, error } = await db.from('clientes').update(body).eq('id', id).select().single(); if (error) throw error; return r; },
  async borrarCliente(id) { const { error } = await db.from('clientes').delete().eq('id', id); if (error) throw error; return { ok: true }; },

  // --- Despachos (vista agregada por juzgado) ---
  async despachos() {
    if (!HAS_DB) return [];
    const { data: rows } = await db.from('procesos')
      .select('despacho, juzgado, departamento, tipo_proceso, jurisdiccion, api_trackable, fecha_ultima_actuacion, ultimo_check_en')
      .not('despacho', 'is', null);
    const porDespacho = new Map();
    for (const p of rows || []) {
      const key = p.despacho || p.juzgado;
      if (!key) continue;
      if (!porDespacho.has(key)) {
        porDespacho.set(key, {
          despacho: key, municipio: p.departamento || null, especialidad: p.tipo_proceso || null,
          jurisdiccion: p.jurisdiccion || null, tipo: p.api_trackable ? 'Rama Judicial' : 'Manual',
          procesos: 0, fechaUltimaPublicacion: null, ultimaSincronizacion: null,
        });
      }
      const d = porDespacho.get(key);
      d.procesos++;
      if (p.fecha_ultima_actuacion && (!d.fechaUltimaPublicacion || p.fecha_ultima_actuacion > d.fechaUltimaPublicacion)) d.fechaUltimaPublicacion = p.fecha_ultima_actuacion;
      if (p.ultimo_check_en && (!d.ultimaSincronizacion || p.ultimo_check_en > d.ultimaSincronizacion)) d.ultimaSincronizacion = p.ultimo_check_en;
    }
    return [...porDespacho.values()].sort((a, b) => b.procesos - a.procesos);
  },

  // --- Analítica para el dashboard de Inicio ---
  async analitica() {
    if (!HAS_DB) return null;
    const { data: rows } = await db.from('procesos')
      .select('jurisdiccion, tipo_proceso, fecha_ultima_actuacion, abogado_id, creado_en, estado');
    const lista = rows || [];
    const hoy = new Date();
    const meses = (a, b) => (a.getFullYear() - b.getFullYear()) * 12 + (a.getMonth() - b.getMonth());
    const antiguedad = { m0_6: 0, m6_12: 0, mas12: 0, sin: 0 };
    for (const p of lista) {
      if (!p.fecha_ultima_actuacion) { antiguedad.sin++; continue; }
      const m = meses(hoy, new Date(p.fecha_ultima_actuacion));
      if (m <= 6) antiguedad.m0_6++; else if (m <= 12) antiguedad.m6_12++; else antiguedad.mas12++;
    }
    const contarPor = campo => {
      const mapa = {};
      for (const p of lista) { const k = p[campo] || 'Sin clasificar'; mapa[k] = (mapa[k] || 0) + 1; }
      return Object.entries(mapa).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([nombre, total]) => ({ nombre, total }));
    };
    const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString();
    const procesosNuevosEsteMes = lista.filter(p => p.creado_en >= inicioMes).length;
    const { count: actuacionesEsteMes } = await db.from('actuaciones').select('*', { count: 'exact', head: true }).gte('creado_en', inicioMes);
    const porAdoptar = lista.filter(p => !p.abogado_id && p.estado === 'activo').length;
    return {
      antiguedad, porJurisdiccion: contarPor('jurisdiccion'), porEspecialidad: contarPor('tipo_proceso'),
      procesosNuevosEsteMes, actuacionesEsteMes: actuacionesEsteMes || 0, porAdoptar,
    };
  },
};

// ---------------------------------------------------------------------
//  Servidor HTTP
// ---------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  try {
    // API
    if (path.startsWith('/api/')) {
      if (!HAS_DB && req.method !== 'GET') return json(res, 403, { error: 'CRUD deshabilitado en modo demostración. Conecta Supabase.' });
      const m = path.match(/^\/api\/procesos\/(.+)$/);
      const mc = path.match(/^\/api\/clientes\/(.+)$/);
      if (path === '/api/stats') return json(res, 200, await data.stats());
      if (path === '/api/analitica') return json(res, 200, await data.analitica());
      if (path === '/api/rastreo-actual') return json(res, 200, await data.rastreoActual());
      if (path === '/api/procesos' && req.method === 'GET') return json(res, 200, await data.procesos(url.searchParams.get('q') || '', url.searchParams.get('sort') || ''));
      if (path === '/api/procesos' && req.method === 'POST') return json(res, 200, await data.crearProceso(await body(req)));
      if (path === '/api/procesos/ingest' && req.method === 'POST') return json(res, 200, await data.ingestarProcesos(await body(req)));
      if (m && req.method === 'PUT') return json(res, 200, await data.editarProceso(m[1], await body(req)));
      if (m && req.method === 'DELETE') return json(res, 200, await data.borrarProceso(m[1]));
      if (path === '/api/cambios') return json(res, 200, await data.cambios());
      if (path === '/api/notificaciones') return json(res, 200, await data.notificaciones());
      if (path === '/api/vencimientos') return json(res, 200, await data.vencimientos());
      if (path === '/api/plantillas') return json(res, 200, await data.plantillas());
      if (path === '/api/despachos') return json(res, 200, await data.despachos());
      if (path === '/api/clientes' && req.method === 'GET') return json(res, 200, await data.clientes(url.searchParams.get('q') || '', url.searchParams.get('tipo') || ''));
      if (path === '/api/clientes' && req.method === 'POST') return json(res, 200, await data.crearCliente(await body(req)));
      if (mc && req.method === 'PUT') return json(res, 200, await data.editarCliente(mc[1], await body(req)));
      if (mc && req.method === 'DELETE') return json(res, 200, await data.borrarCliente(mc[1]));
      if (path === '/api/consulta-viva') return json(res, 200, await data.consultaViva(url.searchParams.get('q') || ''));
      return json(res, 404, { error: 'no encontrado' });
    }
    // Estáticos
    const file = path === '/' ? 'index.html' : path.slice(1);
    const full = join(__dirname, 'public', file);
    const content = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' });
    res.end(content);
  } catch (e) {
    if (e.code === 'ENOENT') return json(res, 404, { error: 'no encontrado' });
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Dashboard en  http://localhost:${PORT}`);
  console.log(`  Modo         ${HAS_DB ? 'REAL (Supabase, CRUD activo)' : 'DEMOSTRACIÓN (datos migrados, solo lectura)'}\n`);
});
