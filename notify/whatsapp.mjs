// =====================================================================
//  whatsapp.mjs  ·  Envío por WhatsApp Cloud API (Meta)
//  Necesita en el entorno:
//    WHATSAPP_TOKEN            token de acceso de la app de Meta
//    WHATSAPP_PHONE_ID         ID del número remitente (Phone number ID)
//    WHATSAPP_TEMPLATE         nombre de la plantilla aprobada (ej. novedad_proceso)
//    WHATSAPP_LANG             código de idioma de la plantilla (ej. es o es_CO)
//    WHATSAPP_CENTRAL          número que recibe las alertas (E.164, ej. 573001234567)
// =====================================================================

const API = 'https://graph.facebook.com/v21.0';

// Normaliza a formato E.164 sin '+' (lo que espera la API): 573001234567
export function normalizarNumero(n) {
  let s = String(n || '').replace(/[^\d]/g, '');
  if (s.length === 10) s = '57' + s;          // celular colombiano sin indicativo
  return s;
}

// Envía un mensaje de PLANTILLA (para mensajes que TÚ inicias).
// params = arreglo de textos que rellenan {{1}}, {{2}}, ... de la plantilla.
export async function enviarPlantilla({ to, params = [] }) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const template = process.env.WHATSAPP_TEMPLATE;
  const lang = process.env.WHATSAPP_LANG || 'es';
  if (!token || !phoneId || !template) throw new Error('Faltan WHATSAPP_TOKEN / WHATSAPP_PHONE_ID / WHATSAPP_TEMPLATE');

  const body = {
    messaging_product: 'whatsapp',
    to: normalizarNumero(to),
    type: 'template',
    template: {
      name: template,
      language: { code: lang },
      components: params.length
        ? [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t).slice(0, 900) })) }]
        : [],
    },
  };

  const r = await fetch(`${API}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`WhatsApp HTTP ${r.status}: ${JSON.stringify(j.error || j)}`);
  return j.messages?.[0]?.id;   // id del mensaje enviado
}

// Envía texto libre (solo funciona dentro de la ventana de 24h tras un mensaje del usuario).
export async function enviarTexto({ to, texto }) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const r = await fetch(`${API}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: normalizarNumero(to), type: 'text', text: { body: texto } }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`WhatsApp HTTP ${r.status}: ${JSON.stringify(j.error || j)}`);
  return j.messages?.[0]?.id;
}
