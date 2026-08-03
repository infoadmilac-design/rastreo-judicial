// =====================================================================
//  plantillas.mjs  ·  Render de mensajes (correo y WhatsApp)
//  Variables soportadas: {{radicado}}, {{cliente}}, {{despacho}}, {{actuaciones}}
// =====================================================================

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fdate = s => {
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
};

// ---- Correo (HTML + texto plano) ----
export function renderAlertaEmail({ radicado, cliente, despacho, actuaciones = [] }) {
  const subject = `🔔 Novedad en proceso ${radicado}${cliente ? ' — ' + cliente : ''}`;

  const filas = actuaciones.map(a => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;white-space:nowrap;color:#555;font-size:13px;">${fdate(a.fechaActuacion)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;">
        <strong style="color:#1a3c6e;font-size:14px;">${esc(a.tipo)}</strong><br>
        <span style="color:#444;font-size:13px;">${esc(a.anotacion).slice(0, 400)}</span>
      </td>
    </tr>`).join('');

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e5e5;border-radius:10px;overflow:hidden;">
    <div style="background:#1a3c6e;color:#fff;padding:16px 20px;">
      <div style="font-size:18px;font-weight:bold;">Novedad en proceso judicial</div>
      <div style="font-size:13px;opacity:.85;">Rastreo automático · Rama Judicial</div>
    </div>
    <div style="padding:20px;">
      <table style="width:100%;font-size:14px;color:#333;margin-bottom:14px;">
        <tr><td style="padding:3px 0;width:120px;color:#888;">Radicado</td><td style="font-weight:bold;">${esc(radicado)}</td></tr>
        ${cliente ? `<tr><td style="padding:3px 0;color:#888;">Cliente</td><td>${esc(cliente)}</td></tr>` : ''}
        ${despacho ? `<tr><td style="padding:3px 0;color:#888;">Despacho</td><td>${esc(despacho)}</td></tr>` : ''}
      </table>
      <div style="font-size:14px;font-weight:bold;color:#1a3c6e;margin:6px 0 8px;">
        ${actuaciones.length} actuación(es) nueva(s):
      </div>
      <table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:6px;">${filas}</table>
      <div style="margin-top:18px;padding:12px;background:#f6f8fb;border-radius:6px;font-size:13px;color:#555;">
        Revisar y asignar al abogado responsable. Este es un aviso automático generado por el sistema de rastreo.
      </div>
    </div>
  </div>`;

  const text = [
    `NOVEDAD EN PROCESO ${radicado}`,
    cliente ? `Cliente: ${cliente}` : '',
    despacho ? `Despacho: ${despacho}` : '',
    ``,
    `${actuaciones.length} actuación(es) nueva(s):`,
    ...actuaciones.map(a => `- [${fdate(a.fechaActuacion)}] ${a.tipo}: ${a.anotacion.slice(0, 300)}`),
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

// ---- WhatsApp (texto para plantilla Utility de Meta) ----
// La plantilla real se aprueba en Meta; aquí armamos el cuerpo con variables.
export function renderAlertaWhatsapp({ radicado, cliente, actuaciones = [] }) {
  const a = actuaciones[0] || {};
  return (
    `🔔 *Novedad en proceso judicial*\n\n` +
    `Radicado: ${radicado}\n` +
    (cliente ? `Cliente: ${cliente}\n` : '') +
    `\n*${a.tipo || 'Actuación'}* (${fdate(a.fechaActuacion)})\n` +
    `${(a.anotacion || '').slice(0, 250)}\n` +
    (actuaciones.length > 1 ? `\n(+${actuaciones.length - 1} actuación/es más)` : '')
  );
}
