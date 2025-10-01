const request = require('supertest');
const { app, messages, trafficController } = require('../src/app');

describe('ESP32 backend API', () => {
  afterEach(() => {
    messages.length = 0;
    trafficController.reset();
  });

  test('GET /api/messages retorna lista vacía inicialmente', async () => {
    const response = await request(app).get('/api/messages');

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(0);
    expect(Array.isArray(response.body.data)).toBe(true);
  });

  test('POST /api/messages guarda el cuerpo recibido', async () => {
    const payload = { deviceId: 'esp32-test', value: 123 };

    const postResponse = await request(app)
      .post('/api/messages')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(postResponse.status).toBe(201);
    expect(postResponse.body.message).toBe('Mensaje recibido');
    expect(postResponse.body.data.deviceId).toBe('esp32-test');
    expect(postResponse.body.data.payload).toMatchObject(payload);

    const listResponse = await request(app).get('/api/messages');
    expect(listResponse.body.total).toBe(1);
    expect(listResponse.body.data[0].payload).toMatchObject(payload);
  });

  test('POST /api/messages devuelve 400 si no hay cuerpo', async () => {
    const response = await request(app)
      .post('/api/messages')
      .set('Content-Type', 'application/json')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Se requiere/);
  });
});
