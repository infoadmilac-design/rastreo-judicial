// =====================================================================
//  cpnu.mjs  ·  Cliente del API oficial de la Rama Judicial (CPNU v2)
//  OJO: corre en el puerto :448, no en 443. Requiere Accept: application/json.
// =====================================================================

const BASE = 'https://consultaprocesos.ramajudicial.gov.co:448/api/v2';
const HEADERS = { 'Accept': 'application/json' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// fetch con reintentos y backoff (el servidor a veces responde 429/5xx)
async function getJSON(url, { reintentos = 3 } = {}) {
  let err;
  for (let i = 0; i < reintentos; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.status === 429 || r.status >= 500) { await sleep(1000 * (i + 1)); continue; }
      if (!r.ok) {
        // La API suele devolver un mensaje útil en el cuerpo (ej. "sé más específico")
        const cuerpo = await r.json().catch(() => null);
        throw new Error(cuerpo?.Message || cuerpo?.message || `HTTP ${r.status}`);
      }
      return await r.json();
    } catch (e) { err = e; await sleep(600 * (i + 1)); }
  }
  throw err || new Error('sin respuesta');
}

// 1) Buscar por número de radicación (23 dígitos). Devuelve el primer proceso o null.
export async function consultarPorRadicado(radicado) {
  const url = `${BASE}/Procesos/Consulta/NumeroRadicacion?numero=${encodeURIComponent(radicado)}&SoloActivos=false&pagina=1`;
  const j = await getJSON(url);
  const p = j?.procesos?.[0];
  if (!p) return null;
  return {
    idProceso: p.idProceso,
    radicado: p.llaveProceso,
    despacho: p.despacho,
    departamento: p.departamento,
    fechaUltimaActuacion: p.fechaProceso ? (p.fechaUltimaActuacion || null) : (p.fechaUltimaActuacion || null),
    sujetos: p.sujetosProcesales,
    esPrivado: p.esPrivado,
  };
}

// 2) Buscar por nombre / razón social (para procesos sin radicado de 23 díg.)
export async function consultarPorNombre(nombre) {
  const url = `${BASE}/Procesos/Consulta/NombreRazonSocial?nombre=${encodeURIComponent(nombre)}&tipoPersona=nat&SoloActivos=false&pagina=1`;
  const j = await getJSON(url);
  return j?.procesos || [];
}

// 3) Traer TODAS las actuaciones de un proceso (paginado). Orden: más reciente primero.
export async function obtenerActuaciones(idProceso, { max = 200 } = {}) {
  const first = await getJSON(`${BASE}/Proceso/Actuaciones/${idProceso}?pagina=1`);
  let actuaciones = first?.actuaciones || [];
  const paginas = first?.paginacion?.cantidadPaginas || 1;
  for (let p = 2; p <= paginas && actuaciones.length < max; p++) {
    const j = await getJSON(`${BASE}/Proceso/Actuaciones/${idProceso}?pagina=${p}`);
    actuaciones = actuaciones.concat(j?.actuaciones || []);
    await sleep(300);
  }
  return actuaciones.map(a => ({
    idRegActuacion: a.idRegActuacion,
    consActuacion: a.consActuacion,
    fechaActuacion: a.fechaActuacion ? a.fechaActuacion.slice(0, 10) : null,
    fechaRegistro: a.fechaRegistro ? a.fechaRegistro.slice(0, 10) : null,
    tipo: (a.actuacion || '').trim(),
    anotacion: (a.anotacion || '').trim(),
    conDocumentos: !!a.conDocumentos,
  }));
}

export { sleep };
