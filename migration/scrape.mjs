// =====================================================================
//  scrape.mjs  ·  Etapa A de la migración
//  Descarga las 6 pestañas del Google Sheet publicado y las guarda
//  como JSON crudo (sin pérdida), fila por fila.
//  Uso:  node scrape.mjs
// =====================================================================
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'output');

const PUB_ID = '2PACX-1vQysekEu7C65MldBWgX8BJCqJRFBoDJ6iM9qmrfGeaWnUbtiefOMkj3p4mIZhiPJA';
const SHEET_URL = gid =>
  `https://docs.google.com/spreadsheets/d/e/${PUB_ID}/pubhtml/sheet?headers=false&gid=${gid}`;

// gid -> nombre lógico de la pestaña
export const PESTANAS = [
  { nombre: 'GENERALES',   gid: '176059664',  sede: 'generales'  },
  { nombre: 'ZIPA',        gid: '398171994',  sede: 'zipa'       },
  { nombre: 'FUSAGASUGA',  gid: '938652721',  sede: 'fusagasuga' },
  { nombre: 'ARCHIVADOS',  gid: '1500210140', sede: 'archivados' },
  { nombre: 'ALIANZA',     gid: '1241588902', sede: 'alianza'    },
  { nombre: 'AUDIENCIAS',  gid: '1212126686', sede: null         },
];

const stripTags = s =>
  s.replace(/<[^>]*>/g, '')
   .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
   .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
   .replace(/\s+/g, ' ').trim();

function parseTable(html) {
  const trs = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
  return trs.map(tr =>
    [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => stripTags(c[1]))
  );
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const resumen = [];
  for (const p of PESTANAS) {
    const url = SHEET_URL(p.gid);
    const res = await fetch(url);
    if (!res.ok) { console.error(`✗ ${p.nombre}: HTTP ${res.status}`); continue; }
    const html = await res.text();
    const rows = parseTable(html);
    // La primera columna del pubhtml es el número de fila de Google -> la quitamos
    const clean = rows.map(r => r.slice(1));
    await writeFile(join(OUT, `raw_${p.nombre}.json`),
      JSON.stringify({ pestana: p.nombre, sede: p.sede, gid: p.gid, filas: clean }, null, 2));
    const noVacias = clean.filter(r => r.some(c => c)).length;
    resumen.push({ pestana: p.nombre, filasTotales: clean.length, filasConDatos: noVacias });
    console.log(`✓ ${p.nombre.padEnd(12)} ${clean.length} filas (${noVacias} con datos)`);
  }
  await writeFile(join(OUT, '_resumen_scrape.json'), JSON.stringify(resumen, null, 2));
  console.log('\nListo. JSON crudo en migration/output/');
}

main().catch(e => { console.error(e); process.exit(1); });
