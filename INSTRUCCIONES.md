# 🚀 Puesta en marcha — paso a paso

Guía completa para dejar el sistema funcionando. No necesitas saber programar;
solo seguir los pasos y copiar/pegar. Tiempo estimado: **30–45 minutos**.

> **Requisito único:** tener **Node.js 18 o superior** instalado.
> Descárgalo en https://nodejs.org (botón "LTS"). Para verificar, abre una terminal
> (PowerShell) y escribe `node -v` — debe mostrar un número como `v20.x`.

---

## 🅰️ Probar el dashboard YA (sin nada más, modo demostración)

Esto funciona de inmediato con tus datos ya migrados:

```powershell
cd "C:\Users\crist\OneDrive\TRIBUNEROS\rastreo-judicial\dashboard"
node server.mjs
```

Abre en tu navegador: **http://localhost:3000**
Verás tus 231 procesos, la búsqueda, los vencimientos y las plantillas.
(En este modo es solo lectura. Para crear/editar/eliminar necesitas el paso B.)

Para detenerlo: `Ctrl + C` en la terminal.

---

## 🅱️ Sistema completo y funcional (con base de datos real)

### Paso 1 · Crear la base de datos (Supabase)  — 10 min
1. Entra a https://supabase.com y crea una cuenta gratis.
2. **New Project** → nombre `rastreo-judicial`, define y **anota la contraseña** de la base.
3. Espera ~2 min a que se cree.
4. Ve a **Settings → Database → Connection string → URI**. Copia esa línea.
5. En la carpeta `db`, copia el archivo `.env.example` como `.env` y pega ahí tu URI:
   ```
   DATABASE_URL=postgresql://postgres:TU-CONTRASEÑA@db.xxxx.supabase.co:5432/postgres
   ```
6. Carga todo (crea las tablas y sube tus 231 procesos):
   ```powershell
   cd "C:\Users\crist\OneDrive\TRIBUNEROS\rastreo-judicial\db"
   npm install
   node load.mjs
   ```
   Debe terminar con `✅ Carga completa: { procesos: 231, ... }`.

### Paso 2 · Llaves de Supabase para los programas — 3 min
1. En Supabase: **Settings → API**. Copia dos cosas:
   - **Project URL** (ej. `https://xxxx.supabase.co`)
   - **service_role key** (la secreta, sección "Project API keys").
2. Crea el archivo `.env` en las carpetas `worker`, `notify` y `dashboard`
   (usa cada `.env.example` como molde) y pega:
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_KEY=eyJ... (service_role)
   ```

### Paso 3 · Correo (Resend) — 5 min
1. Crea cuenta gratis en https://resend.com (3.000 correos/mes gratis).
2. **API Keys → Create** y copia la llave (`re_...`).
3. En `notify/.env` agrega:
   ```
   RESEND_API_KEY=re_xxxxxxxx
   EMAIL_FROM=Rastreo Judicial <onboarding@resend.dev>
   EMAIL_CENTRAL=TU-CORREO-CENTRAL@gmail.com
   ```
   `EMAIL_CENTRAL` es el buzón que recibe TODAS las alertas y reparte a los abogados.
   (Para enviar desde tu propio dominio, luego lo verificas en Resend; el `onboarding@resend.dev` sirve para empezar.)

### Paso 4 · Probar el rastreo y las alertas manualmente — 5 min
```powershell
# 1) Rastrear (registra la línea base la primera vez)
cd "C:\Users\crist\OneDrive\TRIBUNEROS\rastreo-judicial\worker"
npm install
node rastrear.mjs

# 2) Enviar por correo las alertas pendientes
cd "..\notify"
npm install
node notificar.mjs
```
La **primera** corrida solo guarda el estado actual (línea base). A partir de la
**segunda** en adelante, detecta lo nuevo y manda el correo.

### Paso 5 · Dashboard en modo real (con CRUD) — 1 min
```powershell
cd "C:\Users\crist\OneDrive\TRIBUNEROS\rastreo-judicial\dashboard"
node server.mjs
```
Ahora en http://localhost:3000 podrás **crear, editar y eliminar** procesos, y verás
los cambios y notificaciones reales.

### Paso 6 · Automatizar 2 veces al día (gratis) — 10 min
Para que corra solo sin tener tu computador prendido:
1. Crea un repositorio **privado** en https://github.com y sube esta carpeta.
2. En el repo: **Settings → Secrets and variables → Actions → New repository secret**,
   y crea estos 5 secretos (mismos valores de tus `.env`):
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_CENTRAL`.
3. Listo. El archivo `.github/workflows/rastreo.yml` ya está configurado para correr
   a las **6 a.m. y 5 p.m.** hora Colombia. Puedes probarlo a mano en la pestaña
   **Actions → Rastreo de procesos judiciales → Run workflow**.

---

## 📱 WhatsApp (cuando quieras, opcional)
Recomendado: **WhatsApp Cloud API de Meta** (sin costo de plataforma). Requiere crear
una cuenta de Meta Business y aprobar una plantilla *Utility*. Cuando la tengas, se
añade el envío por WhatsApp junto al de correo (el texto del mensaje ya está listo en
`notify/plantillas.mjs`). Avísame y lo conectamos.

---

## ❓ Problemas comunes
- **`node no se reconoce`** → falta instalar Node.js (ver arriba).
- **`Falta SUPABASE_URL`** → no creaste el `.env` en esa carpeta, o quedó mal escrito.
- **El correo no llega** → revisa spam; confirma `EMAIL_CENTRAL` y la `RESEND_API_KEY`.
- **`node load.mjs` falla** → revisa que la contraseña en `DATABASE_URL` sea la correcta.

## 🔒 Seguridad
Los archivos `.env` contienen llaves secretas. **Nunca** los subas a GitHub
(el `.gitignore` ya los excluye). El repo debe ser **privado**.
