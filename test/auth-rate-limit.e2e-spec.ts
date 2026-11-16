import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Rate limit входа и refresh с порогами ИЗ СПЕКИ 1.2 (раздел 1.6):
 * - login: 30 запросов с IP за минуту;
 * - 5 неуспешных проверок на пару email + IP за 15 минут;
 * - refresh: 30 запросов с IP за минуту.
 *
 * `.env.test` поднимает пороги для остальных e2e-файлов, поэтому здесь
 * возвращаем значения спеки ДО загрузки приложения (подробнее о приёме —
 * в registration-rate-limit.e2e-spec.ts). Разные тесты ходят с разных IP
 * (`remoteAddress`): счётчики throttler ведутся по IP.
 */
process.env.LOGIN_RATE_LIMIT = '30';
process.env.LOGIN_RATE_TTL = '60000';
process.env.REFRESH_RATE_LIMIT = '30';
process.env.REFRESH_RATE_TTL = '60000';

describe('Auth rate limits 1.2 (e2e)', () => {
  let app: NestFastifyApplication;
  let helpers: typeof import('./utils/auth-helpers');

  beforeAll(async () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { createTestApp } =
      require('./utils/create-test-app') as typeof import('./utils/create-test-app');
    helpers =
      require('./utils/auth-helpers') as typeof import('./utils/auth-helpers');
    /* eslint-enable @typescript-eslint/no-require-imports */
    app = await createTestApp();
    const { DataSource } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('typeorm') as typeof import('typeorm');
    await app.get(DataSource).query('TRUNCATE users CASCADE');
  });

  afterAll(async () => {
    await app.close();
  });

  const login = (ip: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/auth/login',
      payload,
      remoteAddress: ip,
    });

  it('login: 31-й запрос с IP за минуту → 429 rate_limited с Retry-After', async () => {
    // Невалидное тело: guard считает запрос раньше валидации.
    for (let i = 0; i < 30; i++) {
      expect((await login('10.0.0.1', { email: 'bad' })).statusCode).toBe(400);
    }
    const res = await login('10.0.0.1', { email: 'bad' });
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    // Другой IP не затронут.
    expect((await login('10.0.0.2', { email: 'bad' })).statusCode).toBe(400);
  });

  it('5 неуспешных проверок на email + IP → 429 даже с верным паролем; другой IP входит', async () => {
    const email = 'victim@example.com';
    await helpers.createUser(app, email);

    for (let i = 0; i < 5; i++) {
      expect(
        (await login('10.0.1.1', { email, password: 'wrong-pass1' }))
          .statusCode,
      ).toBe(401);
    }
    const blocked = await login('10.0.1.1', {
      email,
      password: helpers.PASSWORD,
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(14 * 60);

    // Аккаунт не заблокирован для владельца с другого IP.
    expect(
      (await login('10.0.1.2', { email, password: helpers.PASSWORD }))
        .statusCode,
    ).toBe(204);
    // Неизвестный email считается так же.
    for (let i = 0; i < 5; i++) {
      await login('10.0.1.3', { email: 'ghost@example.com', password: 'x' });
    }
    expect(
      (await login('10.0.1.3', { email: 'ghost@example.com', password: 'x' }))
        .statusCode,
    ).toBe(429);
  });

  it('refresh: 31-й запрос с IP за минуту → 429', async () => {
    const refresh = () =>
      app.inject({
        method: 'POST',
        url: '/auth/refresh',
        remoteAddress: '10.0.2.1',
      });
    for (let i = 0; i < 30; i++) {
      expect((await refresh()).statusCode).toBe(401);
    }
    expect((await refresh()).statusCode).toBe(429);
  });
});
