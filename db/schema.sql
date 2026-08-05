-- =====================================================================
--  Sistema de Rastreo de Procesos Judiciales  ·  Esquema PostgreSQL
--  Diseñado para Supabase (Postgres 15+). Fuente de verdad del sistema.
--  Google Sheets pasa a ser solo respaldo/espejo.
-- =====================================================================

-- Extensiones útiles
create extension if not exists "pgcrypto";      -- gen_random_uuid()
create extension if not exists "unaccent";      -- búsquedas sin tildes

-- ---------------------------------------------------------------------
--  Tipos enumerados
-- ---------------------------------------------------------------------
do $$ begin
  create type tipo_id_proceso as enum ('radicado_23', 'tutela', 'interno', 'otro');
exception when duplicate_object then null; end $$;

do $$ begin
  create type estado_proceso as enum ('activo', 'archivado');
exception when duplicate_object then null; end $$;

do $$ begin
  create type sede_proceso as enum ('generales', 'zipa', 'fusagasuga', 'alianza', 'archivados');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tipo_alerta as enum ('nueva_actuacion', 'vencimiento_termino', 'audiencia_proxima');
exception when duplicate_object then null; end $$;

do $$ begin
  create type estado_alerta as enum ('pendiente', 'notificada', 'descartada');
exception when duplicate_object then null; end $$;

do $$ begin
  create type canal_notificacion as enum ('whatsapp', 'email', 'interno');
exception when duplicate_object then null; end $$;

do $$ begin
  -- 'centro' = el celular central que reparte; luego 'abogado'/'cliente'
  create type destinatario_tipo as enum ('centro', 'abogado', 'cliente');
exception when duplicate_object then null; end $$;

do $$ begin
  -- De dónde viene el proceso: solo 'rama_judicial' tiene rastreo automático por API;
  -- 'superfinanciera', 'sic' y 'siugj' no tienen API pública, se hace seguimiento manual.
  -- siugj = Sistema Integrado de Gestión Judicial (juzgados que migraron a expediente
  -- electrónico, sobre todo laborales) — es un portal distinto al CPNU nacional.
  create type fuente_proceso as enum ('rama_judicial', 'superfinanciera', 'sic', 'siugj');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tipo_cliente as enum ('persona', 'empresa');
exception when duplicate_object then null; end $$;

do $$ begin
  create type estado_notificacion as enum ('pendiente', 'enviada', 'fallida');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
--  Configuración (clave/valor).  Aquí vive el número del celular central.
-- ---------------------------------------------------------------------
create table if not exists configuracion (
  clave        text primary key,
  valor        text,
  descripcion  text,
  actualizado_en timestamptz not null default now()
);
-- Semilla: número central que recibe y reparte
insert into configuracion (clave, valor, descripcion) values
  ('whatsapp_central', '',  'Número (E.164) del celular central que recibe todas las alertas y reparte a los abogados'),
  ('email_central',    '',  'Correo central que recibe copia de todas las alertas'),
  ('dias_aviso_vencimiento', '3', 'Días de anticipación para avisar un vencimiento de término')
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------
--  Personas: clientes y abogados
-- ---------------------------------------------------------------------
create table if not exists clientes (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null,
  tipo        tipo_cliente not null default 'persona',
  documento   text,
  telefono    text,
  whatsapp    text,             -- E.164, opcional (se llena con el tiempo)
  email       text,
  notas       text,
  creado_en   timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index if not exists idx_clientes_nombre on clientes using gin (to_tsvector('spanish', nombre));

create table if not exists abogados (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null,
  email       text,
  whatsapp    text,             -- E.164
  activo      boolean not null default true,
  creado_en   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  Procesos (núcleo).  Normaliza las 6 pestañas del Sheet en una tabla.
-- ---------------------------------------------------------------------
create table if not exists procesos (
  id                 uuid primary key default gen_random_uuid(),

  -- Identificación
  radicado           text,                       -- 23 dígitos si aplica
  id_cpnu            bigint,                      -- idProceso del API oficial (se llena al enriquecer)
  tipo_id            tipo_id_proceso not null default 'otro',
  origen_id_raw      text,                        -- el ID tal cual venía en el Sheet (trazabilidad)
  api_trackable      boolean not null default false, -- true si se puede rastrear por el API CPNU
  fuente             fuente_proceso not null default 'rama_judicial', -- rama_judicial | superfinanciera | sic
  jurisdiccion       text,                        -- Ordinaria, Contencioso Adm., Constitucional, etc.

  -- Partes
  cliente_id         uuid references clientes(id) on delete set null,
  abogado_id         uuid references abogados(id) on delete set null, -- asignación (reparto)
  demandante         text,
  demandado          text,
  tipo_proceso       text,                        -- usado como "especialidad" (Civil, Laboral, ...)

  -- Ubicación / despacho
  despacho           text,
  departamento       text,
  juzgado            text,
  oficina_responsable text,
  sede               sede_proceso not null default 'generales',

  -- Estado y última actuación (cache para el dashboard)
  estado             estado_proceso not null default 'activo',
  fecha_ultima_actuacion date,
  ultima_actuacion_texto text,

  -- Rastreo
  ultimo_check_en    timestamptz,                 -- última vez que se consultó el API
  hash_ultima_actuacion text,                     -- para detectar cambios rápido

  creado_en          timestamptz not null default now(),
  actualizado_en     timestamptz not null default now()
);

-- Un radicado de 23 dígitos no debería repetirse
create unique index if not exists uq_procesos_radicado
  on procesos (radicado) where radicado is not null;
create index if not exists idx_procesos_estado on procesos (estado);
create index if not exists idx_procesos_sede on procesos (sede);
create index if not exists idx_procesos_trackable on procesos (api_trackable) where api_trackable;
create index if not exists idx_procesos_abogado on procesos (abogado_id);

-- ---------------------------------------------------------------------
--  Actuaciones (historial). Motor de detección de cambios.
-- ---------------------------------------------------------------------
create table if not exists actuaciones (
  id               uuid primary key default gen_random_uuid(),
  proceso_id       uuid not null references procesos(id) on delete cascade,
  id_reg_actuacion bigint,                        -- idRegActuacion del API (único por actuación)
  cons_actuacion   integer,                       -- número de secuencia (consActuacion)
  fecha_actuacion  date,
  fecha_registro   date,
  tipo             text,                          -- "actuacion" del API (ej. Recibe memoriales)
  anotacion        text,                          -- texto completo de la novedad
  con_documentos   boolean default false,
  es_nueva         boolean not null default true, -- true hasta que se notifica
  creado_en        timestamptz not null default now()
);
-- NOTA: debe ser una restricción UNIQUE normal (no un índice parcial con WHERE),
-- porque el código usa upsert(...).onConflict('id_reg_actuacion') y Postgres solo
-- reconoce ON CONFLICT contra una unique constraint/index que cubra la columna sin
-- predicado. Un índice parcial causaba el error 42P10 y las actuaciones nunca se
-- guardaban (bug detectado y corregido 2026-08-03).
alter table actuaciones add constraint uq_actuaciones_reg unique (id_reg_actuacion);
create index if not exists idx_actuaciones_proceso on actuaciones (proceso_id, cons_actuacion desc);

-- ---------------------------------------------------------------------
--  Audiencias (de la pestaña AUDIENCIAS 2025). Alimenta agenda/vencimientos.
-- ---------------------------------------------------------------------
create table if not exists audiencias (
  id           uuid primary key default gen_random_uuid(),
  proceso_id   uuid references procesos(id) on delete set null,
  cliente_id   uuid references clientes(id) on delete set null,
  fecha        date,
  hora         text,
  descripcion  text,
  lugar        text,
  creado_en    timestamptz not null default now()
);
create index if not exists idx_audiencias_fecha on audiencias (fecha);

-- ---------------------------------------------------------------------
--  Alertas y notificaciones
-- ---------------------------------------------------------------------
create table if not exists alertas (
  id            uuid primary key default gen_random_uuid(),
  proceso_id    uuid not null references procesos(id) on delete cascade,
  actuacion_id  uuid references actuaciones(id) on delete set null,
  tipo          tipo_alerta not null,
  titulo        text,
  detalle       text,
  estado        estado_alerta not null default 'pendiente',
  creado_en     timestamptz not null default now()
);
create index if not exists idx_alertas_estado on alertas (estado, creado_en);

create table if not exists notificaciones (
  id                uuid primary key default gen_random_uuid(),
  alerta_id         uuid not null references alertas(id) on delete cascade,
  canal             canal_notificacion not null,
  destinatario_tipo destinatario_tipo not null default 'centro',
  destinatario_valor text,                        -- número o correo real usado
  destinatario_id   uuid,                          -- abogado/cliente si aplica
  cuerpo            text,
  estado            estado_notificacion not null default 'pendiente',
  proveedor_msg_id  text,                          -- id devuelto por Kapso/WhatsApp/Resend
  error             text,
  enviada_en        timestamptz,
  creado_en         timestamptz not null default now()
);
create index if not exists idx_notif_estado on notificaciones (estado, creado_en);

-- ---------------------------------------------------------------------
--  Plantillas de respuesta (para el dashboard)
-- ---------------------------------------------------------------------
create table if not exists plantillas (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null,
  canal      canal_notificacion,     -- para qué canal aplica (null = uso general)
  asunto     text,
  cuerpo     text not null,          -- soporta variables {{radicado}}, {{cliente}}, {{actuacion}}
  activa     boolean not null default true,
  creado_en  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  Trigger: mantener actualizado_en al día
-- ---------------------------------------------------------------------
create or replace function set_actualizado_en() returns trigger as $$
begin
  new.actualizado_en = now();
  return new;
end $$ language plpgsql;

drop trigger if exists trg_procesos_upd on procesos;
create trigger trg_procesos_upd before update on procesos
  for each row execute function set_actualizado_en();

drop trigger if exists trg_clientes_upd on clientes;
create trigger trg_clientes_upd before update on clientes
  for each row execute function set_actualizado_en();

-- ---------------------------------------------------------------------
--  Estado de la corrida en vivo (para el widget de progreso del dashboard)
-- ---------------------------------------------------------------------
do $$ begin
  create type estado_rastreo_run as enum ('corriendo', 'completado', 'error');
exception when duplicate_object then null; end $$;

create table if not exists rastreo_runs (
  id             uuid primary key default gen_random_uuid(),
  estado         estado_rastreo_run not null default 'corriendo',
  total          integer not null default 0,
  procesados     integer not null default 0,
  con_cambios    integer not null default 0,
  errores        integer not null default 0,
  proceso_actual text,                 -- radicado que se está consultando ahora mismo
  iniciado_en    timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  terminado_en   timestamptz
);
create index if not exists idx_rastreo_runs_iniciado on rastreo_runs (iniciado_en desc);

-- ---------------------------------------------------------------------
--  Vistas útiles para el dashboard
-- ---------------------------------------------------------------------
-- Procesos con su última actuación y abogado asignado
create or replace view v_procesos_dashboard as
select
  p.id, p.radicado, p.tipo_id, p.api_trackable, p.estado, p.sede,
  c.nombre  as cliente,
  a.nombre  as abogado,
  p.demandado, p.despacho, p.departamento,
  p.fecha_ultima_actuacion, p.ultima_actuacion_texto,
  p.ultimo_check_en
from procesos p
left join clientes c on c.id = p.cliente_id
left join abogados a on a.id = p.abogado_id;

-- Alertas pendientes de notificar
create or replace view v_alertas_pendientes as
select al.*, p.radicado, c.nombre as cliente
from alertas al
join procesos p on p.id = al.proceso_id
left join clientes c on c.id = p.cliente_id
where al.estado = 'pendiente'
order by al.creado_en desc;
