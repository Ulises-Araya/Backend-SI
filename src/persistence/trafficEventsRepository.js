const { getClient } = require('./supabaseClient');

const TABLE_TRAFFIC_EVENTS = process.env.SUPABASE_TRAFFIC_EVENTS_TABLE || 'traffic_events';

async function persistTrafficEvent(event) {
  const client = getClient();
  if (!client) {
    return { skipped: true };
  }

  const { error } = await client.from(TABLE_TRAFFIC_EVENTS).insert({
    id: event.id,
    device_id: event.deviceId,
    intersection_id: event.intersectionId,
    sensors: event.sensors,
    state_snapshot: event.stateSnapshot,
    evaluation: event.evaluation,
    ip: event.ip,
    received_at: event.receivedAt,
  });

  if (error) {
    console.error('[supabase] Error guardando evento de tráfico:', error);
    return { error };
  }

  return { persisted: true };
}

module.exports = {
  persistTrafficEvent,
};
