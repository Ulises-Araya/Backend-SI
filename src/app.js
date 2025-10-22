const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');
const TrafficController = require('./trafficController');
const {
  persistTrafficEvent,
  persistPhaseChanges,
  persistPresenceEvents,
  persistTrafficSummary,
  fetchPhaseTransitionCounts,
  fetchLaneDurations,
  fetchPresenceSamples,
  fetchGreenCycleTrend,
} = require('./persistence/trafficEventsRepository');

const trafficController = new TrafficController();
const sseClients = new Set();
const TICK_INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS ?? 250) || 250;
const DEFAULT_INTERSECTION_ID = process.env.DEFAULT_INTERSECTION_ID ?? 'default';
const SYSTEM_DEVICE_ID = process.env.SYSTEM_DEVICE_ID ?? null;
const GREEN_TREND_BUCKET_MS = Number(process.env.GREEN_TREND_BUCKET_MS ?? 10_000) || 10_000;

// Estado de conexiones
let databaseConnected = false;
let esp32Connected = false;

// Función para verificar conexión a base de datos
async function checkDatabaseConnection() {
  try {
    const client = require('./persistence/supabaseClient').getClient();
    if (!client) {
      databaseConnected = false;
      return;
    }
    
    // Intentar una consulta simple para verificar conexión
    const { error } = await client.from('traffic_events').select('count').limit(1);
    databaseConnected = !error;
  } catch (error) {
    databaseConnected = false;
  }
}

// Función helper para obtener estado con información de conexiones
function getTrafficStateWithConnections() {
  return trafficController.getState({
    databaseConnected,
    esp32Connected,
  });
}

const trafficTickTimer = setInterval(async () => {
  try {
    // Verificar conexión a base de datos periódicamente
    await checkDatabaseConnection();
    
    const transitions = trafficController.tick();
    const phaseChanges = collapsePhaseChanges(transitions);
    if (phaseChanges.length) {
      console.debug('[traffic] transitions', phaseChanges);

      try {
        await persistPhaseChanges(
          phaseChanges.map((change) => ({
            intersectionId: DEFAULT_INTERSECTION_ID,
            laneKey: change.laneId,
            previousState: change.previousState,
            nextState: change.nextState,
            startedAt: change.startedAt,
            endedAt: change.endedAt,
            durationMs: change.durationMs,
            trigger: change.reason ?? null,
            deviceId: SYSTEM_DEVICE_ID,
          })),
        );
      } catch (error) {
        console.error('[supabase] Error guardando cambios de fase en tick:', error);
      }

      try {
        await persistTrafficSummary({
          id: randomUUID(),
          intersectionId: DEFAULT_INTERSECTION_ID,
          deviceId: SYSTEM_DEVICE_ID,
          stateSnapshot: getTrafficStateWithConnections(),
          evaluation: phaseChanges,
          receivedAt: new Date().toISOString(),
        });
      } catch (error) {
        console.error('[supabase] Error guardando snapshot de tick:', error);
      }
    }
  } catch (error) {
    console.error('[traffic] Error en ciclo de tick:', error);
  }
}, TICK_INTERVAL_MS);

if (typeof trafficTickTimer.unref === 'function') {
  trafficTickTimer.unref();
}

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('[ws] Client connected');
  esp32Connected = true;
  ws.send(JSON.stringify(getTrafficStateWithConnections()));

  ws.on('close', () => {
    console.log('[ws] Client disconnected');
    // Verificar si aún hay otros clientes conectados
    setTimeout(() => {
      esp32Connected = wss.clients.size > 0;
    }, 100);
  });
});

trafficController.on('state', (state) => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(getTrafficStateWithConnections()));
    }
  });
});

const DEFAULT_BATCH_SPREAD_WINDOW_MS = Number(process.env.BATCH_SPREAD_WINDOW_MS ?? 1000);

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(data);
  }
}

function collapsePhaseChanges(transitions = []) {
  if (!Array.isArray(transitions) || transitions.length === 0) {
    return [];
  }

  const pendingGreen = new Map();
  const collapsed = [];

  transitions.forEach((change) => {
    if (!change || change.type !== 'phase-change') {
      return;
    }

    if (change.previousState === 'green' && change.nextState === 'yellow') {
      pendingGreen.set(change.laneId, change);
      return;
    }

    if (change.previousState === 'yellow' && change.nextState === 'red') {
      const queued = pendingGreen.get(change.laneId);
      if (queued) {
        const startedAt = queued.startedAt;
        const endedAt = change.endedAt;
        collapsed.push({
          type: 'phase-change',
          laneId: change.laneId,
          previousState: 'green',
          nextState: 'red',
          startedAt,
          endedAt,
          durationMs: Math.max(0, endedAt - startedAt),
          reason: queued.reason ?? change.reason ?? null,
        });
        pendingGreen.delete(change.laneId);
        return;
      }
      collapsed.push({
        ...change,
        previousState: 'green',
        durationMs: Math.max(0, change.durationMs ?? 0),
      });
      return;
    }

    if (
      (change.previousState === 'red' && change.nextState === 'green') ||
      (change.previousState === 'green' && change.nextState === 'red')
    ) {
      collapsed.push(change);
    }
  });

  return collapsed;
}

trafficController.on('state', (state) => {
  broadcast('traffic-state', state);
});

async function processTrafficEvent(payload = {}, context = {}) {
  const { deviceId, sensors, intersectionId, timestamp, processedAt } = payload;
  const normalizedIntersectionId = intersectionId ?? DEFAULT_INTERSECTION_ID;

  if (!deviceId || typeof sensors !== 'object' || sensors === null) {
    const error = new Error('Se requieren los campos deviceId y sensors.');
    error.statusCode = 400;
    throw error;
  }

  const eventPayload = {
    deviceId,
    intersectionId: normalizedIntersectionId,
    sensors,
    timestamp: Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now(),
  };

  if (Number.isFinite(Number(processedAt))) {
    eventPayload.processedAt = Number(processedAt);
  }

  const result = trafficController.ingestEvent(eventPayload);
  const phaseChanges = collapsePhaseChanges(
    Array.isArray(result?.evaluation)
      ? result.evaluation.filter((item) => item && item.type === 'phase-change')
      : [],
  );
  const presenceEvents = Array.isArray(result?.presenceEvents) ? result.presenceEvents : [];

  const receivedAt = new Date().toISOString();
  const eventId = randomUUID();

  let persistence = { skipped: true };
  try {
    const persistenceResult = await persistTrafficEvent({
      id: eventId,
      deviceId,
    intersectionId: normalizedIntersectionId,
      sensors,
      stateSnapshot: result.state,
      evaluation: result.evaluation,
      ip: context.ip ?? null,
      transport: context.transport ?? 'http',
      receivedAt,
    });

    if (persistenceResult?.error) {
      console.error('[supabase] No se pudo persistir un evento de tráfico.');
    } else if (persistenceResult) {
      persistence = persistenceResult;
    }
  } catch (error) {
    console.error('[supabase] Error inesperado persistiendo evento:', error);
    persistence = { error: true, message: error.message };
  }

  let phasePersistence = { skipped: true };
  if (phaseChanges.length) {
    try {
      phasePersistence = await persistPhaseChanges(
        phaseChanges.map((change) => ({
          intersectionId: normalizedIntersectionId,
          laneKey: change.laneId,
          previousState: change.previousState,
          nextState: change.nextState,
          startedAt: change.startedAt,
          endedAt: change.endedAt,
          durationMs: change.durationMs,
          trigger: change.reason ?? null,
          deviceId,
        })),
      );
    } catch (error) {
      console.error('[supabase] Error inesperado guardando cambios de fase:', error);
      phasePersistence = { error: true, message: error.message };
    }
  }

  let presencePersistence = { skipped: true };
  if (presenceEvents.length) {
    try {
      presencePersistence = await persistPresenceEvents(
        presenceEvents.map((event) => ({
          intersectionId: normalizedIntersectionId,
          laneKey: event.laneId,
          deviceId,
          detectedAt: event.detectedAt,
          clearedAt: event.clearedAt,
          waitMs: event.waitMs,
          triggeredChange: event.triggeredChange ?? false,
        })),
      );
    } catch (error) {
      console.error('[supabase] Error inesperado guardando eventos de presencia:', error);
      presencePersistence = { error: true, message: error.message };
    }
  }

  return {
    eventId,
    receivedAt,
    state: result.state,
    evaluation: result.evaluation,
  intersectionId: normalizedIntersectionId,
  presenceEvents,
  phaseChanges,
    persistence,
    phasePersistence,
    presencePersistence,
  };
}

app.get('/health', (_req, res) => {
  const currentState = getTrafficStateWithConnections();
  res.json({ status: 'ok', lanes: currentState.lanes.length, queue: currentState.queue.length });
});

app.get('/api/traffic/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`retry: 3000\n`);
  res.write(`event: traffic-state\ndata: ${JSON.stringify(getTrafficStateWithConnections())}\n\n`);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
    res.end();
  });
});

app.get('/', (_req, res) => {
  const trafficState = getTrafficStateWithConnections();
  const trafficCards = trafficState.lanes
    .map((lane) => `
      <article class="lane lane--${lane.state}" data-lane="${lane.id}">
        <h3>${lane.id.toUpperCase()}</h3>
        <p><strong>Estado:</strong> <span data-field="state">${lane.state}</span></p>
        <p><strong>Último cambio:</strong> <span data-field="lastChangeAt">${lane.lastChangeAt ? new Date(lane.lastChangeAt).toLocaleTimeString() : '—'}</span></p>
        <p><strong>Último vehículo:</strong> <span data-field="lastVehicleAt">${lane.lastVehicleAt ? new Date(lane.lastVehicleAt).toLocaleTimeString() : '—'}</span></p>
        <p><strong>Distancia:</strong> <span data-field="distance">${Number.isFinite(lane.lastDistanceCm) ? lane.lastDistanceCm : '—'}</span> cm</p>
        <p><strong>En cola:</strong> <span data-field="queue">${lane.waiting ? 'Sí' : 'No'}</span></p>
      </article>
    `)
    .join('');

  res.type('html').send(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <title>Semáforo inteligente</title>
        <style>
          :root { color-scheme: light dark; }
          body { font-family: "Segoe UI", Arial, sans-serif; margin: 2rem; background: #f8fafc; color: #0f172a; }
          h1, h2 { color: #0f172a; }
          ul { list-style: none; padding: 0; }
          li { background: #fff; margin-bottom: 1rem; padding: 1rem; border-radius: 12px; box-shadow: 0 4px 16px rgba(15, 23, 42, 0.12); }
          pre { background: #0f172a; color: #f8fafc; padding: 0.75rem; border-radius: 8px; overflow-x: auto; }
          header { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 2rem; }
          .lanes { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
          .lane { background: #fff; padding: 1.5rem; border-radius: 16px; box-shadow: 0 12px 32px rgba(15, 23, 42, 0.12); border: 3px solid transparent; transition: transform 0.2s ease, box-shadow 0.2s ease; }
          .lane:hover { transform: translateY(-4px); box-shadow: 0 16px 40px rgba(15, 23, 42, 0.18); }
          .lane--green { border-color: #16a34a; }
          .lane--yellow { border-color: #eab308; }
          .lane--red { border-color: #dc2626; }
          .badge { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.9rem; border-radius: 999px; background: #e2e8f0; color: #0f172a; font-size: 0.9rem; font-weight: 500; }
          .badge span { font-weight: 600; }
          .placeholder { color: #64748b; }
        </style>
      </head>
      <body>
        <header>
          <h1>Estado del semáforo inteligente</h1>
          <p class="badge">Cola actual: <span id="queue-badge">${trafficState.queue.length ? trafficState.queue.join(', ') : 'Vacía'}</span></p>
        </header>

        <section class="lanes" id="lanes">
          ${trafficCards}
        </section>

        <h2>Mensajes recibidos</h2>
        <p>El almacenamiento en memoria está deshabilitado. Usa <code>GET /api/traffic/lights</code> para consultar el estado actual o revisa Supabase para el historial persistente.</p>

        <script>
          (function () {
            const formatTime = (value) => {
              if (!value && value !== 0) return '—';
              const date = new Date(value);
              return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString();
            };

            const formatDistance = (value) => {
              return Number.isFinite(value) ? value.toFixed(2) : '—';
            };

            const lanesContainer = document.getElementById('lanes');
            const queueBadge = document.getElementById('queue-badge');
            const updateLaneCard = (lane) => {
              const article = lanesContainer.querySelector('[data-lane="' + lane.id + '"]');
              if (!article) return;

              article.classList.remove('lane--green', 'lane--yellow', 'lane--red');
              article.classList.add('lane--' + lane.state);

              const setField = (name, value) => {
                const el = article.querySelector('[data-field="' + name + '"]');
                if (el) {
                  el.textContent = value;
                }
              };

              setField('state', lane.state);
              setField('lastChangeAt', formatTime(lane.lastChangeAt));
              setField('lastVehicleAt', formatTime(lane.lastVehicleAt));
              setField('distance', formatDistance(lane.lastDistanceCm));
              setField('queue', lane.waiting ? 'Sí' : 'No');
            };

            const refresh = async () => {
              try {
                const trafficRes = await fetch('/api/traffic/lights', { cache: 'no-store' });

                if (!trafficRes.ok) {
                  throw new Error('Respuesta HTTP inválida');
                }

                const traffic = await trafficRes.json();

                queueBadge.textContent = traffic.queue.length ? traffic.queue.join(', ') : 'Vacía';
                traffic.lanes.forEach(updateLaneCard);
              } catch (error) {
                console.error('Error actualizando tablero', error);
              }
            };

            refresh();
            setInterval(refresh, 2000);
          })();
        </script>
      </body>
    </html>
  `);
});

app.post('/api/traffic/events', async (req, res) => {
  try {
    const outcome = await processTrafficEvent(req.body, { ip: req.ip, transport: 'http' });

    res.status(201).json({
      message: 'Evento procesado',
      state: outcome.state,
      evaluation: outcome.evaluation,
      phaseChanges: outcome.phaseChanges,
      presenceEvents: outcome.presenceEvents,
      persistence: outcome.persistence,
      phasePersistence: outcome.phasePersistence,
      presencePersistence: outcome.presencePersistence,
    });
  } catch (error) {
    const statusCode = error.statusCode ?? 400;
    res.status(statusCode).json({ message: error.message ?? 'No se pudo procesar el evento.' });
  }
});

function scheduleBatchProcessing({
  deviceId,
  readings,
  intersectionId,
  intervalMs,
  ip,
}) {
  readings.forEach((reading, index) => {
    const delayMs = intervalMs * index;

    const task = async () => {
      try {
        await processTrafficEvent(
          {
            deviceId,
            sensors: reading.sensors,
            timestamp: reading.timestamp,
            processedAt: reading.processedAt,
            intersectionId,
          },
          { ip, transport: 'http-batch' },
        );
      } catch (error) {
        console.error('[batch] Error procesando lectura programada:', error.message ?? error);
      }
    };

    if (delayMs > 0) {
      setTimeout(task, delayMs);
    } else {
      setImmediate(task);
    }
  });
}

app.post('/api/traffic/events/batch', async (req, res) => {
  const { deviceId, readings, intersectionId } = req.body ?? {};

  if (!deviceId || !Array.isArray(readings) || readings.length === 0) {
    res.status(400).json({ message: 'Se requieren deviceId y un arreglo readings con al menos un elemento.' });
    return;
  }

  const errors = [];
  const spreadWindowMs = Number.isFinite(Number(process.env.BATCH_SPREAD_WINDOW_MS))
    ? Number(process.env.BATCH_SPREAD_WINDOW_MS)
    : DEFAULT_BATCH_SPREAD_WINDOW_MS;
  const intervalMs = readings.length > 1 ? Math.max(1, Math.floor(spreadWindowMs / readings.length)) : 0;
  const baseTimestamp = Date.now();
  const scheduledReadings = [];

  for (let index = 0; index < readings.length; index += 1) {
    const reading = readings[index] ?? {};
    const { sensors, timestamp } = reading;
    const eventTimestamp = Number.isFinite(Number(timestamp))
      ? Number(timestamp)
      : baseTimestamp + index * intervalMs;
    const eventProcessedAt = baseTimestamp + index * intervalMs;

    if (!sensors || typeof sensors !== 'object' || sensors === null || Object.keys(sensors).length === 0) {
      errors.push({ index, message: 'Lectura inválida: se requieren sensores.' });
      continue;
    }

    scheduledReadings.push({ sensors, timestamp: eventTimestamp, processedAt: eventProcessedAt });
  }

  if (scheduledReadings.length === 0) {
    res.status(400).json({ message: 'No se pudieron procesar lecturas válidas.', errors });
    return;
  }
  scheduleBatchProcessing({ deviceId, readings: scheduledReadings, intersectionId, intervalMs, ip: req.ip });

  res.status(202).json({ scheduled: scheduledReadings.length, intervalMs, spreadWindowMs, errors });
});

app.get('/api/traffic/lights', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json(getTrafficStateWithConnections());
});

app.get('/api/traffic/lights/:laneId', (req, res) => {
  const laneState = trafficController.getLaneState(req.params.laneId);
  if (!laneState) {
    res.status(404).json({ message: `Semáforo ${req.params.laneId} no encontrado` });
    return;
  }

  res.json(laneState);
});

app.get('/api/analytics/overview', async (req, res) => {
  const intersectionId = req.query.intersectionId ?? DEFAULT_INTERSECTION_ID;

  try {
    const [transitionCountsRaw, laneDurationsRaw, presenceSamplesRaw, greenTrendRaw] = await Promise.all([
      fetchPhaseTransitionCounts({ intersectionId }),
      fetchLaneDurations({ intersectionId }),
      fetchPresenceSamples({ intersectionId, limit: 400 }),
      fetchGreenCycleTrend({ intersectionId, limit: 200 }),
    ]);

    const transitionCounts = transitionCountsRaw.map((row) => ({
      laneKey: row.lane_key,
      toState: row.next_state,
      count: Number(row.count) || 0,
    }));

    const laneDurations = laneDurationsRaw.map((row) => ({
      laneKey: row.laneKey ?? row.lane_key,
      greenMs: Number(row.greenMs ?? row.green_ms) || 0,
      redMs: Number(row.redMs ?? row.red_ms) || 0,
    }));

    const greenShare = laneDurations.map((row) => {
      const total = row.greenMs + row.redMs;
      return {
        laneKey: row.laneKey,
        greenRatio: total > 0 ? row.greenMs / total : 0,
      };
    });

    const presenceSamples = presenceSamplesRaw.map((row) => ({
      laneKey: row.lane_key,
      waitMs: Number(row.wait_ms) || 0,
      detectedAt: row.detected_at,
    }));

    const trendBuckets = new Map();
    greenTrendRaw.forEach((row) => {
      if (!row?.ended_at) {
        return;
      }
      const ended = new Date(row.ended_at);
      if (Number.isNaN(ended.getTime())) {
        return;
      }
      const alignedMs = Math.floor(ended.getTime() / GREEN_TREND_BUCKET_MS) * GREEN_TREND_BUCKET_MS;
      const isoKey = new Date(alignedMs).toISOString();
      if (!trendBuckets.has(isoKey)) {
        trendBuckets.set(isoKey, { bucket: isoKey, totalMs: 0, count: 0 });
      }
      const bucket = trendBuckets.get(isoKey);
      bucket.totalMs += Number(row.duration_ms) || 0;
      bucket.count += 1;
    });

    const greenCycleTrend = Array.from(trendBuckets.values())
      .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0))
      .map((entry) => ({
        bucket: entry.bucket,
        avgGreenMs: entry.count > 0 ? entry.totalMs / entry.count : 0,
        sampleCount: entry.count,
      }));

    res.json({
      intersectionId,
      transitionCounts,
      laneDurations,
      greenShare,
      presenceSamples,
      greenCycleTrend,
    });
  } catch (error) {
    console.error('[analytics] No se pudo obtener overview:', error);
    res.status(500).json({ message: 'No se pudo obtener datos analíticos' });
  }
});

app.use((err, _req, res, _next) => {
  console.error('Unexpected error:', err);
  res.status(500).json({ message: 'Error interno del servidor' });
});

module.exports = { app, server, trafficController, processTrafficEvent };
