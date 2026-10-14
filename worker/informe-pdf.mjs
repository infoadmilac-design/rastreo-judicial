// =====================================================================
//  informe-pdf.mjs · Plantilla visual del informe diario/semanal
//  Mismo estilo del Sheet de seguimiento: celdas azul claro (#c9daf8),
//  bordes negros gruesos, encabezados en negrita y texto centrado — pero
//  con letra más grande y una franja de color arriba para que no se vea plano.
// =====================================================================
import PDFDocument from 'pdfkit';

const NAVY = '#1c4587';
const AZUL = '#c9daf8';      // el azul de las celdas del Sheet
const AZUL_2 = '#e4ecfb';    // fila alterna, un poco más clara
const NEGRO = '#000000';
const GRIS = '#555555';
const BLANCO = '#ffffff';

const W = 841.89, H = 595.28, M = 28;
const CW = W - M * 2;
const PIE = 34; // espacio reservado abajo para el pie de página

// Helvetica estándar solo dibuja WinAnsi: quita emojis y símbolos raros.
const limpiar = s => String(s ?? '').replace(/[^\n\x20-\x7E\xA0-\xFF–—‘’“”•…]/g, '').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();

export function generarPDF({ tipo, titulo, subtitulo, kpis, estadoRevision, filas, audiencias, porDia }) {
  return new Promise(resolve => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: M, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    let y = 0;

    // ---------- franja de título ----------
    doc.rect(0, 0, W, 86).fill(NAVY);
    doc.rect(0, 86, W, 5).fill(AZUL);
    doc.fillColor(BLANCO).font('Helvetica-Bold').fontSize(30).text(titulo, M, 18, { width: CW * 0.6, lineBreak: false });
    doc.font('Helvetica').fontSize(13).fillColor(AZUL).text('Legal abogados SAS  ·  Seguimiento de procesos judiciales', M, 56, { width: CW * 0.7, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(14).fillColor(BLANCO).text(limpiar(subtitulo), M, 30, { width: CW, align: 'right', lineBreak: false });
    y = 108;

    // ---------- tarjetas de resumen ----------
    const gap = 12, kw = (CW - gap * (kpis.length - 1)) / kpis.length, kh = 70;
    kpis.forEach((k, i) => {
      const x = M + i * (kw + gap);
      doc.lineWidth(2).rect(x, y, kw, kh).fillAndStroke(AZUL, NEGRO);
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(30).text(String(k.valor), x, y + 8, { width: kw, align: 'center', lineBreak: false });
      doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(11).text(k.etiqueta, x + 6, y + 46, { width: kw - 12, align: 'center', lineBreak: false });
    });
    y += kh + 12;

    if (estadoRevision) {
      doc.fillColor(GRIS).font('Helvetica').fontSize(11).text(limpiar(estadoRevision), M, y, { width: CW });
      y = doc.y + 10;
    } else y += 4;

    // ---------- utilidades de dibujo ----------
    const nuevaPagina = () => { doc.addPage(); y = M; };
    const asegurar = alto => { if (y + alto > H - PIE) nuevaPagina(); };

    const seccion = texto => {
      asegurar(26 + 28 + 40);
      doc.rect(M, y, CW, 27).fill(NAVY);
      doc.fillColor(BLANCO).font('Helvetica-Bold').fontSize(14).text(texto, M + 10, y + 7, { width: CW - 20, lineBreak: false });
      y += 27;
    };

    // cols: [{ t: 'ENCABEZADO', w: ancho, align }]   filas: [[celda|{t,bold}]]
    const tabla = (cols, rows, { size = 11 } = {}) => {
      const total = cols.reduce((s, c) => s + c.w, 0);
      const esc = CW / total;           // escala para ocupar todo el ancho útil
      const anchos = cols.map(c => c.w * esc);
      const encabezado = () => {
        let x = M;
        doc.lineWidth(2);
        cols.forEach((c, i) => {
          doc.rect(x, y, anchos[i], 36).fillAndStroke(BLANCO, NEGRO);
          doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(11);
          const h = doc.heightOfString(c.t, { width: anchos[i] - 8 });
          doc.text(c.t, x + 4, y + (36 - h) / 2, { width: anchos[i] - 8, align: 'center' });
          x += anchos[i];
        });
        y += 36;
      };
      asegurar(36 + 40);
      encabezado();
      rows.forEach((fila, ri) => {
        const celdas = fila.map(c => (typeof c === 'object' && c !== null ? c : { t: c }));
        let alto = 0;
        celdas.forEach((c, i) => {
          doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
          alto = Math.max(alto, doc.heightOfString(limpiar(c.t) || '-', { width: anchos[i] - 14 }));
        });
        alto = Math.max(34, alto + 18);
        if (y + alto > H - PIE) { nuevaPagina(); encabezado(); }
        let x = M;
        doc.lineWidth(1.5);
        celdas.forEach((c, i) => {
          doc.rect(x, y, anchos[i], alto).fillAndStroke(ri % 2 ? AZUL_2 : AZUL, NEGRO);
          const texto = limpiar(c.t) || '-';
          doc.fillColor(NEGRO).font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
          const h = doc.heightOfString(texto, { width: anchos[i] - 14 });
          doc.text(texto, x + 7, y + (alto - h) / 2, { width: anchos[i] - 14, align: cols[i].align || 'center' });
          x += anchos[i];
        });
        y += alto;
      });
      y += 16;
    };

    // ---------- contenido ----------
    if (porDia?.length) {
      seccion('RESUMEN POR DÍA');
      tabla([{ t: 'DÍA', w: 3 }, { t: 'PROCESOS CON MOVIMIENTO', w: 2 }, { t: 'MOVIMIENTOS', w: 2 }],
        porDia.map(d => [{ t: d.dia, bold: true }, String(d.procesos), String(d.movimientos)]), { size: 12 });
    }

    seccion('PROCESOS CON MOVIMIENTO');
    if (!filas.length) {
      doc.lineWidth(2).rect(M, y, CW, 70).fillAndStroke(AZUL, NEGRO);
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(18).text('Sin movimientos en este período', M, y + 25, { width: CW, align: 'center', lineBreak: false });
      y += 86;
    } else {
      tabla(
        [{ t: 'N°', w: 34 }, { t: 'ID PROCESO', w: 160 }, { t: 'CLIENTE', w: 132 }, { t: 'DEMANDADO', w: 120 }, { t: 'FECHA ACTUACIÓN', w: 100 }, { t: 'ÚLTIMA ACTUACIÓN', w: 244, align: 'left' }],
        filas.map((f, i) => [{ t: String(i + 1), bold: true }, { t: f.id, bold: true }, f.cliente, f.demandado, f.fecha, f.texto]),
        { size: 11 });
    }

    if (audiencias?.length) {
      seccion('AUDIENCIAS Y VENCIMIENTOS');
      tabla([{ t: 'FECHA', w: 80 }, { t: 'HORA', w: 70 }, { t: 'CLIENTE', w: 170 }, { t: 'DESCRIPCIÓN', w: 330, align: 'left' }],
        audiencias.map(a => [{ t: a.fecha, bold: true }, a.hora, a.cliente, a.descripcion]), { size: 11 });
    }

    // ---------- pie de página ----------
    const n = doc.bufferedPageRange().count;
    const generado = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'short' });
    for (let i = 0; i < n; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;   // evita que escribir en el pie cree una página nueva
      doc.moveTo(M, H - 28).lineTo(W - M, H - 28).lineWidth(1).strokeColor(NAVY).stroke();
      doc.fillColor(GRIS).font('Helvetica').fontSize(9)
        .text(`Generado el ${generado}  ·  Legal abogados SAS`, M, H - 22, { width: CW / 2, lineBreak: false })
        .text(`Página ${i + 1} de ${n}`, M + CW / 2, H - 22, { width: CW / 2, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}
