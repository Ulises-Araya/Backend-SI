const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { randomUUID } = require('crypto');
const TrafficController = require('./trafficController');
const { persistTrafficEvent } = require('./persistence/trafficEventsRepository');

const trafficController = new TrafficController();
const sseClients = new Set();
const TICK_INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS ?? 250) || 250;

const trafficTickTimer = setInterval(() => {
  const transitions = trafficController.tick();
  if (Array.isArray(transitions) && transitions.length) {
    console.debug('[traffic] transitions', transitions);
  }
}, TICK_INTERVAL_MS);

if (typeof trafficTickTimer.unref === 'function') {
  trafficTickTimer.unref();
}

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(data);
  }
}

trafficController.on('state', (state) => {
  broadcast('traffic-state', state);
});

app.get('/health', (_req, res) => {
  const currentState = trafficController.getState();
  res.json({ status: 'ok', lanes: currentState.lanes.length, queue: currentState.queue.length });
});

app.get('/api/traffic/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`retry: 3000\n`);
  res.write(`event: traffic-state\ndata: ${JSON.stringify(trafficController.getState())}\n\n`);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
    res.end();
  });
});

app.get('/', (_req, res) => {
  const trafficState = trafficController.getState();
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
  const { deviceId, sensors, intersectionId, timestamp } = req.body || {};

  if (!deviceId || typeof sensors !== 'object' || sensors === null) {
    res.status(400).json({ message: 'Se requieren los campos deviceId y sensors.' });
    return;
  }

  try {
    const result = trafficController.ingestEvent({
      deviceId,
      intersectionId,
      sensors,
      timestamp: Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now(),
    });

    const receivedAt = new Date().toISOString();
    const eventId = randomUUID();

    const persistenceResult = await persistTrafficEvent({
      id: eventId,
      deviceId,
      intersectionId,
      sensors,
      stateSnapshot: result.state,
      evaluation: result.evaluation,
      ip: req.ip,
      receivedAt,
    });

    if (persistenceResult?.error) {
      console.error('[supabase] No se pudo persistir un evento de tráfico.');
    }

    res.status(201).json({
      message: 'Evento procesado',
      state: result.state,
      evaluation: result.evaluation,
      persistence: persistenceResult ?? { skipped: true },
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.get('/api/traffic/lights', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json(trafficController.getState());
});

app.get('/api/traffic/lights/:laneId', (req, res) => {
  const laneState = trafficController.getLaneState(req.params.laneId);
  if (!laneState) {
    res.status(404).json({ message: `Semáforo ${req.params.laneId} no encontrado` });
    return;
  }

  res.json(laneState);
});

app.use((err, _req, res, _next) => {
  console.error('Unexpected error:', err);
  res.status(500).json({ message: 'Error interno del servidor' });
});

module.exports = { app, trafficController };
