import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import jwt from 'jsonwebtoken';
import { DataSource } from 'typeorm';

import { AuthModule } from '@/modules/auth/auth.module';
import { AccessGuard } from '@/modules/auth/session/access.guard';
import { CurrentUserId } from '@/modules/auth/session/current-user.decorator';
import { UserStatus } from '@/modules/users/user.entity';
import { cookieMap, createUser, PASSWORD } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';

/**
 * Защищённый маршрут ТОЛЬКО для тестов: в 1.2 своих защищённых операций
 * ещё нет (профиль появится в 1.4). Контроллер подключается через
 * `createTestApp(..., { controllers })` и в приложение не попадает.
 */
@Controller('test-protected')
@UseGuards(AccessGuard)
class ProtectedController {
  @Get()
  me(@CurrentUserId() userId: string) {
    return { userId };
  }

  @Post()
  change(@CurrentUserId() userId: string) {
    return { userId };
  }
}

const TRUSTED = 'http://front.test';

describe('Session 1.2: refresh, logout, access, CSRF (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DataSource;
  const email = 'session@example.com';
  let userId: string;

  beforeAll(async () => {
    app = await createTestApp(undefined, {
      imports: [AuthModule],
      controllers: [ProtectedController],
    });
    db = app.get(DataSource);
  });

  beforeEach(async () => {
    await db.query('TRUNCATE users CASCADE');
    userId = await createUser(app, email);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Вход без подтверждения: возвращает значения обеих cookies. */
  const loginCookies = async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(204);
    const cookies = cookieMap(res);
    return {
      access: cookies.access_token.value,
      refresh: cookies.refresh_token.value,
    };
  };

  const refresh = (
    cookies: Record<string, string> = {},
    headers: Record<string, string> = {},
  ) => app.inject({ method: 'POST', url: '/auth/refresh', cookies, headers });
  const protectedGet = (cookies: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/test-protected', cookies });

  /** Подписать access ключом из .env.test с произвольными claims. */
  const forgeAccess = (claims: Record<string, unknown>) =>
    jwt.sign(
      {
        sub: userId,
        iss: process.env.JWT_ISSUER,
        aud: process.env.JWT_AUDIENCE,
        token_use: 'access',
        ...claims,
      },
      process.env.JWT_ACCESS_SECRET!,
      { algorithm: 'HS256' },
    );

  const expectInvalidSession = (res: Awaited<ReturnType<typeof refresh>>) => {
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'invalid_session' });
    expect(res.cookies).toHaveLength(0);
  };

  // ───────────────────────────── refresh ─────────────────────────────

  describe('POST /auth/refresh', () => {
    it('валидный refresh → 204 и новая пара; прежний refresh тоже ещё работает', async () => {
      const { refresh: old } = await loginCookies();
      const res = await refresh({ refresh_token: old });
      expect(res.statusCode).toBe(204);
      const cookies = cookieMap(res);
      expect(cookies.access_token).toMatchObject({
        path: '/',
        maxAge: 900,
        httpOnly: true,
      });
      expect(cookies.refresh_token).toMatchObject({
        path: '/auth/refresh',
        maxAge: 2592000,
      });
      expect(res.body).toBe('');

      // Stateless: использованный refresh не отозван (спека 1.3.4).
      expect((await refresh({ refresh_token: old })).statusCode).toBe(204);
    });

    it('без cookie → 401 invalid_session', async () => {
      expectInvalidSession(await refresh());
    });

    it('refresh в теле, query или Authorization не принимается', async () => {
      const { refresh: token } = await loginCookies();
      expectInvalidSession(
        await app.inject({
          method: 'POST',
          url: `/auth/refresh?refresh_token=${token}`,
          payload: { refresh_token: token },
          headers: { authorization: `Bearer ${token}` },
        }),
      );
    });

    it('access вместо refresh → 401', async () => {
      const { access } = await loginCookies();
      expectInvalidSession(await refresh({ refresh_token: access }));
    });

    it.each([
      UserStatus.Pending,
      UserStatus.Blocked,
      UserStatus.Deleting,
      UserStatus.Deleted,
    ])('пользователь %s → 401 без новых cookies', async (status) => {
      const { refresh: token } = await loginCookies();
      await db.query('UPDATE users SET status = $1 WHERE id = $2', [
        status,
        userId,
      ]);
      expectInvalidSession(await refresh({ refresh_token: token }));
    });

    it('удалённый пользователь → 401', async () => {
      const { refresh: token } = await loginCookies();
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
      expectInvalidSession(await refresh({ refresh_token: token }));
    });
  });

  // ───────────────────────────── logout ─────────────────────────────

  describe('POST /auth/logout', () => {
    it('без cookies → 204 и две очищающие cookie с исходными атрибутами', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/logout' });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      const cookies = cookieMap(res);
      for (const [name, path] of [
        ['access_token', '/'],
        ['refresh_token', '/auth/refresh'],
      ]) {
        expect(cookies[name]).toMatchObject({
          value: '',
          path,
          maxAge: 0,
          httpOnly: true,
          secure: true,
          sameSite: 'Strict',
        });
        expect(cookies[name].domain).toBeUndefined();
        expect(cookies[name].expires!.getTime()).toBe(0);
      }
    });

    it('с валидными и с мусорными cookies — тоже 204; токен при этом не отзывается', async () => {
      const { access, refresh: token } = await loginCookies();
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/auth/logout',
            cookies: { access_token: access },
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/auth/logout',
            cookies: { access_token: 'junk' },
          })
        ).statusCode,
      ).toBe(204);
      // Ограничение stateless-схемы: копия refresh продолжает работать.
      expect((await refresh({ refresh_token: token })).statusCode).toBe(204);
    });
  });

  // ─────────────────────────── AccessGuard ───────────────────────────

  describe('AccessGuard', () => {
    it('валидный access active-пользователя → обработчик получает userId', async () => {
      const { access } = await loginCookies();
      const res = await protectedGet({ access_token: access });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ userId });
    });

    it.each([
      ['нет cookie', () => undefined],
      ['мусор', () => 'garbage'],
      ['чужая подпись', () => jwt.sign({ sub: 'x' }, 'z'.repeat(40))],
      [
        'истёк',
        () =>
          forgeAccess({
            iat: Math.floor(Date.now() / 1000) - 1000,
            exp: Math.floor(Date.now() / 1000) - 60,
          }),
      ],
      [
        'чужой aud',
        () =>
          forgeAccess({ aud: 'evil', exp: Math.floor(Date.now() / 1000) + 60 }),
      ],
      [
        'token_use=refresh',
        () =>
          forgeAccess({
            token_use: 'refresh',
            exp: Math.floor(Date.now() / 1000) + 60,
          }),
      ],
    ])('%s → 401 invalid_session', async (_name, make) => {
      const token = make();
      const res = await protectedGet(token ? { access_token: token } : {});
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('invalid_session');
    });

    it('refresh-токен в cookie access_token → 401', async () => {
      const { refresh: token } = await loginCookies();
      expect((await protectedGet({ access_token: token })).statusCode).toBe(
        401,
      );
    });

    it('блокировка пользователя гасит уже выданный access сразу', async () => {
      const { access } = await loginCookies();
      expect((await protectedGet({ access_token: access })).statusCode).toBe(
        200,
      );
      await db.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [
        userId,
      ]);
      expect((await protectedGet({ access_token: access })).statusCode).toBe(
        401,
      );
    });
  });

  // ───────────────────────────── CSRF ─────────────────────────────

  describe('Origin / CSRF', () => {
    const logout = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/auth/logout', headers });

    it('свой origin (APP_ORIGIN) → без CSRF-заголовка', async () => {
      expect(
        (await logout({ origin: process.env.APP_ORIGIN! })).statusCode,
      ).toBe(204);
    });

    it('доверенный origin с X-CSRF-Protection: 1 → пропуск', async () => {
      const { refresh: token } = await loginCookies();
      const res = await refresh(
        { refresh_token: token },
        { origin: TRUSTED, 'x-csrf-protection': '1' },
      );
      expect(res.statusCode).toBe(204);
    });

    it('доверенный origin без заголовка → 403 csrf_rejected, cookies не тронуты', async () => {
      const res = await logout({ origin: TRUSTED });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('csrf_rejected');
      expect(res.cookies).toHaveLength(0);
    });

    it('чужой origin → 403 даже с заголовком; на login и защищённом POST тоже', async () => {
      const headers = { origin: 'http://evil.test', 'x-csrf-protection': '1' };
      expect((await logout(headers)).statusCode).toBe(403);
      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: PASSWORD },
        headers,
      });
      expect(loginRes.statusCode).toBe(403);
      expect(loginRes.cookies).toHaveLength(0);
      const { access } = await loginCookies();
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/test-protected',
            cookies: { access_token: access },
            headers,
          })
        ).statusCode,
      ).toBe(403);
    });

    it('CORS preflight: доверенному origin разрешены credentials и X-CSRF-Protection', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/auth/refresh',
        headers: {
          origin: TRUSTED,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-csrf-protection',
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(TRUSTED);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(String(res.headers['access-control-allow-headers'])).toMatch(
        /X-CSRF-Protection/i,
      );

      const evil = await app.inject({
        method: 'OPTIONS',
        url: '/auth/refresh',
        headers: {
          origin: 'http://evil.test',
          'access-control-request-method': 'POST',
        },
      });
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
