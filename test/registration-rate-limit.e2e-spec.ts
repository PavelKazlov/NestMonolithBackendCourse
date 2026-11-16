import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Rate limit регистрации (спека 1.0, раздел 1.6) с маленьким порогом.
 *
 * Порог берётся из env при загрузке ConfigModule. `@nestjs/config` проверяет
 * env прямо в момент ИМПОРТА модуля (`forRoot()` вызывается в декораторе).
 * Поэтому сначала меняем `process.env`, а приложение загружаем динамически,
 * уже после этого (через `require` в beforeAll). Статический `import`
 * поднялся бы наверх файла и выполнился бы раньше присваивания. У каждого
 * тестового файла Jest свой реестр модулей и своя копия `process.env`,
 * так что другие файлы это не затронет.
 */
process.env.REGISTRATION_RATE_LIMIT = '2';
process.env.REGISTRATION_RATE_TTL = '60000';

describe('Registration rate limit (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    // require, а не `await import()`: при `module: nodenext` TypeScript
    // оставляет нативный import(), а Jest без флагов VM его не поддерживает.
    const { createTestApp } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./utils/create-test-app') as typeof import('./utils/create-test-app');
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // Невалидный email: запрос отклонит валидация, в БД ничего не пишется.
  // Guard срабатывает раньше валидации, поэтому такие запросы тоже считаются.
  const post = (url: string) =>
    app.inject({ method: 'POST', url, payload: { email: 'bad' } });

  it('третий register за окно → 429 rate_limited с Retry-After', async () => {
    expect((await post('/auth/register')).statusCode).toBe(400);
    expect((await post('/auth/register')).statusCode).toBe(400);

    const limited = await post('/auth/register');

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: expect.any(Number),
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('у resend свой счётчик, и он тоже ограничен', async () => {
    expect((await post('/auth/register/resend')).statusCode).toBe(400);
    expect((await post('/auth/register/resend')).statusCode).toBe(400);
    expect((await post('/auth/register/resend')).statusCode).toBe(429);
  });

  it('на confirm лимит регистрации не действует (там свой лимит — 5 попыток)', async () => {
    for (let i = 0; i < 4; i++) {
      expect((await post('/auth/register/confirm')).statusCode).toBe(400);
    }
  });
});
