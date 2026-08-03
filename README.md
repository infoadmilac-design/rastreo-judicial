# Rastreo de Procesos Judiciales

Sistema para rastrear procesos en la Rama Judicial de Colombia (API oficial CPNU),
con base de datos propia, alertas automáticas 2x/día, notificaciones por WhatsApp/correo
y dashboard de control. Google Sheets queda como respaldo, no como motor.

## Estado del proyecto

- [x] **Fase 0 — Validación API** · API oficial CPNU confirmada (puerto `:448`). Ver `docs/api-cpnu.md`.
- [x] **Fase 1 — Base de datos + migración** · esquema y migración del Sheet listos.
- [x] **Fase 2 — Motor de rastreo** · worker que detecta actuaciones nuevas y crea alertas. Probado en vivo.
- [~] **Fase 3 — Automatización + notificaciones** · correo (Resend) + cron (GitHub Actions) listos. WhatsApp preparado, pendiente de cuenta Meta.
- [x] **Fase 4 — Dashboard** · panel funcional (`dashboard/`). Modo demo sin Supabase; modo real con CRUD. Probado.

**➡️ Para poner todo a funcionar, sigue [INSTRUCCIONES.md](INSTRUCCIONES.md).**

## Estructura

```
rastreo-judicial/
├── db/
│   └── schema.sql          # Esquema PostgreSQL (Supabase). Fuente de verdad.
├── migration/
│   ├── scrape.mjs          # Etapa A: baja las 6 pestañas del Sheet -> JSON crudo
│   ├── normalize.mjs       # Etapa B: limpia y normaliza -> JSON + seed.sql
│   └── output/             # (generado) datos crudos y normalizados
├── worker/
│   ├── cpnu.mjs            # Cliente del API CPNU (puerto :448, reintentos)
│   ├── rastrear.mjs        # Motor: detecta actuaciones nuevas -> alertas
│   └── .env.example        # Credenciales Supabase para modo producción
├── notify/
│   ├── plantillas.mjs      # Render de correo (HTML) y WhatsApp
│   ├── resend.mjs          # Envío de correo (Resend)
│   ├── notificar.mjs       # Toma alertas pendientes y las envía
│   └── .env.example        # Resend + buzón central
├── .github/workflows/
│   └── rastreo.yml         # Cron 2x/día (GitHub Actions, gratis)
└── README.md
```

## Cómo correr la migración

Requiere Node 18+.

```bash
cd migration
node scrape.mjs      # descarga el Sheet publicado
node normalize.mjs   # limpia y genera output/normalized/seed.sql
```

Salida en `migration/output/normalized/`:

| Archivo | Contenido |
|---|---|
| `clientes.json` | Clientes únicos (deduplicados por nombre) |
| `procesos.json` | Procesos normalizados de las 5 pestañas de procesos |
| `audiencias.json` | Agenda de AUDIENCIAS 2025 |
| `seed.sql` | INSERTs listos para cargar en Supabase |
| `_revision.json` | Filas que requieren revisión manual (basura o IDs raros) |

## Cargar en la base de datos

1. Crear proyecto en [Supabase](https://supabase.com) (gratis).
2. **Opción A (un comando):** copiar `db/.env.example` a `db/.env`, pegar tu `DATABASE_URL`, y:
   ```bash
   cd db && npm install && node load.mjs
   ```
   Crea el esquema, carga la semilla y confirma los conteos.
3. **Opción B (manual):** en el SQL Editor de Supabase, ejecutar primero `db/schema.sql` y luego `migration/output/normalized/seed.sql`.

## Motor de rastreo (Fase 2)

```bash
cd worker && npm install

# Modo prueba: sin base de datos, guarda estado local y muestra novedades
node rastrear.mjs --dry-run --limit 10

# Modo producción: contra Supabase (requiere worker/.env con SUPABASE_URL + SERVICE_KEY)
node rastrear.mjs
```

En producción, cada actuación nueva detectada se inserta en `actuaciones` y genera una
`alerta` en estado `pendiente`, lista para que la Fase 3 la envíe por WhatsApp/correo.
La detección es idempotente (por `idRegActuacion`): correrlo dos veces no duplica nada.

## Notificaciones por correo (Fase 3)

```bash
cd notify && npm install

# Prueba: no envía, genera notify/output/muestra-correo.html
node notificar.mjs --dry-run

# Producción: envía las alertas 'pendiente' al buzón central (requiere notify/.env)
node notificar.mjs
```

## Automatización 2x/día (gratis, sin servidor)

`.github/workflows/rastreo.yml` corre el worker + las notificaciones dos veces al día
(6 a.m. y 5 p.m. hora Colombia) usando GitHub Actions. Configurar en el repo de GitHub:
**Settings → Secrets and variables → Actions**, con: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
`RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_CENTRAL`.

## WhatsApp (pendiente de cuenta Meta)

El render del mensaje ya está (`notify/plantillas.mjs` → `renderAlertaWhatsapp`).
Recomendado: **WhatsApp Cloud API de Meta** (sin fee de plataforma). Cuando esté la cuenta,
se añade un `notify/whatsapp.mjs` que envía la plantilla *Utility* aprobada, análogo a `resend.mjs`.

## Resultado de la migración (última corrida)

- **231 procesos** · **202 clientes** · **56 audiencias**
- **170 procesos (74%) rastreables** por el API oficial (radicado de 23 dígitos).
- Resto: 57 números internos + 3 tutelas → recuperar radicado o buscar por nombre.
- 1 radicado con dígito de más (`110013103016...`) a corregir a mano (ver `_revision.json`).

## API oficial (dato clave)

Base URL: `https://consultaprocesos.ramajudicial.gov.co:448/api/v2`  (puerto **448**, no 443).
Header requerido: `Accept: application/json`.

- Consultar: `GET /Procesos/Consulta/NumeroRadicacion?numero={23dig}&SoloActivos=false&pagina=1`
- Actuaciones: `GET /Proceso/Actuaciones/{idProceso}?pagina=1`

Detección de cambios: comparar `fechaUltimaActuacion`; si cambió, traer actuaciones y
detectar nuevas por `idRegActuacion` / `consActuacion`.
