const { getClient } = require('./supabaseClient');

const TABLE_INTERSECTIONS = process.env.SUPABASE_INTERSECTIONS_TABLE || 'intersections';
const DISABLE_SUPABASE = process.env.DISABLE_SUPABASE === 'true';

const INTERSECTION_STATUSES = ['operational', 'maintenance', 'stopped'];

function ensureClient({ requireWrite = false } = {}) {
  if (DISABLE_SUPABASE && requireWrite) {
    return { client: null, reason: 'disabled' };
  }

  const client = getClient();
  if (!client || !TABLE_INTERSECTIONS) {
    return { client: null, reason: 'missing-config' };
  }

  return { client, reason: null };
}

async function listIntersections(filters = {}) {
  const { client } = ensureClient();
  if (!client) {
    return { data: [], error: null, skipped: true };
  }

  let query = client.from(TABLE_INTERSECTIONS).select('*').order('updated_at', { ascending: false });

  if (filters.status && INTERSECTION_STATUSES.includes(filters.status)) {
    query = query.eq('status', filters.status);
  }

  if (filters.ids && Array.isArray(filters.ids) && filters.ids.length > 0) {
    query = query.in('id', filters.ids);
  }

  const { data, error } = await query;
  return { data: data ?? [], error: error ?? null, skipped: false };
}

async function getIntersectionById(id) {
  const { client } = ensureClient();
  if (!client) {
    return { data: null, error: null, skipped: true };
  }

  const { data, error } = await client
    .from(TABLE_INTERSECTIONS)
    .select('*')
    .eq('id', id)
    .maybeSingle();

  return { data: data ?? null, error: error ?? null, skipped: false };
}

async function createIntersection(payload) {
  const { client, reason } = ensureClient({ requireWrite: true });
  if (!client) {
    return { data: null, error: null, skipped: true, reason };
  }

  const insertPayload = {
    name: payload.name,
    status: INTERSECTION_STATUSES.includes(payload.status) ? payload.status : 'operational',
    latitude: payload.latitude ?? null,
    longitude: payload.longitude ?? null,
    location: payload.location ?? null,
    meta: {
      ...(payload.meta || {}),
      lanes: ['north', 'south', 'east', 'west']
    },
  };

  const { data, error } = await client
    .from(TABLE_INTERSECTIONS)
    .insert(insertPayload)
    .select()
    .maybeSingle();

  if (error || !data) {
    return { data: data ?? null, error: error ?? null, skipped: false };
  }

  // Create default lanes for the new intersection
  const defaultLanes = [
    { lane_key: 'north', sensor_key: 'sensor1' },
    { lane_key: 'west', sensor_key: 'sensor2' },
    { lane_key: 'south', sensor_key: 'sensor3' },
    { lane_key: 'east', sensor_key: 'sensor4' },
  ];

  const lanesPayload = defaultLanes.map(lane => ({
    intersection_id: data.id,
    lane_key: lane.lane_key,
    sensor_key: lane.sensor_key,
  }));

  const { error: lanesError } = await client
    .from('lanes')
    .insert(lanesPayload);

  if (lanesError) {
    console.error('Error creating lanes for intersection:', lanesError);
    // Don't fail the intersection creation if lanes fail, but log it
  }

  return { data: data ?? null, error: error ?? null, skipped: false };
}

async function updateIntersectionStatus(id, status) {
  if (!INTERSECTION_STATUSES.includes(status)) {
    throw new Error(`Estado de intersección no soportado: ${status}`);
  }

  const { client, reason } = ensureClient({ requireWrite: true });
  if (!client) {
    return { data: null, error: null, skipped: true, reason };
  }

  const { data, error } = await client
    .from(TABLE_INTERSECTIONS)
    .update({ status })
    .eq('id', id)
    .select()
    .maybeSingle();

  return { data: data ?? null, error: error ?? null, skipped: false };
}

async function updateIntersectionCoords(id, latitude, longitude) {
  const { client, reason } = ensureClient({ requireWrite: true });
  if (!client) {
    return { data: null, error: null, skipped: true, reason };
  }

  const { data, error } = await client
    .from(TABLE_INTERSECTIONS)
    .update({ latitude, longitude })
    .eq('id', id)
    .select()
    .maybeSingle();

  return { data: data ?? null, error: error ?? null, skipped: false };
}

async function touchIntersection(id, fields = {}) {
  const { client, reason } = ensureClient({ requireWrite: true });
  if (!client) {
    return { data: null, error: null, skipped: true, reason };
  }

  const { data, error } = await client
    .from(TABLE_INTERSECTIONS)
    .upsert({ id, ...fields }, { onConflict: 'id' })
    .select()
    .maybeSingle();

  return { data: data ?? null, error: error ?? null, skipped: false };
}

module.exports = {
  INTERSECTION_STATUSES,
  listIntersections,
  getIntersectionById,
  createIntersection,
  updateIntersectionStatus,
  updateIntersectionCoords,
  touchIntersection,
};
