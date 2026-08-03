// =====================================================================
//  normalize.mjs  ·  Etapa B de la migración
//  Lee el JSON crudo (scrape.mjs) y produce:
//    output/normalized/clientes.json
//    output/normalized/procesos.json
//    output/normalized/audiencias.json
//    output/normalized/seed.sql        (listo para Supabase)
//    output/normalized/_revision.json  (filas que requieren revisión manual)
//  Uso:  node normalize.mjs
// =====================================================================
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = join(__dirname, 'output');
const OUT = join(__dirname, 'output', 'normalized');

// ---------- utilidades ----------
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const isBlank = r => !r.some(c => c && c.trim());

// Extrae un radicado de 23 dígitos si existe dentro del texto
function extraerRadicado23(raw) {
  const m = (raw || '').match(/\b\d{23}\b/);
  return m ? m[0] : null;
}
function extraerTutela(raw) {
  const m = (raw || '').match(/\bT-?\d{5,}\b/i);
  return m ? m[0].toUpperCase() : null;
}
// Detecta filas que NO son procesos: nombres de juzgado o notas pegadas en la columna de ID
function esBasuraId(raw) {
  const s = norm(raw);
  if (!s) return true;
  if (/^JUZGADO\b/.test(s)) return true;
  if (/REVISION SEMANAL|^TOTAL\b|^NOTA\b/.test(s)) return true;
  return false;
}
function clasificarId(raw) {
  const rad = extraerRadicado23(raw);
  if (rad) return { radicado: rad, tipo_id: 'radicado_23', api_trackable: true };
  const tut = extraerTutela(raw);
  if (tut) return { radicado: null, tipo_id: 'tutela', api_trackable: false };
  const soloDigitos = (raw || '').replace(/\D/g, '');
  if (soloDigitos.length >= 6 && soloDigitos.length <= 22) return { radicado: null, tipo_id: 'interno', api_trackable: false };
  return { radicado: null, tipo_id: 'otro', api_trackable: false };
}

// Convierte fechas dd/mm/aaaa (y variantes sucias) a ISO yyyy-mm-dd, o null
function parseFecha(s) {
  if (!s) return null;
  const t = s.trim().replace(/\s.*$/, '');            // corta hora si viene pegada
  const m = t.match(/^(\d{1,2})[\/\-](\d{1,3})[\/\-](\d{2,4})$/);
  if (!m) return null;
  let [, a, b, y] = m;
  a = parseInt(a, 10); b = parseInt(b, 10); y = parseInt(y, 10);
  if (y < 100) y += 2000;
  let dd, mm;
  if (b > 12 && a <= 12) { mm = a; dd = b; }           // formato m/d (US)
  else { dd = a; mm = b; }                             // formato d/m (CO)
  if (mm > 12 || dd > 31 || mm < 1 || dd < 1) return null;
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

// Es una fila de encabezado o de sección (juzgado/mes/título) que hay que saltar
function esRuido(row, sede) {
  const j = row.join(' ').toUpperCase();
  if (/ID PROCESO|ID DEL PROCESO|NRO RADICADO|ULTIMA ACTUACION|ÚLTIMA ACTUACIÓN/.test(j)) return true;
  if (/^AUDIENCIAS 2025$/.test(j.trim())) return true;
  if (/^(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)$/.test(j.trim())) return true;
  return false;
}
// ¿La fila es un encabezado de sección "JUZGADO ..." (ZIPA/FUSA)?
function esSeccionJuzgado(row) {
  const vals = row.filter(c => c && c.trim());
  return vals.length === 1 && /^JUZGADO\s/i.test(vals[0]);
}

// ---------- acumuladores ----------
const clientesMap = new Map();   // nombreNorm -> {id, nombre}
function clienteId(nombre) {
  const n = (nombre || '').trim();
  if (!n) return null;
  const k = norm(n);
  if (!clientesMap.has(k)) clientesMap.set(k, { id: randomUUID(), nombre: n });
  return clientesMap.get(k).id;
}

const procesos = [];
const audiencias = [];
const revision = [];   // filas dudosas

// ---------- mappers por pestaña ----------
function mapGENERALES(filas) {
  for (const r of filas) {
    if (isBlank(r) || esRuido(r, 'generales')) continue;
    const [seq, id, cliente, demandado, fecha, ultima] = r;
    if (!id) continue;
    if (esBasuraId(id)) { revision.push({ sede: 'generales', motivo: 'Fila no es proceso (juzgado/nota)', fila: r }); continue; }
    const cls = clasificarId(id);
    const p = {
      id: randomUUID(), origen_id_raw: id, ...cls,
      cliente_id: clienteId(cliente), demandante: null, demandado: demandado || null,
      tipo_proceso: null, despacho: null, departamento: null, juzgado: null,
      oficina_responsable: null, sede: 'generales', estado: 'activo',
      fecha_ultima_actuacion: parseFecha(fecha),
      ultima_actuacion_texto: (ultima && ultima !== 'NO HA LLEGADO') ? ultima : null,
    };
    procesos.push(p);
    if (cls.tipo_id === 'otro') revision.push({ sede: 'generales', motivo: 'ID no reconocido', fila: r });
  }
}

function mapARCHIVADOS(filas) {
  for (const r of filas) {
    if (isBlank(r)) continue;
    const [seq, id, cliente, oficina, juzgado, entidad, estadoTxt, ultima, fecha] = r;
    if (!id || !id.trim()) continue;
    if (esBasuraId(id)) { revision.push({ sede: 'archivados', motivo: 'Fila no es proceso (juzgado/nota)', fila: r }); continue; }
    const cls = clasificarId(id);
    procesos.push({
      id: randomUUID(), origen_id_raw: id, ...cls,
      cliente_id: clienteId(cliente), demandante: null, demandado: entidad || null,
      tipo_proceso: null, despacho: null, departamento: null,
      juzgado: juzgado || null, oficina_responsable: oficina || null,
      sede: 'archivados', estado: 'archivado',
      fecha_ultima_actuacion: parseFecha(fecha),
      ultima_actuacion_texto: ultima || null,
    });
    if (cls.tipo_id === 'otro') revision.push({ sede: 'archivados', motivo: 'ID no reconocido', fila: r });
  }
}

function mapALIANZA(filas) {
  for (const r of filas) {
    if (isBlank(r) || esRuido(r, 'alianza')) continue;
    const [seq, id, fecha, cliente, entidad, ultima] = r;
    if (!id) continue;
    const cls = clasificarId(id);
    procesos.push({
      id: randomUUID(), origen_id_raw: id, ...cls,
      cliente_id: clienteId(cliente), demandante: null, demandado: entidad || null,
      tipo_proceso: null, despacho: entidad || null, departamento: null, juzgado: null,
      oficina_responsable: null, sede: 'alianza', estado: 'activo',
      fecha_ultima_actuacion: parseFecha(fecha),
      ultima_actuacion_texto: ultima || null,
    });
    if (cls.tipo_id === 'otro') revision.push({ sede: 'alianza', motivo: 'ID no reconocido', fila: r });
  }
}

// ZIPA / FUSA: el juzgado es un encabezado de sección que aplica a las filas siguientes
function mapConSeccion(filas, sede, cols) {
  let juzgadoActual = null;
  for (const r of filas) {
    if (isBlank(r)) continue;
    if (esSeccionJuzgado(r)) { juzgadoActual = r.filter(c => c && c.trim())[0]; continue; }
    if (esRuido(r, sede)) continue;
    const id = r[cols.id];
    if (!id || !id.trim()) continue;
    const cls = clasificarId(id);
    procesos.push({
      id: randomUUID(), origen_id_raw: id, ...cls,
      cliente_id: clienteId(r[cols.demandante]),
      demandante: r[cols.demandante] || null,
      demandado: r[cols.demandado] || null,
      tipo_proceso: cols.tipo != null ? (r[cols.tipo] || null) : null,
      despacho: null, departamento: null, juzgado: juzgadoActual,
      oficina_responsable: null, sede, estado: 'activo',
      fecha_ultima_actuacion: null, ultima_actuacion_texto: null,
    });
    if (cls.tipo_id === 'otro') revision.push({ sede, motivo: 'ID no reconocido', fila: r });
  }
}

function mapAUDIENCIAS(filas) {
  for (const r of filas) {
    if (isBlank(r) || esRuido(r, 'audiencias')) continue;
    const [seq, fecha, descripcion, cliente, lugar] = r;
    if (!descripcion) continue;                        // saltar encabezados de mes
    const hm = (descripcion || '').match(/(\d{1,2}[:.]\d{2}\s?(?:A\.?M\.?|P\.?M\.?)?)/i);
    audiencias.push({
      id: randomUUID(),
      fecha: parseFecha(fecha),
      hora: hm ? hm[1] : null,
      descripcion,
      cliente_id: clienteId(cliente),
      lugar: lugar || null,
    });
  }
}

// ---------- SQL ----------
const q = v => v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
const b = v => v ? 'TRUE' : 'FALSE';

function generarSQL() {
  const L = [];
  L.push('-- Semilla generada por normalize.mjs — cargar DESPUÉS de schema.sql');
  L.push('BEGIN;');
  L.push('\n-- Clientes');
  for (const c of clientesMap.values())
    L.push(`INSERT INTO clientes (id, nombre) VALUES ('${c.id}', ${q(c.nombre)});`);
  L.push('\n-- Procesos');
  for (const p of procesos) {
    L.push(
      `INSERT INTO procesos (id, radicado, tipo_id, origen_id_raw, api_trackable, cliente_id, ` +
      `demandante, demandado, tipo_proceso, despacho, departamento, juzgado, oficina_responsable, ` +
      `sede, estado, fecha_ultima_actuacion, ultima_actuacion_texto) VALUES (` +
      `'${p.id}', ${q(p.radicado)}, '${p.tipo_id}', ${q(p.origen_id_raw)}, ${b(p.api_trackable)}, ` +
      `${p.cliente_id ? `'${p.cliente_id}'` : 'NULL'}, ${q(p.demandante)}, ${q(p.demandado)}, ` +
      `${q(p.tipo_proceso)}, ${q(p.despacho)}, ${q(p.departamento)}, ${q(p.juzgado)}, ` +
      `${q(p.oficina_responsable)}, '${p.sede}', '${p.estado}', ` +
      `${p.fecha_ultima_actuacion ? `'${p.fecha_ultima_actuacion}'` : 'NULL'}, ${q(p.ultima_actuacion_texto)});`
    );
  }
  L.push('\n-- Audiencias');
  for (const a of audiencias) {
    L.push(
      `INSERT INTO audiencias (id, fecha, hora, descripcion, cliente_id, lugar) VALUES (` +
      `'${a.id}', ${a.fecha ? `'${a.fecha}'` : 'NULL'}, ${q(a.hora)}, ${q(a.descripcion)}, ` +
      `${a.cliente_id ? `'${a.cliente_id}'` : 'NULL'}, ${q(a.lugar)});`
    );
  }
  L.push('\nCOMMIT;');
  return L.join('\n');
}

// ---------- main ----------
async function cargar(pestana) {
  const d = JSON.parse(await readFile(join(RAW, `raw_${pestana}.json`), 'utf8'));
  return d.filas;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  mapGENERALES(await cargar('GENERALES'));
  mapARCHIVADOS(await cargar('ARCHIVADOS'));
  mapALIANZA(await cargar('ALIANZA'));
  mapConSeccion(await cargar('ZIPA'), 'zipa', { id: 1, tipo: 2, demandante: 3, demandado: 4 });
  mapConSeccion(await cargar('FUSAGASUGA'), 'fusagasuga', { id: 1, tipo: null, demandante: 2, demandado: 3 });
  mapAUDIENCIAS(await cargar('AUDIENCIAS'));

  // Dedupe procesos por radicado: el mismo proceso puede aparecer en varias pestañas
  const vistos = new Set();
  const sinDup = [];
  let duplicados = 0;
  for (const p of procesos) {
    if (p.radicado) {
      if (vistos.has(p.radicado)) { duplicados++; continue; }
      vistos.add(p.radicado);
    }
    sinDup.push(p);
  }
  procesos.length = 0; procesos.push(...sinDup);

  const clientes = [...clientesMap.values()];
  await writeFile(join(OUT, 'clientes.json'), JSON.stringify(clientes, null, 2));
  await writeFile(join(OUT, 'procesos.json'), JSON.stringify(procesos, null, 2));
  await writeFile(join(OUT, 'audiencias.json'), JSON.stringify(audiencias, null, 2));
  await writeFile(join(OUT, '_revision.json'), JSON.stringify(revision, null, 2));
  await writeFile(join(OUT, 'seed.sql'), generarSQL());

  // Resumen
  const porTipo = procesos.reduce((a, p) => (a[p.tipo_id] = (a[p.tipo_id] || 0) + 1, a), {});
  const porSede = procesos.reduce((a, p) => (a[p.sede] = (a[p.sede] || 0) + 1, a), {});
  const trackables = procesos.filter(p => p.api_trackable).length;
  console.log('===== NORMALIZACIÓN =====');
  console.log('Clientes únicos :', clientes.length);
  console.log('Procesos        :', procesos.length);
  console.log('Audiencias      :', audiencias.length);
  console.log('Rastreables API :', trackables, `(${Math.round(trackables / procesos.length * 100)}%)`);
  console.log('Por tipo de ID  :', porTipo);
  console.log('Por sede        :', porSede);
  console.log('Duplicados quitados:', duplicados);
  console.log('Para revisar    :', revision.length);
  console.log('\nArchivos en migration/output/normalized/  (incluye seed.sql)');
}

main().catch(e => { console.error(e); process.exit(1); });
