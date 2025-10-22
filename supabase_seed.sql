-- Semilla para la intersección principal y sus carriles
-- Reemplaza el UUID si usas otro valor distinto en DEFAULT_INTERSECTION_ID
insert into public.intersections
    (id, name, latitude, longitude)
values
    ('3b95cf2f-ad00-41b0-b29e-30131e822139', 'Cruce principal', 0, 0)
ON CONFLICT
(id) DO
UPDATE
SET name = excluded.name,
    latitude = excluded.latitude,
    longitude = excluded.longitude;

-- Define los carriles/sensores mapeados por el TrafficController por defecto
insert into public.lanes
    (intersection_id, lane_key, sensor_key)
values
    ('3b95cf2f-ad00-41b0-b29e-30131e822139', 'north', 'sensor1'),
    ('3b95cf2f-ad00-41b0-b29e-30131e822139', 'west', 'sensor2'),
    ('3b95cf2f-ad00-41b0-b29e-30131e822139', 'south', 'sensor3'),
    ('3b95cf2f-ad00-41b0-b29e-30131e822139', 'east', 'sensor4')
ON CONFLICT
(intersection_id, lane_key) DO
UPDATE
SET sensor_key = excluded.sensor_key;
