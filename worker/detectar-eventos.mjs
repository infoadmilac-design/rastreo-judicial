// =====================================================================
//  detectar-eventos.mjs  ·  Detecta menciones de audiencias/diligencias
//  dentro del texto de una actuación nueva, e intenta extraer fecha/hora.
//
//  Es deliberadamente conservador: si no encuentra una fecha con formato
//  claro, NO inventa nada — es mejor que el abogado la agregue a mano
//  (botón "Agregar evento") a que el calendario tenga una fecha errónea.
// =====================================================================

const PALABRAS_CLAVE = /\b(AUDIENCIA|DILIGENCIA|INSPECCI[ÓO]N JUDICIAL|INTERROGATORIO DE PARTE)\b/i;

const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

function extraerFecha(texto) {
  // "15 de agosto de 2026"
  const m1 = texto.match(/\b(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})\b/i);
  if (m1) {
    const dia = parseInt(m1[1], 10), mes = MESES[m1[2].toLowerCase()], anio = parseInt(m1[3], 10);
    if (mes && dia >= 1 && dia <= 31) return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  }
  // "15/08/2026" o "15-08-2026"
  const m2 = texto.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (m2) {
    const dia = parseInt(m2[1], 10), mes = parseInt(m2[2], 10), anio = parseInt(m2[3], 10);
    if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  }
  return null;
}

function extraerHora(texto) {
  const m = texto.match(/\b(\d{1,2}):(\d{2})\s*(a\.?\s*m\.?|p\.?\s*m\.?)?\b/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = (m[3] || '').toLowerCase().replace(/\./g, '').replace(/\s/g, '');
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}`;
}

// Devuelve { fecha, hora } si detecta una audiencia/diligencia con fecha confiable, o null.
export function detectarEvento({ tipo, anotacion }) {
  const texto = `${tipo || ''} ${anotacion || ''}`;
  if (!PALABRAS_CLAVE.test(texto)) return null;
  const fecha = extraerFecha(texto);
  if (!fecha) return null;   // sin fecha clara, no se crea el evento
  const hora = extraerHora(texto);
  return { fecha, hora };
}
