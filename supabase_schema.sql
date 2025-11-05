-- Extensiones necesarias (habilita generador de UUIDs aleatorios)
create extension
if not exists "pgcrypto";

-- Catálogo de intersecciones (una fila basta en la maqueta, pero permite escalar)
create table
if not exists public.intersections
(
  id uuid primary key default gen_random_uuid
(),
  name text not null,
  latitude numeric
(9,6),
  longitude numeric
(9,6),
  created_at timestamptz not null default now
()
);

-- Opcional: detallar cada carril/sensor asociado a la intersección
create table
if not exists public.lanes
(
  id uuid primary key default gen_random_uuid
(),
  intersection_id uuid not null references public.intersections
(id) on
delete cascade,
  lane_key text
not null,
  sensor_key text,
  created_at timestamptz not null default now
(),
  unique
(intersection_id, lane_key)
);

-- Tabla de eventos crudos recibidos desde el backend HTTP
create table
if not exists public.traffic_events
(
  id uuid primary key,
  intersection_id uuid references public.intersections
(id) on
delete
set null
,
  device_id text not null,
  state_snapshot jsonb not null,
  evaluation jsonb,
  sensors jsonb not null,
  ip text,
  received_at timestamptz not null default now
(),
  inserted_at timestamptz not null default now
()
);

-- Tabla con los cambios de fase generados por el controlador
create table
if not exists public.traffic_phase_changes
(
  id uuid primary key default gen_random_uuid
(),
  intersection_id uuid not null references public.intersections
(id) on
delete cascade,
  lane_key text
not null,
  previous_state text not null,
  next_state text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  duration_ms integer,
  trigger text,
  device_id text,
  created_at timestamptz not null default now
()
);

-- Tabla con los eventos de presencia de vehículos
create table
if not exists public.traffic_presence_events
(
  id uuid primary key default gen_random_uuid
(),
  intersection_id uuid not null references public.intersections
(id) on
delete cascade,
  lane_key text
not null,
  device_id text,
  detected_at timestamptz not null,
  cleared_at timestamptz,
  wait_ms integer,
  triggered_change boolean not null default false,
  created_at timestamptz not null default now
()
);

-- Tabla opcional con lecturas agregadas tipo snapshot general
create table
if not exists public.traffic_events_summary
(
  id uuid primary key,
  intersection_id uuid references public.intersections
(id) on
delete
set null
,
  device_id text not null,
  state_snapshot jsonb not null,
  evaluation jsonb,
  received_at timestamptz not null default now
()
);

-- Índices sugeridos para consultas analíticas frecuentes
create index
if not exists idx_intersections_name on public.intersections
(name);
create index
if not exists idx_traffic_events_received_at on public.traffic_events
(received_at);
create index
if not exists idx_phase_changes_intersection_started on public.traffic_phase_changes
(intersection_id, started_at);
create index
if not exists idx_presence_events_intersection_detected on public.traffic_presence_events
(intersection_id, detected_at);

create or replace function public.get_phase_transition_counts
(intersection_uuid uuid default null)
returns table
(
  lane_key text,
  next_state text,
  transition_count bigint
)
language sql
stable
as
$$
select
  lane_key,
  next_state,
  count(*)
::bigint as transition_count
  from public.traffic_phase_changes
  where next_state is not null
    and
(intersection_uuid is null or intersection_id = intersection_uuid)
  group by lane_key, next_state
  order by lane_key, next_state;
$$;

-- Campos extendidos para catálogo de intersecciones
alter table
if exists public.intersections
add column
if not exists status text not null default 'operational';

alter table
if exists public.intersections
add column
if not exists last_seen timestamptz;

alter table
if exists public.intersections
add column
if not exists location jsonb;

alter table
if exists public.intersections
add column
if not exists meta jsonb;

alter table
if exists public.intersections
add column
if not exists updated_at timestamptz not null default now
();

create or replace function public.set_updated_at_timestamp
()
returns trigger as
$$
begin
  new.updated_at := now
();
return new;
end;
$$ language plpgsql;

drop trigger if exists trg_intersections_set_updated_at
on public.intersections;
create trigger trg_intersections_set_updated_at
before
update on public.intersections
for each row
execute function
public.set_updated_at_timestamp
();
