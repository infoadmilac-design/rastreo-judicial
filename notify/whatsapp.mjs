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

// Sube un archivo a WhatsApp (queda alojado en los servidores de Meta, no
// depende de que nuestro dashboard esté despierto) y devuelve su media id.
export async function subirMedia({ buffer, filename, mimeType }) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) throw new Error('Faltan WHATSAPP_TOKEN / WHATSAPP_PHONE_ID');

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([buffer], { type: mimeType }), filename);

  const r = await fetch(`${API}/${phoneId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`WhatsApp HTTP ${r.status} subiendo archivo: ${JSON.stringify(j.error || j)}`);
  return j.id;   // media id
}

// Envía un mensaje de PLANTILLA con encabezado de documento (adjunto real,
// no un enlace). `params` rellena el cuerpo {{1}}, {{2}}, ... igual que
// enviarPlantilla; `mediaId` viene de subirMedia().
export async function enviarPlantillaConDocumento({ to, mediaId, filename, params = [] }) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  // No es secreto (es solo el nombre de la plantilla aprobada en Meta), así
  // que trae un default y no hace falta configurar un secret nuevo en CI.
  const template = process.env.WHATSAPP_TEMPLATE_DOCUMENTO || 'informe_procesos';
  const lang = process.env.WHATSAPP_LANG || 'es';
  if (!token || !phoneId) throw new Error('Faltan WHATSAPP_TOKEN / WHATSAPP_PHONE_ID');

  const body = {
    messaging_product: 'whatsapp',
    to: normalizarNumero(to),
    type: 'template',
    template: {
      name: template,
      language: { code: lang },
      components: [
        { type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename } }] },
        ...(params.length ? [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t).slice(0, 900) })) }] : []),
      ],
    },
  };

  const r = await fetch(`${API}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`WhatsApp HTTP ${r.status}: ${JSON.stringify(j.error || j)}`);
  return j.messages?.[0]?.id;
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
