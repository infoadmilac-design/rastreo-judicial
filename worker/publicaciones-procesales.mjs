// =====================================================================
//  publicaciones-procesales.mjs · Revisión manual automatizada
//  Revisa el portal "Publicaciones Procesales" (ramajudicial.gov.co) para
//  los despachos de Zipaquirá/Cogua cuyos procesos NO se pueden rastrear
//  por el API CPNU (radicados internos tipo "interno"). Descarga los
//  boletines "Notificación por Estado" nuevos de cada despacho, busca los
//  radicados internos que tenemos guardados y, si aparecen, crea una
//  alerta igual que hace rastrear.mjs con el API oficial.
//
//  Cómo funciona por dentro: el portal es un portlet Liferay que responde
//  a peticiones GET normales (sin sesión) con HTML. La mayoría de despachos
//  (formato 'pdf') traen en el listado un enlace directo al PDF combinado
//  de cada "Notificación por Estado" — texto real, se lee con pdf-parse.
//
//  Algunos despachos (formato 'documentos') NO traen ese enlace directo:
//  el boletín solo se ve entrando al botón "Ver" de cada publicación, que
//  abre una página de detalle (detail.jsp) con una tabla de documentos
//  INDIVIDUALES por caso (nombrados con el radicado y las partes). Esa
//  página también es HTML plano sin sesión, así que se puede pedir igual
//  con fetch — solo cambia qué se busca: en vez de leer el PDF combinado
//  y buscar el radicado en su texto, se busca el radicado en el NOMBRE de
//  cada documento individual (no hace falta descargar cada PDF).
//
//  Uso:  node --env-file=.env publicaciones-procesales.mjs
// =====================================================================
import { createClient } from '@supabase/supabase-js';
import { PDFParse } from 'pdf-parse';

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('Falta SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });

// Despachos a revisar. El nombre de "juzgado" debe coincidir EXACTO con
// procesos.juzgado (así se relaciona cada despacho con sus radicados).
// "formato: 'documentos'" son los despachos cuyo boletín NO trae un PDF
// combinado en el listado (o lo trae solo como imagen de portada) — hay
// que entrar a la página de detalle de cada publicación y revisar los
// documentos individuales, ver revisarDespachoDocumentos().
const DESPACHOS = [
  { codigo: '258993103001', juzgado: 'JUZGADO PRIMERO CIVIL CIRCUITO DE ZIPAQUIRA' },
  { codigo: '258993103002', juzgado: 'JUZGADO SEGUNDO CIVIL CIRCUITO DE ZIPAQUIRA' },
  { codigo: '258993103003', juzgado: 'JUZGADO TERCERO CIVIL CIRCUITO DE ZIPAQUIRA', formato: 'documentos' },
  { codigo: '258993110001', juzgado: 'JUZGADO PRIMERO FAMILIA DE ZIPAQUIRA' },
  { codigo: '258993110002', juzgado: 'JUZGADO SEGUNDO FAMILIA DE ZIPAQUIRA', formato: 'documentos' },
  { codigo: '258994003002', juzgado: 'JUZGADO SEGUNDO MUNICIPAL DE ZIPAQUIRA' },
  { codigo: '252004089001', juzgado: 'JUZGADO PRIMERO PROMISCUO MUNICIPAL DE COGUA', formato: 'documentos' },
  // Despachos que aparecen en el Sheet con procesos "internos" (sin radicado de 23 dígitos).
  // formato 'auto': cada despacho publica distinto (PDF combinado o documentos sueltos) y
  // puede cambiar, así que se decide en cada corrida según lo que traiga el listado.
  { codigo: '252903103001', juzgado: 'JUZGADO PRIMERO CIVIL CIRCUITO DE FUSAGASUGA', formato: 'auto' },
  { codigo: '252903103002', juzgado: 'JUZGADO SEGUNDO CIVIL CIRCUITO DE FUSAGASUGA', formato: 'auto' },
  // "ids": procesos de la pestaña GENERALES del Sheet que están bajo ese juzgado pero se
  // cargaron sin juzgado; si siguen sin él, se les asigna aquí (y se guardan en la BD).
  { codigo: '251754003001', juzgado: 'JUZGADO PRIMERO CIVIL MUNICIPAL DE CHIA', formato: 'auto', ids: ['201700551', '202200287'] },
  { codigo: '251754003003', juzgado: 'JUZGADO TERCERO CIVIL MUNICIPAL DE CHIA', formato: 'auto', ids: ['202501003', '202501205', '202500459'] },
  { codigo: '251264089001', juzgado: 'JUZGADO PRIMERO PROMISCUO MUNICIPAL DE CAJICA', formato: 'auto', ids: ['202400205', '202400323'] },
  { codigo: '251264089003', juzgado: 'JUZGADO TERCERO PROMISCUO MUNICIPAL DE CAJICA', formato: 'auto', ids: ['202500402'] },
  { codigo: '251264089004', juzgado: 'JUZGADO CUARTO PROMISCUO MUNICIPAL DE CAJICA', formato: 'auto' },
];

const PORTLET = 'co_com_avanti_efectosProcesales_PublicacionesEfectosProcesalesPortletV2_INSTANCE_BIyXQFHVaYaq';
const ID_STRUCTURE_ESTADOS = '6098957'; // categoría fija "Notificaciones por Estados"
const BASE = 'https://publicacionesprocesales.ramajudicial.gov.co/web/publicaciones-procesales/inicio';
const RESPIRO_MS = 3000; // pausa entre despachos, mismo criterio que rastrear.mjs

const sleep = ms => new Promise(r => setTimeout(r, ms));

// El portal de la Rama es inestable: a veces contesta un 404 de Tomcat en 1 s (un nodo sin
// el portlet) y a veces se cuelga minutos. Cuando contesta lo hace rápido, así que se usan
// timeouts cortos y varios reintentos (el siguiente intento suele caer en un nodo sano).
async function pedir(url, { intentos = 4, timeoutMs = 60000, leer = 'text' } = {}) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (rastreo-judicial-bot)' }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return leer === 'buffer' ? Buffer.from(await res.arrayBuffer()) : await res.text();
      ultimo = new Error(`HTTP ${res.status}`);
    } catch (e) { ultimo = e; }
    await sleep(2000 * (i + 1));
  }
  throw ultimo;
}

async function bajarListado(idDespacho) {
  const qs = new URLSearchParams({
    p_p_id: PORTLET, p_p_lifecycle: '0', p_p_state: 'normal', p_p_mode: 'view',
    [`_${PORTLET}_idStructure`]: ID_STRUCTURE_ESTADOS,
    [`_${PORTLET}_action`]: 'filterStructures',
    [`_${PORTLET}_idDespacho`]: idDespacho,
  });
  try { return await pedir(`${BASE}?${qs}`); }
  catch (e) { throw new Error(`${e.message} listando despacho ${idDespacho}`); }
}

async function listarPdfsEstado(idDespacho) {
  return parsePdfUrls(await bajarListado(idDespacho));
}

// Cada "Notificación por Estado" trae un enlace directo a su PDF. El texto
// del enlace varía según el despacho ("LISTA ESTADO", "PDF ESTADO", etc.),
// así que no se usa como referencia — solo importa la URL. El folder id
// 20135 es el de los documentos de ayuda fijos de la página (instructivo,
// video, ABC), igual en todos los despachos, así que se excluye. Cada
// documento se identifica de forma única por su fileEntryId.
function parsePdfUrls(html) {
  const re = /href="(\/documents\/(\d+)\/(\d+)\/[^"]+\.pdf\/[^"]+)"/g;
  const out = new Map();
  let m;
  while ((m = re.exec(html))) {
    const [, relUrl, folderId, fileEntryId] = m;
    if (folderId === '20135') continue; // documentos de ayuda fijos, no boletines
    if (out.has(fileEntryId)) continue;
    out.set(fileEntryId, 'https://publicacionesprocesales.ramajudicial.gov.co' + relUrl);
  }
  return [...out.entries()].map(([fileEntryId, pdfUrl]) => ({ fileEntryId, pdfUrl }));
}

// ---- formato 'documentos': boletines sin PDF combinado en el listado ----

// El listado de un despacho 'documentos' trae, por cada publicación, un
// botón "Ver" que enlaza a esta misma página con jspPage=detail.jsp y un
// articleId — ese articleId identifica la publicación de forma única
// (equivalente al fileEntryId que usan los despachos 'pdf').
function parseArticleIds(html) {
  return [...new Set([...html.matchAll(/articleId=(\d+)/g)].map(m => m[1]))];
}

async function listarPublicaciones(idDespacho) {
  return parseArticleIds(await bajarListado(idDespacho));
}

const MESES_ES = { ene: '01', feb: '02', mar: '03', abr: '04', may: '05', jun: '06', jul: '07', ago: '08', sep: '09', oct: '10', nov: '11', dic: '12' };
function fechaEsAIso(txt) {
  const m = (txt || '').trim().match(/^(\d{1,2})\s+([a-záéíóúñ]{3})\.?\s+(\d{4})$/i);
  if (!m) return null;
  const mes = MESES_ES[m[2].toLowerCase()];
  return mes ? `${m[3]}-${mes}-${m[1].padStart(2, '0')}` : null;
}

// Trae la página de detalle de una publicación y extrae sus documentos
// individuales (nombre + URL de descarga directa) más los mismos metadatos
// (estado No., fecha) que metaPdf() saca del PDF combinado en el otro
// formato.
async function documentosDePublicacion(articleId) {
  const qs = new URLSearchParams({
    p_p_id: PORTLET, p_p_lifecycle: '0', p_p_state: 'normal', p_p_mode: 'view',
    [`_${PORTLET}_jspPage`]: '/META-INF/resources/detail.jsp',
    [`_${PORTLET}_articleId`]: articleId,
  });
  let html;
  try { html = await pedir(`${BASE}?${qs}`); }
  catch (e) { throw new Error(`${e.message} en detalle de publicación ${articleId}`); }

  const documentos = [...html.matchAll(/href="(\/c\/document_library\/get_file\?uuid=[0-9a-f-]+&groupId=\d+)"[^>]*>\s*([^<]+?)\s*<\/a>/g)]
    .map(([, relUrl, nombre]) => ({
      nombre: nombre.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
      url: 'https://publicacionesprocesales.ramajudicial.gov.co' + relUrl,
    }));

  const total = documentos.length;
  const fecha = fechaEsAIso(html.match(/Fecha de publicación<\/b><\/div>\s*<div class="datosDescription">\s*<p>([^<]+)<\/p>/)?.[1]);
  return { documentos, fecha, total };
}

// El listado guarda origen_id_raw como "AAAA-N..." (con guion, algunos
// despachos) o como "AAAANNNNN" pegado (año + consecutivo con ceros a la
// izquierda, lo más común). El nombre del documento individual siempre
// trae el radicado en formato "AAAA-N..." pero con una cantidad de ceros
// a la izquierda que varía según el despacho/época (ej. "1996-6774" vs
// "2024-00200"), así que se compara año + consecutivo SIN ceros a la
// izquierda en vez de comparar el texto tal cual.
// También acepta el radicado completo de 23 dígitos (despacho 12 + año 4 +
// consecutivo 5 + instancia 2), para procesos que el API de la Rama no encuentra.
function partesRadicado(origenIdRaw) {
  const raw = String(origenIdRaw || '').trim();
  let m = raw.match(/^(\d{4})-?(\d{3,6})$/);
  if (!m && /^\d{23}$/.test(raw)) m = [raw, raw.slice(12, 16), raw.slice(16, 21)];
  if (!m) return null;
  return { anio: m[1], numeroSinCeros: m[2].replace(/^0+/, '') || '0' };
}

function radicadoEnNombre(origenIdRaw, nombreDocumento) {
  const p = partesRadicado(origenIdRaw);
  if (!p) return false;
  return new RegExp(`${p.anio}-0*${p.numeroSinCeros}(?!\\d)`).test(nombreDocumento);
}

// Boletín PDF combinado: busca el texto tal cual (como siempre) y, para
// radicados de 23 dígitos, también su forma corta "AAAA-NNNNN".
function radicadoEnTexto(origenIdRaw, texto) {
  if (texto.includes(origenIdRaw)) return origenIdRaw;
  if (!/^\d{23}$/.test(String(origenIdRaw))) return null;
  const p = partesRadicado(origenIdRaw);
  return texto.match(new RegExp(`(?<!\\d)${p.anio}[- ]0*${p.numeroSinCeros}(?!\\d)`))?.[0] || null;
}

async function textoPdf(pdfUrl) {
  let buf;
  try { buf = await pedir(pdfUrl, { leer: 'buffer' }); }
  catch (e) { throw new Error(`${e.message} descargando PDF`); }
  const parser = new PDFParse({ data: buf });
  const { text } = await parser.getText();
  return text;
}

// Extrae metadatos simples que sí vienen limpios dentro del propio PDF
// (a diferencia del listado HTML, esto es confiable).
function metaPdf(texto) {
  const fecha = texto.match(/Fecha:\s*([\d-]{10})/)?.[1] || null;
  const total = texto.match(/Total de Procesos\s*:\s*(\d+)/)?.[1] || null;
  return { fecha, total };
}

// Recorta un fragmento de texto alrededor de la primera aparición del
// radicado, para usarlo como contexto de la alerta (no se intenta separar
// en columnas exactas — el enlace al PDF real queda en el detalle para
// que el abogado verifique la fila completa).
function extraerContexto(texto, radicado) {
  const idx = texto.indexOf(radicado);
  if (idx === -1) return null;
  const inicio = Math.max(0, idx - 10);
  const fin = Math.min(texto.length, idx + 350);
  return texto.slice(inicio, fin).replace(/\s+/g, ' ').trim();
}

async function crearAlerta(p, titulo, detalle, fecha, r) {
  const { error: errAlerta } = await db.from('alertas').insert({
    proceso_id: p.id, tipo: 'nueva_actuacion', titulo, detalle, estado: 'pendiente',
  });
  if (errAlerta) { console.log(`   ❌ alerta ${p.origen_id_raw}: ${errAlerta.message}`); return; }
  await db.from('procesos').update({
    ultima_actuacion_texto: detalle || null,
    fecha_ultima_actuacion: fecha || null,
  }).eq('id', p.id);
  r.coincidencias++;
}

async function revisarDespachoPdf(d, tracked, r, listado) {
  const pdfs = listado?.pdfs ?? await listarPdfsEstado(d.codigo);
  const { data: vistos } = await db.from('estados_pp_vistos')
    .select('file_entry_id').eq('despacho_codigo', d.codigo);
  const vistosSet = new Set((vistos || []).map(v => v.file_entry_id));
  const nuevos = pdfs.filter(p => !vistosSet.has(p.fileEntryId));

  console.log(`${d.juzgado}: ${tracked.length} proceso(s) rastreados, ${pdfs.length} boletines vistos, ${nuevos.length} nuevo(s)`);

  for (const { fileEntryId, pdfUrl } of nuevos) {
    try {
      const texto = await textoPdf(pdfUrl);
      const { fecha, total } = metaPdf(texto);
      r.estadosNuevos++;

      for (const p of tracked) {
        const hallado = radicadoEnTexto(p.origen_id_raw, texto);
        if (!hallado) continue;
        const contexto = extraerContexto(texto, hallado);
        await crearAlerta(p,
          `Movimiento en Publicaciones Procesales — ${p.origen_id_raw}`,
          `${contexto || ''}\n\nBoletín completo: ${pdfUrl}`.trim(), fecha, r);
        console.log(`   🔔 ${p.origen_id_raw}: coincidencia en boletín (fecha ${fecha}, ${total} procesos)`);
      }

      const { error: errVisto } = await db.from('estados_pp_vistos').insert({
        despacho_codigo: d.codigo, file_entry_id: fileEntryId,
        fecha_publicacion: fecha, total_procesos: total ? Number(total) : null,
      });
      if (errVisto) console.log(`   ❌ registrando visto ${fileEntryId}: ${errVisto.message}`);
    } catch (e) {
      r.errores++;
      console.log(`   ❌ boletín ${fileEntryId}: ${e.message}`);
    }
  }
}

async function revisarDespachoDocumentos(d, tracked, r, listado) {
  const articleIds = listado?.articleIds ?? await listarPublicaciones(d.codigo);
  const { data: vistos } = await db.from('estados_pp_vistos')
    .select('file_entry_id').eq('despacho_codigo', d.codigo);
  const vistosSet = new Set((vistos || []).map(v => v.file_entry_id));
  const nuevos = articleIds.filter(id => !vistosSet.has(id));

  console.log(`${d.juzgado}: ${tracked.length} proceso(s) rastreados, ${articleIds.length} publicaciones vistas, ${nuevos.length} nueva(s)`);

  for (const articleId of nuevos) {
    try {
      const { documentos, fecha, total } = await documentosDePublicacion(articleId);
      r.estadosNuevos++;

      for (const p of tracked) {
        const doc = documentos.find(doc => radicadoEnNombre(p.origen_id_raw, doc.nombre));
        if (!doc) continue;
        await crearAlerta(p,
          `Movimiento en Publicaciones Procesales — ${p.origen_id_raw}`,
          `${doc.nombre}\n\nDocumento: ${doc.url}`, fecha, r);
        console.log(`   🔔 ${p.origen_id_raw}: coincidencia en documento individual (fecha ${fecha}, ${total} documentos)`);
      }

      const { error: errVisto } = await db.from('estados_pp_vistos').insert({
        despacho_codigo: d.codigo, file_entry_id: articleId,
        fecha_publicacion: fecha, total_procesos: total,
      });
      if (errVisto) console.log(`   ❌ registrando visto ${articleId}: ${errVisto.message}`);
    } catch (e) {
      r.errores++;
      console.log(`   ❌ publicación ${articleId}: ${e.message}`);
    }
  }
}

async function main() {
  const r = { despachosRevisados: 0, estadosNuevos: 0, coincidencias: 0, errores: 0 };

  const procesarDespacho = async d => {
    try {
      const { data: procesos, error: errProc } = await db.from('procesos')
        .select('id, origen_id_raw, demandante, demandado')
        .eq('juzgado', d.juzgado)
        .not('origen_id_raw', 'is', null);
      if (errProc) throw errProc;
      const tracked = (procesos || []).filter(p => (p.origen_id_raw || '').length >= 6);

      if (d.ids?.length) {
        const { data: sinJuzgado } = await db.from('procesos')
          .select('id, origen_id_raw, demandante, demandado').is('juzgado', null).in('origen_id_raw', d.ids);
        for (const p of sinJuzgado || []) {
          await db.from('procesos').update({ juzgado: d.juzgado }).eq('id', p.id);
          if (!tracked.some(t => t.id === p.id)) tracked.push(p);
        }
      }

      // Procesos de este despacho con radicado de 23 dígitos que el API de la Rama NO
      // encuentra (nunca se pudieron revisar): se siguen por Publicaciones Procesales.
      const { data: sinApi } = await db.from('procesos')
        .select('id, radicado, demandante, demandado')
        .eq('api_trackable', true).is('ultimo_check_en', null)
        .like('radicado', `${d.codigo}%`);
      for (const p of sinApi || []) {
        if (!tracked.some(t => t.id === p.id)) tracked.push({ ...p, origen_id_raw: p.radicado });
      }
      if (!tracked.length) { console.log(`(sin procesos) ${d.juzgado}`); return; }

      r.despachosRevisados++;
      let formato = d.formato, listado;
      if (formato === 'auto') {
        const html = await bajarListado(d.codigo);
        const pdfs = parsePdfUrls(html), articleIds = parseArticleIds(html);
        formato = articleIds.length && pdfs.length < articleIds.length * 0.8 ? 'documentos' : 'pdf';
        listado = { pdfs, articleIds };
        console.log(`${d.juzgado}: formato detectado → ${formato} (${pdfs.length} PDF, ${articleIds.length} publicaciones)`);
      }
      if (formato === 'documentos') await revisarDespachoDocumentos(d, tracked, r, listado);
      else await revisarDespachoPdf(d, tracked, r, listado);
    } catch (e) {
      r.errores++;
      console.log(`❌ ${d.juzgado}: ${e.message}`);
    }
    await sleep(RESPIRO_MS);
  };

  // Varios juzgados a la vez (el portal es lento) y un tope de tiempo: lo que no alcance a
  // revisarse queda para la siguiente corrida (los boletines ya vistos no se repiten).
  const LIMITE_MS = 50 * 60000, CONCURRENCIA = 3, inicio = Date.now();
  const cola = [...DESPACHOS];
  await Promise.all(Array.from({ length: CONCURRENCIA }, async () => {
    while (cola.length) {
      if (Date.now() - inicio > LIMITE_MS) { console.log('⏱️ Tiempo límite: el resto de juzgados queda para la próxima corrida.'); return; }
      await procesarDespacho(cola.shift());
    }
  }));

  console.log('\n===== RESUMEN Publicaciones Procesales =====');
  console.log(`Despachos revisados : ${r.despachosRevisados}/${DESPACHOS.length}`);
  console.log(`Boletines nuevos    : ${r.estadosNuevos}`);
  console.log(`Coincidencias       : ${r.coincidencias}`);
  console.log(`Errores             : ${r.errores}`);
}

main().catch(e => { console.error(e); process.exit(1); });
