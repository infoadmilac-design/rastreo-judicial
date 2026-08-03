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
    return {
      modo: 'real',
      procesos: await one('procesos'),
      rastreables: (await db.from('procesos').select('*', { count: 'exact', head: true }).eq('api_trackable', true)).count || 0,
      activos: (await db.from('procesos').select('*', { count: 'exact', head: true }).eq('estado', 'activo')).count || 0,
      archivados: (await db.from('procesos').select('*', { count: 'exact', head: true }).eq('estado', 'archivado')).count || 0,
      alertasPendientes: (await db.from('alertas').select('*', { count: 'exact', head: true }).eq('estado', 'pendiente')).count || 0,
      audiencias: await one('audiencias'),
    };
  },

  async procesos(q = '') {
    if (!HAS_DB) {
      const d = await cargarDemo();
      const s = q.toLowerCase();
      return d.procesos.filter(p =>
        !s || (p.radicado || '').includes(s) || (p.cliente || '').toLowerCase().includes(s) ||
        (p.origen_id_raw || '').toLowerCase().includes(s)).slice(0, 500);
    }
    let query = db.from('procesos').select('id, radicado, origen_id_raw, tipo_id, api_trackable, estado, sede, demandado, despacho, fecha_ultima_actuacion, ultima_actuacion_texto, clientes(nombre), abogados(nombre)').limit(500);
    if (q) query = query.or(`radicado.ilike.%${q}%,origen_id_raw.ilike.%${q}%`);
    const { data: rows } = await query;
    return (rows || []).map(p => ({ ...p, cliente: p.clientes?.nombre, abogado: p.abogados?.nombre }));
  },

  async cambios() {
    if (!HAS_DB) return [];   // en demo aún no hay actuaciones detectadas
    const { data: rows } = await db.from('alertas')
      .select('id, tipo, titulo, detalle, estado, creado_en, procesos(radicado, clientes(nombre))')
      .order('creado_en', { ascending: false }).limit(200);
    return (rows || []).map(a => ({ ...a, radicado: a.procesos?.radicado, cliente: a.procesos?.clientes?.nombre }));
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

  // --- CRUD (solo modo real) ---
  async crearProceso(body) { const { data: r, error } = await db.from('procesos').insert(body).select().single(); if (error) throw error; return r; },
  async editarProceso(id, body) { const { data: r, error } = await db.from('procesos').update(body).eq('id', id).select().single(); if (error) throw error; return r; },
  async borrarProceso(id) { const { error } = await db.from('procesos').delete().eq('id', id); if (error) throw error; return { ok: true }; },
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
      if (path === '/api/stats') return json(res, 200, await data.stats());
      if (path === '/api/procesos' && req.method === 'GET') return json(res, 200, await data.procesos(url.searchParams.get('q') || ''));
      if (path === '/api/procesos' && req.method === 'POST') return json(res, 200, await data.crearProceso(await body(req)));
      if (m && req.method === 'PUT') return json(res, 200, await data.editarProceso(m[1], await body(req)));
      if (m && req.method === 'DELETE') return json(res, 200, await data.borrarProceso(m[1]));
      if (path === '/api/cambios') return json(res, 200, await data.cambios());
      if (path === '/api/notificaciones') return json(res, 200, await data.notificaciones());
      if (path === '/api/vencimientos') return json(res, 200, await data.vencimientos());
      if (path === '/api/plantillas') return json(res, 200, await data.plantillas());
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
