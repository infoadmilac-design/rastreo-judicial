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
//  a peticiones GET normales (sin sesión) con HTML que ya trae el listado
//  y los enlaces directos a los PDF de cada "Notificación por Estado".
//  Cada PDF es texto real (no escaneado), así que se puede leer con
//  pdf-parse sin necesidad de un navegador ni OCR.
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
const DESPACHOS = [
  { codigo: '258993103001', juzgado: 'JUZGADO PRIMERO CIVIL CIRCUITO DE ZIPAQUIRA' },
  { codigo: '258993103002', juzgado: 'JUZGADO SEGUNDO CIVIL CIRCUITO DE ZIPAQUIRA' },
  { codigo: '258993103003', juzgado: 'JUZGADO TERCERO CIVIL CIRCUITO DE ZIPAQUIRA' },
  { codigo: '258993110001', juzgado: 'JUZGADO PRIMERO FAMILIA DE ZIPAQUIRA' },
  { codigo: '258993110002', juzgado: 'JUZGADO SEGUNDO FAMILIA DE ZIPAQUIRA' },
  { codigo: '258994003002', juzgado: 'JUZGADO SEGUNDO MUNICIPAL DE ZIPAQUIRA' },
  { codigo: '252004089001', juzgado: 'JUZGADO PRIMERO PROMISCUO MUNICIPAL DE COGUA' },
];

const PORTLET = 'co_com_avanti_efectosProcesales_PublicacionesEfectosProcesalesPortletV2_INSTANCE_BIyXQFHVaYaq';
const ID_STRUCTURE_ESTADOS = '6098957'; // categoría fija "Notificaciones por Estados"
const BASE = 'https://publicacionesprocesales.ramajudicial.gov.co/web/publicaciones-procesales/inicio';
const RESPIRO_MS = 3000; // pausa entre despachos, mismo criterio que rastrear.mjs

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function listarPdfsEstado(idDespacho) {
  const qs = new URLSearchParams({
    p_p_id: PORTLET, p_p_lifecycle: '0', p_p_state: 'normal', p_p_mode: 'view',
    [`_${PORTLET}_idStructure`]: ID_STRUCTURE_ESTADOS,
    [`_${PORTLET}_action`]: 'filterStructures',
    [`_${PORTLET}_idDespacho`]: idDespacho,
  });
  const res = await fetch(`${BASE}?${qs}`, { headers: { 'User-Agent': 'Mozilla/5.0 (rastreo-judicial-bot)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} listando despacho ${idDespacho}`);
  const html = await res.text();
  return parsePdfUrls(html);
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

async function textoPdf(pdfUrl) {
  const res = await fetch(pdfUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (rastreo-judicial-bot)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} descargando PDF`);
  const buf = Buffer.from(await res.arrayBuffer());
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

async function main() {
  let despachosRevisados = 0, estadosNuevos = 0, coincidencias = 0, errores = 0;

  for (const d of DESPACHOS) {
    try {
      const { data: procesos, error: errProc } = await db.from('procesos')
        .select('id, origen_id_raw, demandante, demandado')
        .eq('juzgado', d.juzgado)
        .not('origen_id_raw', 'is', null);
      if (errProc) throw errProc;
      const tracked = (procesos || []).filter(p => (p.origen_id_raw || '').length >= 6);
      if (!tracked.length) { console.log(`(sin procesos) ${d.juzgado}`); continue; }

      const pdfs = await listarPdfsEstado(d.codigo);
      const { data: vistos } = await db.from('estados_pp_vistos')
        .select('file_entry_id').eq('despacho_codigo', d.codigo);
      const vistosSet = new Set((vistos || []).map(v => v.file_entry_id));
      const nuevos = pdfs.filter(p => !vistosSet.has(p.fileEntryId));

      console.log(`${d.juzgado}: ${tracked.length} proceso(s) rastreados, ${pdfs.length} boletines vistos, ${nuevos.length} nuevo(s)`);
      despachosRevisados++;

      for (const { fileEntryId, pdfUrl } of nuevos) {
        try {
          const texto = await textoPdf(pdfUrl);
          const { fecha, total } = metaPdf(texto);
          estadosNuevos++;

          for (const p of tracked) {
            if (!texto.includes(p.origen_id_raw)) continue;
            const contexto = extraerContexto(texto, p.origen_id_raw);
            const { error: errAlerta } = await db.from('alertas').insert({
              proceso_id: p.id, tipo: 'nueva_actuacion',
              titulo: `Movimiento en Publicaciones Procesales — ${p.origen_id_raw}`,
              detalle: `${contexto || ''}\n\nBoletín completo: ${pdfUrl}`.trim(),
              estado: 'pendiente',
            });
            if (errAlerta) { console.log(`   ❌ alerta ${p.origen_id_raw}: ${errAlerta.message}`); continue; }
            await db.from('procesos').update({
              ultima_actuacion_texto: contexto || null,
              fecha_ultima_actuacion: fecha || null,
            }).eq('id', p.id);
            coincidencias++;
            console.log(`   🔔 ${p.origen_id_raw}: coincidencia en boletín (fecha ${fecha}, ${total} procesos)`);
          }

          const { error: errVisto } = await db.from('estados_pp_vistos').insert({
            despacho_codigo: d.codigo, file_entry_id: fileEntryId,
            fecha_publicacion: fecha, total_procesos: total ? Number(total) : null,
          });
          if (errVisto) console.log(`   ❌ registrando visto ${fileEntryId}: ${errVisto.message}`);
        } catch (e) {
          errores++;
          console.log(`   ❌ boletín ${fileEntryId}: ${e.message}`);
        }
      }
    } catch (e) {
      errores++;
      console.log(`❌ ${d.juzgado}: ${e.message}`);
    }
    await sleep(RESPIRO_MS);
  }

  console.log('\n===== RESUMEN Publicaciones Procesales =====');
  console.log(`Despachos revisados : ${despachosRevisados}/${DESPACHOS.length}`);
  console.log(`Boletines nuevos    : ${estadosNuevos}`);
  console.log(`Coincidencias       : ${coincidencias}`);
  console.log(`Errores             : ${errores}`);
}

main().catch(e => { console.error(e); process.exit(1); });
