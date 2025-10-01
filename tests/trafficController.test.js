const TrafficController = require('../src/trafficController');

describe('TrafficController', () => {
  const baseConfig = {
    minGreenMs: 1_000,
    maxGreenMs: 2_000,
    yellowMs: 500,
    presenceTimeoutMs: 5_000,
    maxRedMs: 3_000,
  };

  test('initializes first lane in green and others in red', () => {
    const controller = new TrafficController(baseConfig);
    const state = controller.getState();

    expect(state.lanes[0].state).toBe('green');
    expect(state.lanes.slice(1).every((lane) => lane.state === 'red')).toBe(true);
  });

  test('queues lane when vehicle detected and switches after cycle', () => {
    const controller = new TrafficController(baseConfig);
    const now = Date.now();

    controller.ingestEvent({
      deviceId: 'esp32',
      sensors: { sensor2: 15 },
      timestamp: now + 100,
      processedAt: now + 100,
    });

    controller.evaluateStateMachine(now + 1_200);
    controller.evaluateStateMachine(now + 1_800);

    const state = controller.getState();
    const north = state.lanes.find((lane) => lane.id === 'north');
    const west = state.lanes.find((lane) => lane.id === 'west');

    expect(north.state).toBe('red');
    expect(west.state).toBe('green');
    expect(state.queue).toHaveLength(0);
  });

  test('gives priority to lane waiting longer than maxRedMs', () => {
    const controller = new TrafficController(baseConfig);
    const now = Date.now();

    controller.ingestEvent({
      deviceId: 'esp32',
      sensors: { sensor3: 10 },
      timestamp: now + 100,
      processedAt: now + 100,
    });

    controller.evaluateStateMachine(now + 1_100);
    controller.evaluateStateMachine(now + 1_700);

    controller.ingestEvent({
      deviceId: 'esp32',
      sensors: { sensor4: 12 },
      timestamp: now + 2_000,
      processedAt: now + 2_000,
    });

    // El vehículo del carril sur avanza (distancia > umbral) para permitir cambio de fase
    controller.ingestEvent({
      deviceId: 'esp32',
      sensors: { sensor3: 999, sensor4: 12 },
      timestamp: now + 2_200,
      processedAt: now + 2_200,
    });

    controller.evaluateStateMachine(now + 3_200);
    controller.evaluateStateMachine(now + 3_800);
    controller.evaluateStateMachine(now + 4_400);
  controller.evaluateStateMachine(now + 5_000);

    const state = controller.getState();
    const south = state.lanes.find((lane) => lane.id === 'south');
    const east = state.lanes.find((lane) => lane.id === 'east');

  expect(['red', 'yellow']).toContain(south.state);
  expect(east.state).toBe('green');
  });

  test('cycles automatically when no vehicles are detected', () => {
    const controller = new TrafficController({
      ...baseConfig,
      minGreenMs: 100,
      maxGreenMs: 200,
      yellowMs: 50,
    });
    const start = Date.now();

    controller.reset(start);

    controller.tick(start + 120);
    let state = controller.getState();
    const north = state.lanes.find((lane) => lane.id === 'north');
    expect(north.state).toBe('yellow');

    controller.tick(start + 180);
    state = controller.getState();
    const updatedNorth = state.lanes.find((lane) => lane.id === 'north');
    const west = state.lanes.find((lane) => lane.id === 'west');

    expect(updatedNorth.state).toBe('red');
    expect(west.state).toBe('green');
  });

  test('keeps green while a vehicle is present and for a short grace period', () => {
    const controller = new TrafficController({
      ...baseConfig,
      minGreenMs: 100,
      maxGreenMs: 500,
      yellowMs: 50,
      holdAfterClearMs: 150,
      detectionThresholdCm: 30,
      vehiclePresenceGraceMs: 250,
    });

    const start = Date.now();
    controller.reset(start);

    controller.ingestEvent({
      deviceId: 'esp32',
      sensors: { sensor1: 10, sensor2: 12 },
      timestamp: start + 20,
      processedAt: start + 20,
    });

    controller.tick(start + 160);
    let state = controller.getState();
    expect(state.lanes.find((lane) => lane.id === 'north').state).toBe('green');

    controller.ingestEvent({
      deviceId: 'esp32',
      sensors: { sensor1: 999, sensor2: 12 },
      timestamp: start + 220,
      processedAt: start + 220,
    });

    controller.tick(start + 320);
    state = controller.getState();
    expect(state.lanes.find((lane) => lane.id === 'north').state).toBe('green');

  controller.tick(start + 480);
    state = controller.getState();
    expect(state.lanes.find((lane) => lane.id === 'north').state).not.toBe('green');
  });

  test('removes lane from queue when sensor clears before turning green', () => {
    const controller = new TrafficController(baseConfig);
    const now = Date.now();

    controller.ingestEvent({
      deviceId: 'esp32',
      sensors: { sensor2: 12 },
      timestamp: now + 50,
      processedAt: now + 50,
    });

    let state = controller.getState();
    expect(state.queue).toContain('west');

    controller.ingestEvent({
      deviceId: 'esp32',
      sensors: { sensor2: 999 },
      timestamp: now + 100,
      processedAt: now + 100,
    });

    state = controller.getState();
    expect(state.queue).not.toContain('west');
  });
});
