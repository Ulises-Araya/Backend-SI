const request = require('supertest');
const { app, trafficController } = require('../src/app');

describe('ESP32 backend API (mensajes deshabilitados)', () => {
  afterEach(() => {
    trafficController.reset();
  });

  test('GET /health expone información resumida del controlador', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok' });
    expect(typeof response.body.lanes).toBe('number');
    expect(typeof response.body.queue).toBe('number');
  });

  test('los endpoints legacy de mensajes ya no están disponibles', async () => {
    const getResponse = await request(app).get('/api/messages');
    expect(getResponse.status).toBe(404);

    const postResponse = await request(app)
      .post('/api/messages')
      .set('Content-Type', 'application/json')
      .send({ deviceId: 'esp32', value: 123 });
    expect(postResponse.status).toBe(404);
  });
});
