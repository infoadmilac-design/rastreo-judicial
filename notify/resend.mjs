// =====================================================================
//  resend.mjs  ·  Envío de correo vía Resend (https://resend.com)
//  Necesita RESEND_API_KEY y EMAIL_FROM en el entorno.
// =====================================================================
export async function enviarEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'Rastreo Judicial <onboarding@resend.dev>';
  if (!key) throw new Error('Falta RESEND_API_KEY');

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, html, text }),
  });
  if (!r.ok) throw new Error(`Resend HTTP ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.id;   // id del correo enviado
}
