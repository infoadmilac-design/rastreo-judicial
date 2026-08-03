// =====================================================================
//  recuperar-radicados.mjs
//  Intenta recuperar el radicado de 23 dígitos de los procesos que en la
//  base quedaron como 'interno' / 'tutela' / 'otro' (sin radicado directo).
//  Estrategia: buscar por NOMBRE del cliente en el API CPNU y proponer
//  candidatos. NO asigna automáticamente (los nombres son ambiguos): deja
//  un informe para revisión/confirmación manual.
//
//  Uso:  node recuperar-radicados.mjs
//  Salida: worker/output/radicados-candidatos.json  +  resumen en consola
// =====================================================================
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sleep } from './cpnu.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://consultaprocesos.ramajudicial.gov.co:448/api/v2';
const PAUSA = 500;

// Limpia el nombre del cliente (quita despacho pegado, se queda con las primeras palabras tipo nombre)
function limpiarNombre(raw) {
  if (!raw) return '';
  let s = raw.toUpperCase();
  // corta cuando aparecen palabras típicas de despacho/juzgado
  s = s.split(/\b(JUZGADO|TRIBUNAL|CONSEJO|CORTE|DESPACHO|SECCI[OÓ]N|SALA)\b/)[0];
  return s.replace(/\s+/g, ' ').trim();
}

async function buscarPorNombre(nombre) {
  const url = `${BASE}/Procesos/Consulta/NombreRazonSocial?nombre=${encodeURIComponent(nombre)}&tipoPersona=nat&SoloActivos=false&pagina=1`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.procesos || []).map(p => ({
      idProceso: p.idProceso, radicado: p.llaveProceso, despacho: p.despacho,
      departamento: p.departamento, fechaUltimaActuacion: p.fechaUltimaActuacion,
      sujetos: (p.sujetosProcesales || '').slice(0, 120),
    }));
  } catch { return []; }
}

async function main() {
  const procPath = join(__dirname, '..', 'migration', 'output', 'normalized', 'procesos.json');
  const cliPath = join(__dirname, '..', 'migration', 'output', 'normalized', 'clientes.json');
  const procesos = JSON.parse(await readFile(procPath, 'utf8'));
  const clientes = new Map(JSON.parse(await readFile(cliPath, 'utf8')).map(c => [c.id, c.nombre]));

  const objetivo = procesos.filter(p => !p.api_trackable && p.cliente_id);
  console.log(`\n🔎 Recuperando radicados de ${objetivo.length} procesos sin radicado directo…\n`);

  const resultados = [];
  let conCandidatos = 0, sinResultados = 0;
  for (const p of objetivo) {
    const nombre = limpiarNombre(clientes.get(p.cliente_id));
    if (!nombre || nombre.length < 6) { sinResultados++; continue; }
    const cands = await buscarPorNombre(nombre);
    if (cands.length) {
      conCandidatos++;
      console.log(`   • ${p.origen_id_raw} (${nombre.slice(0, 30)}) → ${cands.length} candidato(s)`);
      if (cands[0]) console.log(`        p. ej. ${cands[0].radicado} — ${(cands[0].despacho || '').slice(0, 45)}`);
    } else {
      sinResultados++;
    }
    resultados.push({ origen_id_raw: p.origen_id_raw, tipo_id: p.tipo_id, nombreBuscado: nombre, candidatos: cands });
    await sleep(PAUSA);
  }

  const out = join(__dirname, 'output');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'radicados-candidatos.json'), JSON.stringify(resultados, null, 2));

  console.log(`\n===== RESUMEN =====`);
  console.log(`Procesos consultados : ${objetivo.length}`);
  console.log(`Con candidatos       : ${conCandidatos}`);
  console.log(`Sin resultados       : ${sinResultados}`);
  console.log(`Informe en           : worker/output/radicados-candidatos.json`);
  console.log(`(Revisa y confirma cada candidato antes de asignarlo — los nombres pueden repetirse.)`);
}

main().catch(e => { console.error(e); process.exit(1); });
