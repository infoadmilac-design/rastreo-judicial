// =====================================================================
//  probar-whatsapp.mjs  ·  Envía un WhatsApp de prueba al número central
//  Uso:  node --env-file=.env probar-whatsapp.mjs
//  (Requiere WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_TEMPLATE,
//   WHATSAPP_LANG y WHATSAPP_CENTRAL en notify/.env)
// =====================================================================
import { enviarPlantilla, normalizarNumero } from './whatsapp.mjs';

const central = process.env.WHATSAPP_CENTRAL;
if (!central) { console.error('Falta WHATSAPP_CENTRAL en .env'); process.exit(1); }

console.log('Enviando plantilla de prueba a', normalizarNumero(central), '…');
try {
  // Ajusta los parámetros según las variables {{1}},{{2}},{{3}} de tu plantilla
  const id = await enviarPlantilla({
    to: central,
    params: ['25000233600020210033100', 'ALFREDO GARZON NIÑO', 'Recibe memoriales (24/07/2026)'],
  });
  console.log('✅ Enviado. ID del mensaje:', id);
  console.log('Revisa tu WhatsApp en el número central.');
} catch (e) {
  console.error('❌ Error:', e.message);
  process.exit(1);
}
