import { Controller, Get, Module } from '@nestjs/common';
import { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createTestApp } from './utils/create-test-app';

/**
 * Тестовый контроллер, который просто падает. Нужен, чтобы проверить, что
 * неожиданная ошибка превращается в безопасный JSON без stack trace.
 */
@Controller('__test')
class BoomController {
  @Get('boom')
  boom(): never {
    throw new Error('secret internal details: password=hunter2');
  }
}

@Module({ controllers: [BoomController] })
class BoomModule {}

/**
 * Минимальные тесты «обвязки» из главы 0.5 (Middleware):
 * X-Request-Id, единый формат ошибок, CORS preflight, health-эндпоинты.
 */
describe('App infrastructure (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp(undefined, { imports: [BoomModule] });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('X-Request-Id', () => {
    it('генерирует id для существующего маршрута', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/live' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('ставит id и на несуществующем маршруте', async () => {
      const res = await app.inject({ method: 'GET', url: '/no-such-route' });

      expect(res.statusCode).toBe(404);
      expect(res.headers['x-request-id']).toBeDefined();
      // id в заголовке и в теле ошибки совпадает: по нему ищут запрос в логах.
      expect(res.json().requestId).toBe(res.headers['x-request-id']);
    });

    it('переиспользует безопасный входящий id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-request-id': 'trace-abc_123' },
      });

      expect(res.headers['x-request-id']).toBe('trace-abc_123');
    });

    it('не доверяет небезопасному входящему id (защита от log injection)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-request-id': 'evil value with spaces' },
      });

      expect(res.headers['x-request-id']).not.toBe('evil value with spaces');
    });
  });

  describe('единый формат ошибок', () => {
    it('404 возвращает code/message/requestId', async () => {
      const res = await app.inject({ method: 'GET', url: '/no-such-route' });

      expect(res.json()).toEqual({
        code: 'not_found',
        message: expect.any(String),
        requestId: expect.any(String),
      });
    });

    it('неожиданное исключение → 500 без внутренних деталей', async () => {
      const res = await app.inject({ method: 'GET', url: '/__test/boom' });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        code: 'internal_error',
        message: 'Internal server error',
        requestId: expect.any(String),
      });
      expect(res.body).not.toContain('hunter2');
      expect(res.body).not.toContain('at ');
    });
  });

  describe('CORS preflight', () => {
    it('отвечает 204 разрешённому origin', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health/live',
        headers: {
          origin: 'http://localhost:4200',
          'access-control-request-method': 'POST',
        },
      });

      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(
        'http://localhost:4200',
      );
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('не выдаёт CORS-заголовки чужому origin', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health/live',
        headers: {
          origin: 'http://evil.example',
          'access-control-request-method': 'POST',
        },
      });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('security-заголовки', () => {
    it('helmet ставит nosniff', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/live' });

      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  describe('health', () => {
    it('GET /health/ready → 200, когда БД доступна', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/ready' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok', checks: { database: 'up' } });
    });
  });
});
