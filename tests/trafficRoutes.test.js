const request = require('supertest');
const { app, trafficController } = require('../src/app');

describe('Traffic routes', () => {
  beforeEach(() => {
    trafficController.reset();
  });

  test('rejects events without required fields', async () => {
    const response = await request(app)
      .post('/api/traffic/events')
      .send({ foo: 'bar' });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/deviceId/i);
  });

  test('processes traffic event and stores message snapshot', async () => {
    const payload = {
      deviceId: 'esp32-test',
      sensors: { sensor2: 12 },
      timestamp: Date.now(),
    };

    const response = await request(app)
      .post('/api/traffic/events')
      .send(payload)
      .set('Content-Type', 'application/json');

    expect(response.status).toBe(201);
    expect(response.body.state.queue).toContain('west');
    expect(response.body.evaluation).toBeInstanceOf(Array);
  });

  test('retrieves state for whole intersection and individual lane', async () => {
    const globalResponse = await request(app).get('/api/traffic/lights');
    expect(globalResponse.status).toBe(200);
    expect(Array.isArray(globalResponse.body.lanes)).toBe(true);

    const laneId = globalResponse.body.lanes[0].id;
    const laneResponse = await request(app).get(`/api/traffic/lights/${laneId}`);
    expect(laneResponse.status).toBe(200);
    expect(laneResponse.body.id).toBe(laneId);

    const missingLane = await request(app).get('/api/traffic/lights/unknown');
    expect(missingLane.status).toBe(404);
  });

  test('processes batch of traffic events', async () => {
    process.env.BATCH_SPREAD_WINDOW_MS = '20';

    try {
      const payload = {
        deviceId: 'esp32-batch-test',
        readings: [
          { sensors: { sensor1: 11.2 }, timestamp: Date.now() },
          { sensors: { sensor2: 25.7 }, timestamp: Date.now() + 50 },
        ],
      };

      const response = await request(app)
        .post('/api/traffic/events/batch')
        .send(payload)
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(202);
      expect(response.body.scheduled).toBe(2);
      expect(response.body.intervalMs).toBeGreaterThanOrEqual(1);

      await new Promise((resolve) => setTimeout(resolve, response.body.intervalMs * payload.readings.length + 50));

      const state = trafficController.getState();
      const northLane = state.lanes.find((lane) => lane.id === 'north');
      const westLane = state.lanes.find((lane) => lane.id === 'west');

      expect(northLane?.lastDistanceCm).toBeCloseTo(11.2, 1);
      expect(westLane?.lastDistanceCm).toBeCloseTo(25.7, 1);
    } finally {
      delete process.env.BATCH_SPREAD_WINDOW_MS;
    }
  });
});
