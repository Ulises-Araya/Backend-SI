const { getClient } = require('./supabaseClient');

const TABLE_TRAFFIC_EVENTS = (process.env.SUPABASE_TRAFFIC_EVENTS_TABLE || '').trim();
const TABLE_PHASE_CHANGES = process.env.SUPABASE_PHASE_CHANGES_TABLE || 'traffic_phase_changes';
const TABLE_PRESENCE_EVENTS = process.env.SUPABASE_PRESENCE_EVENTS_TABLE || 'traffic_presence_events';
const TABLE_EVENTS_SUMMARY = process.env.SUPABASE_EVENTS_SUMMARY_TABLE || 'traffic_events_summary';
const TABLE_LANES = process.env.SUPABASE_LANES_TABLE || 'lanes';
const DISABLE_SUPABASE = process.env.DISABLE_SUPABASE === 'true';
const DEFAULT_LANE_KEYS = ['north', 'south', 'east', 'west'];

async function persistTrafficEvent(event) {
  if (DISABLE_SUPABASE) {
    return { skipped: true };
  }
  const client = getClient();
  if (!client || !TABLE_TRAFFIC_EVENTS) {
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

async function persistPhaseChanges(changes = []) {
  if (DISABLE_SUPABASE) {
    return { skipped: true };
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    return { skipped: true };
  }

  const client = getClient();
  if (!client) {
    return { skipped: true };
  }

  const rows = changes.map((change) => ({
    intersection_id: change.intersectionId,
    lane_key: change.laneKey,
    previous_state: change.previousState,
    next_state: change.nextState,
    started_at: new Date(change.startedAt).toISOString(),
    ended_at: new Date(change.endedAt).toISOString(),
    duration_ms: change.durationMs,
    trigger: change.trigger ?? null,
    device_id: change.deviceId ?? null,
  }));

  const { error } = await client.from(TABLE_PHASE_CHANGES).insert(rows);

  if (error) {
    console.error('[supabase] Error guardando cambio de fase:', error);
    return { error };
  }

  return { persisted: rows.length };
}

async function persistPresenceEvents(events = []) {
  if (DISABLE_SUPABASE) {
    return { skipped: true };
  }
  if (!Array.isArray(events) || events.length === 0) {
    return { skipped: true };
  }

  const client = getClient();
  if (!client) {
    return { skipped: true };
  }

  const rows = events.map((presence) => ({
    intersection_id: presence.intersectionId,
    lane_key: presence.laneKey,
    device_id: presence.deviceId ?? null,
    detected_at: new Date(presence.detectedAt).toISOString(),
    cleared_at: presence.clearedAt ? new Date(presence.clearedAt).toISOString() : null,
    wait_ms: presence.waitMs,
    triggered_change: Boolean(presence.triggeredChange),
  }));

  const { error } = await client.from(TABLE_PRESENCE_EVENTS).insert(rows);

  if (error) {
    console.error('[supabase] Error guardando evento de presencia:', error);
    return { error };
  }

  return { persisted: rows.length };
}

async function persistTrafficSummary(summary) {
  if (DISABLE_SUPABASE) {
    return { skipped: true };
  }
  if (!summary) {
    return { skipped: true };
  }

  const client = getClient();
  if (!client) {
    return { skipped: true };
  }

  const payload = {
    id: summary.id,
    intersection_id: summary.intersectionId ?? null,
    device_id: summary.deviceId ?? null,
    state_snapshot: summary.stateSnapshot,
    evaluation: summary.evaluation ?? null,
    received_at: summary.receivedAt ? new Date(summary.receivedAt).toISOString() : new Date().toISOString(),
  };

  const { error } = await client.from(TABLE_EVENTS_SUMMARY).insert(payload);

  if (error) {
    console.error('[supabase] Error guardando snapshot de tráfico:', error);
    return { error };
  }

  return { persisted: true };
}

async function resolveLaneKeys(client, intersectionId) {
  if (!client || DISABLE_SUPABASE) {
    return [...DEFAULT_LANE_KEYS];
  }

  if (!intersectionId) {
    return [...DEFAULT_LANE_KEYS];
  }

  try {
    const { data, error } = await client
      .from(TABLE_LANES)
      .select('lane_key', { head: false })
      .eq('intersection_id', intersectionId)
      .order('lane_key', { ascending: true });

    if (!error && Array.isArray(data) && data.length > 0) {
      const unique = new Set();
      data.forEach((row) => {
        if (row?.lane_key) {
          unique.add(row.lane_key);
        }
      });
      if (unique.size > 0) {
        return Array.from(unique);
      }
    }
  } catch (laneError) {
    console.warn('[supabase] No se pudieron obtener los carriles para la intersección:', laneError);
  }

  return [...DEFAULT_LANE_KEYS];
}

async function fetchPhaseTransitionCounts({ intersectionId }) {
  const client = getClient();
  if (!client) {
    return [];
  }

  const laneKeys = await resolveLaneKeys(client, intersectionId);
  const targets = laneKeys.map((laneKey) => ({ laneKey, nextState: 'green' }));

  const results = await Promise.all(
    targets.map(async ({ laneKey, nextState }) => {
      try {
        let query = client
          .from(TABLE_PHASE_CHANGES)
          .select('id', { count: 'exact', head: true })
          .eq('lane_key', laneKey)
          .eq('next_state', nextState);

        if (intersectionId) {
          query = query.eq('intersection_id', intersectionId);
        }

        const { count, error } = await query;
        if (error) {
          console.error('[supabase] Error contando cambios de fase:', { laneKey, nextState, error });
          return null;
        }

        return {
          lane_key: laneKey,
          next_state: nextState,
          count: Number(count) || 0,
        };
      } catch (error) {
        console.error('[supabase] Error inesperado contando cambios de fase:', { laneKey, nextState, error });
        return null;
      }
    }),
  );

  return results.filter(Boolean);
}

async function fetchLaneDurations({ intersectionId, limit = 10_000 }) {
  const client = getClient();
  if (!client) {
    return [];
  }

  let builder = client
    .from(TABLE_PHASE_CHANGES)
    .select('lane_key,previous_state,next_state,duration_ms', { head: false })
    .order('ended_at', { ascending: false })
    .limit(limit);

  if (intersectionId) {
    builder = builder.eq('intersection_id', intersectionId);
  }

  const { data, error } = await builder;
  if (error) {
    console.error('[supabase] Error consultando duraciones por carril:', error);
    return [];
  }

  const byLane = new Map();

  (data ?? []).forEach((row) => {
    const lane = row.lane_key;
    const duration = Number(row.duration_ms);
    if (!lane || !Number.isFinite(duration) || duration <= 0) {
      return;
    }

    if (!byLane.has(lane)) {
      byLane.set(lane, {
        laneKey: lane,
        greenTotal: 0,
        greenCount: 0,
        redTotal: 0,
        redCount: 0,
      });
    }

    const accumulator = byLane.get(lane);

    if (row.previous_state === 'green' && row.next_state === 'red') {
      accumulator.greenTotal += duration;
      accumulator.greenCount += 1;
    } else if (row.previous_state === 'red' && row.next_state === 'green') {
      accumulator.redTotal += duration;
      accumulator.redCount += 1;
    }
  });

  return Array.from(byLane.values()).map((entry) => ({
    laneKey: entry.laneKey,
    greenMs: entry.greenCount > 0 ? entry.greenTotal / entry.greenCount : 0,
    redMs: entry.redCount > 0 ? entry.redTotal / entry.redCount : 0,
  }));
}

async function fetchPresenceSamples({ intersectionId, limit = 2_000 }) {
  const client = getClient();

async function fetchTotalTransitionsCount({ intersectionId } = {}) {
  const client = getClient();
  if (!client) {
    return 0;
  }

  try {
    let query = client
      .from(TABLE_PHASE_CHANGES)
      .select('id', { count: 'exact', head: true })
      .eq('next_state', 'green');

    if (intersectionId) {
      query = query.eq('intersection_id', intersectionId);
    }

    const { count, error } = await query;
    if (error) {
      console.error('[supabase] Error contando transiciones totales:', { intersectionId, error });
      return 0;
    }

    return Number(count) || 0;
  } catch (error) {
    console.error('[supabase] Error inesperado contando transiciones totales:', { intersectionId, error });
    return 0;
  }
}
  if (!client) {
    return [];
  }

  let builder = client
    .from(TABLE_PRESENCE_EVENTS)
    .select('lane_key,wait_ms,detected_at', { head: false })
    .order('detected_at', { ascending: false })
    .limit(limit);

  if (intersectionId) {
    builder = builder.eq('intersection_id', intersectionId);
  }

  const { data, error } = await builder;
  if (error) {
    console.error('[supabase] Error consultando eventos de presencia:', error);
    return [];
  }

  return data ?? [];
}

async function fetchGreenCycleTrend({ intersectionId, limit = 1_000 }) {
  const client = getClient();
  if (!client) {
    return [];
  }

  let builder = client
    .from(TABLE_PHASE_CHANGES)
    .select('lane_key,ended_at,duration_ms', { head: false })
    .eq('previous_state', 'green')
    .in('next_state', ['yellow', 'red'])
    .gt('duration_ms', 0)
    .order('ended_at', { ascending: false })
    .limit(limit);

  if (intersectionId) {
    builder = builder.eq('intersection_id', intersectionId);
  }

  const { data, error } = await builder;
  if (error) {
    console.error('[supabase] Error consultando tendencias de ciclos verdes:', error);
    return [];
  }

  return data ?? [];
}

module.exports = {
  persistTrafficEvent,
  persistPhaseChanges,
  persistPresenceEvents,
  persistTrafficSummary,
  fetchPhaseTransitionCounts,
  fetchLaneDurations,
  fetchPresenceSamples,
  fetchGreenCycleTrend,
  fetchTotalTransitionsCount,
};
