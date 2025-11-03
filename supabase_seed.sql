-- Semillas base para intersecciones y carriles
-- Ajusta los UUID si necesitas alinearlos con DEFAULT_INTERSECTION_ID

insert into public.intersections
    (
    id,
    name,
    latitude,
    longitude,
    status,
    last_seen,
    location,
    meta
    )
values
    (
        '3b95cf2f-ad00-41b0-b29e-30131e822139',
        'Cruce Principal Centro',
        9.935512,
        -84.091827,
        'operational',
        now() - interval
'3 minutes',
        '{"address":"Av. Central & Calle 1","city":"San José","country":"CR"}'::jsonb,
        '{"controllerId":"esp32-centro","lanes":["north","south","east","west"]}'::jsonb
    ),
(
        'a5c77e67-3a1b-4f9f-8de6-b0e7b2bcf102',
        'Cruce Central Parque',
        9.934215,
        -84.087912,
        'operational',
        now
() - interval '2 minutes',
        '{"address":"Parque Central","city":"San José","country":"CR"}'::jsonb,
        '{"controllerId":"esp32-parque","lanes":["north","south","east","west"]}'::jsonb
    ),
(
        '4f2cd1b3-9f44-47d6-ac5f-3f3c87b5a944',
        'Intersección Universidad Norte',
        9.998421,
        -84.111275,
        'operational',
        now
() - interval '8 minutes',
        '{"address":"Frente a UCR Sede Norte","city":"Heredia","country":"CR"}'::jsonb,
        '{"controllerId":"esp32-ucr-norte","lanes":["north","south","east","west"]}'::jsonb
    ),
(
        '3d141e5c-5e5d-4d94-bd1f-1e078e91f4de',
        'Nodo Parque Industrial',
        10.011245,
        -84.230487,
        'maintenance',
        null,
        '{"address":"Parque Industrial La Valencia","city":"Heredia","country":"CR"}'::jsonb,
        '{"controllerId":"esp32-industrial","lanes":["north","south","east","west"],"notes":"En mantenimiento por ampliación"}'::jsonb
    ),
(
        '7c68b2cb-1b59-4c0e-8de2-2ee6db7f4816',
        'Intersección Aeropuerto Sur',
        9.997102,
        -84.200311,
        'operational',
        now
() - interval '30 seconds',
        '{"address":"Ruta 1, ingreso sur SJO","city":"Alajuela","country":"CR"}'::jsonb,
        '{"controllerId":"esp32-sjo-sur","lanes":["north","south","east","west"],"notes":"Monitoreo en tiempo real"}'::jsonb
    ),
(
        'c91fdcb7-28ce-496f-a240-2ec0555d832b',
        'Cruce Hospital Metropolitano',
        9.924883,
        -84.078442,
        'stopped',
        now
() - interval '2 hours',
        '{"address":"Av. 10 & Calle 21","city":"San José","country":"CR"}'::jsonb,
        '{"controllerId":"esp32-hospital","lanes":["north","south","east","west"],"notes":"Detenido temporalmente por trabajos viales"}'::jsonb
    )
on conflict
(id) do
update
set
    name = excluded.name,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    status = excluded.status,
    last_seen = excluded.last_seen,
    location = excluded.location,
    meta = excluded.meta;

insert into public.lanes
    (
    intersection_id,
    lane_key,
    sensor_key
    )
values
    ('3b95cf2f-ad00-41b0-b29e-30131e822139', 'north', 'central-centro-north'),
    ('3b95cf2f-ad00-41b0-b29e-30131e822139', 'south', 'central-centro-south'),
    ('3b95cf2f-ad00-41b0-b29e-30131e822139', 'east', 'central-centro-east'),
    ('3b95cf2f-ad00-41b0-b29e-30131e822139', 'west', 'central-centro-west'),

    ('a5c77e67-3a1b-4f9f-8de6-b0e7b2bcf102', 'north', 'parque-north'),
    ('a5c77e67-3a1b-4f9f-8de6-b0e7b2bcf102', 'south', 'parque-south'),
    ('a5c77e67-3a1b-4f9f-8de6-b0e7b2bcf102', 'east', 'parque-east'),
    ('a5c77e67-3a1b-4f9f-8de6-b0e7b2bcf102', 'west', 'parque-west'),

    ('4f2cd1b3-9f44-47d6-ac5f-3f3c87b5a944', 'north', 'ucr-north'),
    ('4f2cd1b3-9f44-47d6-ac5f-3f3c87b5a944', 'south', 'ucr-south'),
    ('4f2cd1b3-9f44-47d6-ac5f-3f3c87b5a944', 'east', 'ucr-east'),
    ('4f2cd1b3-9f44-47d6-ac5f-3f3c87b5a944', 'west', 'ucr-west'),

    ('3d141e5c-5e5d-4d94-bd1f-1e078e91f4de', 'north', 'industrial-north'),
    ('3d141e5c-5e5d-4d94-bd1f-1e078e91f4de', 'south', 'industrial-south'),
    ('3d141e5c-5e5d-4d94-bd1f-1e078e91f4de', 'east', 'industrial-east'),
    ('3d141e5c-5e5d-4d94-bd1f-1e078e91f4de', 'west', 'industrial-west'),

    ('7c68b2cb-1b59-4c0e-8de2-2ee6db7f4816', 'north', 'sjo-north'),
    ('7c68b2cb-1b59-4c0e-8de2-2ee6db7f4816', 'south', 'sjo-south'),
    ('7c68b2cb-1b59-4c0e-8de2-2ee6db7f4816', 'east', 'sjo-east'),
    ('7c68b2cb-1b59-4c0e-8de2-2ee6db7f4816', 'west', 'sjo-west'),

    ('c91fdcb7-28ce-496f-a240-2ec0555d832b', 'north', 'hospital-north'),
    ('c91fdcb7-28ce-496f-a240-2ec0555d832b', 'south', 'hospital-south'),
    ('c91fdcb7-28ce-496f-a240-2ec0555d832b', 'east', 'hospital-east'),
    ('c91fdcb7-28ce-496f-a240-2ec0555d832b', 'west', 'hospital-west')
on conflict
(intersection_id, lane_key) do
update
set sensor_key = excluded.sensor_key;
