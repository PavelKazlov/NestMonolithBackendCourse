import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';

import { MailSender } from '@/core/mail/mail-sender';
import { LoginSettings } from '@/modules/auth/login/login.settings';
import { ConfirmationMethod } from '@/modules/auth/registration/registration-challenge.entity';
import { UserStatus } from '@/modules/users/user.entity';
import {
  codeFrom,
  cookieMap,
  createUser,
  FakeMailSender,
  loginTokenFrom,
  PASSWORD,
} from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';

/** Изменяемые настройки: переключаем режим входа между тестами. */
const settings = {
  confirmationEnabled: false,
  confirmationMethod: ConfirmationMethod.Otp,
  confirmUrl: 'http://front.test/login/confirm',
};

interface ChallengeRow {
  id: string;
  attempts: number;
  consumed_at: Date | null;
  consumed_reason: string | null;
}

describe('Login 1.2 (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DataSource;
  const mail = new FakeMailSender();
  let seq = 0;
  /** Уникальный email на тест: лимит неуспехов (email + IP) живёт весь файл. */
  let email: string;

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder
        .overrideProvider(MailSender)
        .useValue(mail)
        .overrideProvider(LoginSettings)
        .useValue(settings),
    );
    db = app.get(DataSource);
  });

  beforeEach(async () => {
    await db.query('TRUNCATE users CASCADE');
    mail.sent = [];
    mail.failing = false;
    settings.confirmationEnabled = false;
    settings.confirmationMethod = ConfirmationMethod.Otp;
    email = `user${++seq}@example.com`;
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (url: string, payload?: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, payload });
  const login = (
    body: Record<string, unknown> = { email, password: PASSWORD },
  ) => post('/auth/login', body);
  const confirm = (payload: Record<string, unknown>) =>
    post('/auth/login/confirm', payload);
  const resend = (attemptId: string) =>
    post('/auth/login/resend', { attemptId });

  const challengeRow = async (id: string) =>
    (
      await db.query<ChallengeRow[]>(
        'SELECT * FROM login_challenges WHERE id = $1',
        [id],
      )
    )[0];
  /** Сдвинуть отправку письма в прошлое (TTL и пауза считаются от last_sent_at). */
  const backdate = (id: string, seconds: number) =>
    db.query(
      `UPDATE login_challenges SET last_sent_at = last_sent_at - make_interval(secs => $2) WHERE id = $1`,
      [id, seconds],
    );

  /** Ответ установил обе auth-cookies с атрибутами из спеки. */
  const expectSessionCookies = (res: Awaited<ReturnType<typeof login>>) => {
    const cookies = cookieMap(res);
    expect(cookies.access_token).toMatchObject({
      path: '/',
      maxAge: 900,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    });
    expect(cookies.refresh_token).toMatchObject({
      path: '/auth/refresh',
      maxAge: 2592000,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    });
    expect(cookies.access_token.domain).toBeUndefined();
    expect(cookies.refresh_token.domain).toBeUndefined();
  };

  // ───────────────────────── прямой вход ─────────────────────────

  describe('без подтверждения', () => {
    it('204, две cookies, пустое тело; email нормализуется', async () => {
      await createUser(app, email);
      const res = await login({
        email: `  ${email.toUpperCase()} `,
        password: PASSWORD,
      });

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expectSessionCookies(res);
    });

    it('пароль не нормализуется: пробелы — часть пароля', async () => {
      await createUser(app, email, UserStatus.Active, ' pass word1 ');
      expect((await login({ email, password: 'pass word1' })).statusCode).toBe(
        401,
      );
      expect(
        (await login({ email, password: ' pass word1 ' })).statusCode,
      ).toBe(204);
    });

    it('неверный формат → 400 validation_failed', async () => {
      expect((await login({ email: 'bad', password: 'x' })).json().code).toBe(
        'validation_failed',
      );
      expect(
        (await login({ email, password: PASSWORD, extra: 1 })).statusCode,
      ).toBe(400);
    });
  });

  // ───────────────────── нейтральная ошибка 401 ─────────────────────

  describe('нейтральный 401 invalid_credentials', () => {
    /** Тело без requestId: оно у каждого ответа своё. */
    const body = (res: Awaited<ReturnType<typeof login>>) => {
      const { requestId, ...rest } = res.json<Record<string, unknown>>();
      expect(requestId).toBeDefined();
      return rest;
    };

    it('неизвестный email, неверный пароль и каждый неактивный статус — один и тот же ответ', async () => {
      await createUser(app, email);
      const reference = await login({
        email: 'nobody@example.com',
        password: PASSWORD,
      });
      expect(reference.statusCode).toBe(401);
      expect(body(reference)).toEqual({
        code: 'invalid_credentials',
        message: 'Invalid email or password',
      });

      const wrongPassword = await login({ email, password: 'wrong-pass1' });
      expect(wrongPassword.statusCode).toBe(401);
      expect(body(wrongPassword)).toEqual(body(reference));

      for (const status of [
        UserStatus.Pending,
        UserStatus.Blocked,
        UserStatus.Deleting,
        UserStatus.Deleted,
      ]) {
        const other = `${status}-${email}`;
        await createUser(app, other, status);
        const res = await login({ email: other, password: PASSWORD });
        expect(res.statusCode).toBe(401);
        expect(body(res)).toEqual(body(reference));
        expect(res.cookies).toHaveLength(0);
      }
    });
  });

  // ───────────────────────────── OTP ─────────────────────────────

  describe('подтверждение OTP', () => {
    beforeEach(() => {
      settings.confirmationEnabled = true;
    });

    /** Вход до 202, возвращает attemptId. */
    const startOtp = async () => {
      await createUser(app, email);
      const res = await login();
      expect(res.statusCode).toBe(202);
      return res.json<{ attemptId: string }>().attemptId;
    };

    it('202 без cookies и секрета → верный код → 204 и cookies', async () => {
      const res = await (async () => {
        await createUser(app, email);
        return login();
      })();
      expect(res.statusCode).toBe(202);
      expect(res.cookies).toHaveLength(0);
      const body = res.json<{ attemptId: string }>();
      expect(body).toEqual({
        confirmationRequired: true,
        method: 'otp',
        attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      const code = codeFrom(mail.last());
      expect(res.body).not.toContain(code);
      expect(mail.last().to).toBe(email);

      const ok = await confirm({ attemptId: body.attemptId, code });
      expect(ok.statusCode).toBe(204);
      expectSessionCookies(ok);
      expect(await challengeRow(body.attemptId)).toMatchObject({
        consumed_reason: 'confirmed',
      });

      // Погашенная попытка — 400.
      expect(
        (await confirm({ attemptId: body.attemptId, code })).json().code,
      ).toBe('confirmation_invalid');
    });

    it('пятый неверный ввод → 400 и погашение; следующий, даже верный → 429', async () => {
      const attemptId = await startOtp();
      const code = codeFrom(mail.last());
      const wrong = code === '000000' ? '111111' : '000000';

      for (let i = 1; i <= 4; i++) {
        expect((await confirm({ attemptId, code: wrong })).statusCode).toBe(
          400,
        );
      }
      expect(await challengeRow(attemptId)).toMatchObject({
        attempts: 4,
        consumed_at: null,
      });

      const fifth = await confirm({ attemptId, code: wrong });
      expect(fifth.statusCode).toBe(400);
      expect(await challengeRow(attemptId)).toMatchObject({
        attempts: 5,
        consumed_reason: 'attempts_exhausted',
      });

      const sixth = await confirm({ attemptId, code });
      expect(sixth.statusCode).toBe(429);
      expect(sixth.json().code).toBe('attempts_exhausted');
      // Resend исчерпанной попытки тоже 429.
      expect((await resend(attemptId)).statusCode).toBe(429);
    });

    it('пятый ввод ещё может быть верным', async () => {
      const attemptId = await startOtp();
      const code = codeFrom(mail.last());
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 1; i <= 4; i++) await confirm({ attemptId, code: wrong });
      expect((await confirm({ attemptId, code })).statusCode).toBe(204);
    });

    it('просроченная попытка → 400, attempts не растёт', async () => {
      const attemptId = await startOtp();
      await backdate(attemptId, 601);
      const res = await confirm({ attemptId, code: codeFrom(mail.last()) });
      expect(res.statusCode).toBe(400);
      expect((await challengeRow(attemptId)).attempts).toBe(0);
    });

    it('неизвестная попытка → 400', async () => {
      const res = await confirm({
        attemptId: '00000000-0000-4000-8000-000000000000',
        code: '123456',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('confirmation_invalid');
    });

    it('пользователь заблокирован после 202 → 401, попытка гасится user_inactive', async () => {
      const attemptId = await startOtp();
      await db.query(`UPDATE users SET status = 'blocked' WHERE email = $1`, [
        email,
      ]);

      const res = await confirm({ attemptId, code: codeFrom(mail.last()) });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('invalid_credentials');
      expect(res.cookies).toHaveLength(0);
      expect(await challengeRow(attemptId)).toMatchObject({
        consumed_reason: 'user_inactive',
      });
      // Дальше — общий 400.
      expect((await confirm({ attemptId, code: '123456' })).statusCode).toBe(
        400,
      );
    });

    it('OTP-попытку нельзя подтверждать формой magic link (фильтр method)', async () => {
      const attemptId = await startOtp();
      const res = await confirm({ token: `${attemptId}.${'A'.repeat(43)}` });
      expect(res.statusCode).toBe(400);
      expect((await challengeRow(attemptId)).attempts).toBe(0);
    });

    it('login до паузы 60 с → 429 с Retry-After, без новой попытки и письма', async () => {
      await startOtp();
      const res = await login();
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ code: 'resend_too_soon' });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(mail.sent).toHaveLength(1);
    });

    it('login после паузы заменяет попытку: старая replaced, старый код не работает', async () => {
      const first = await startOtp();
      const oldCode = codeFrom(mail.last());
      await backdate(first, 61);

      const res = await login();
      expect(res.statusCode).toBe(202);
      const second = res.json<{ attemptId: string }>().attemptId;
      expect(second).not.toBe(first);
      expect(await challengeRow(first)).toMatchObject({
        consumed_reason: 'replaced',
      });
      expect(
        (await confirm({ attemptId: first, code: oldCode })).statusCode,
      ).toBe(400);
      expect(
        (await confirm({ attemptId: second, code: codeFrom(mail.last()) }))
          .statusCode,
      ).toBe(204);
    });

    it('SMTP упал → 503 с attemptId, попытка сохранена, resend доставляет', async () => {
      await createUser(app, email);
      mail.failing = true;
      const res = await login();
      expect(res.statusCode).toBe(503);
      const body = res.json<{ attemptId: string }>();
      expect(body).toMatchObject({
        code: 'mail_delivery_failed',
        confirmationRequired: true,
        method: 'otp',
        retryAfterSeconds: 60,
      });
      expect(await challengeRow(body.attemptId)).toMatchObject({
        consumed_at: null,
      });

      mail.failing = false;
      await backdate(body.attemptId, 61);
      expect((await resend(body.attemptId)).statusCode).toBe(202);
      expect(
        (
          await confirm({
            attemptId: body.attemptId,
            code: codeFrom(mail.last()),
          })
        ).statusCode,
      ).toBe(204);
    });

    it('смена настройки не трогает уже созданную попытку', async () => {
      const attemptId = await startOtp();
      settings.confirmationMethod = ConfirmationMethod.MagicLink;
      await backdate(attemptId, 61);
      const res = await resend(attemptId);
      expect(res.json()).toMatchObject({ method: 'otp' });
      expect(
        (await confirm({ attemptId, code: codeFrom(mail.last()) })).statusCode,
      ).toBe(204);
    });
  });

  // ─────────────────────────── resend ───────────────────────────

  describe('resend', () => {
    beforeEach(() => {
      settings.confirmationEnabled = true;
    });

    it('до 60 с → 429; после — 202, новый код, старый не работает, attempts = 0', async () => {
      await createUser(app, email);
      const { attemptId } = (await login()).json<{ attemptId: string }>();
      const oldCode = codeFrom(mail.last());
      await confirm({
        attemptId,
        code: oldCode === '000000' ? '111111' : '000000',
      });

      const early = await resend(attemptId);
      expect(early.statusCode).toBe(429);
      expect(early.json().code).toBe('resend_too_soon');

      await backdate(attemptId, 61);
      const res = await resend(attemptId);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({
        method: 'otp',
        attemptId,
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      expect((await challengeRow(attemptId)).attempts).toBe(0);

      const newCode = codeFrom(mail.last());
      if (newCode !== oldCode) {
        expect((await confirm({ attemptId, code: oldCode })).statusCode).toBe(
          400,
        );
      }
      expect((await confirm({ attemptId, code: newCode })).statusCode).toBe(
        204,
      );
    });

    it('истёкший TTL не мешает resend', async () => {
      await createUser(app, email);
      const { attemptId } = (await login()).json<{ attemptId: string }>();
      await backdate(attemptId, 3600);
      expect((await resend(attemptId)).statusCode).toBe(202);
    });

    it('неизвестная или подтверждённая попытка → 400; неверный формат → 400', async () => {
      await createUser(app, email);
      const { attemptId } = (await login()).json<{ attemptId: string }>();
      await confirm({ attemptId, code: codeFrom(mail.last()) });
      await backdate(attemptId, 61);
      expect((await resend(attemptId)).json().code).toBe(
        'confirmation_invalid',
      );
      expect(
        (await resend('00000000-0000-4000-8000-000000000000')).statusCode,
      ).toBe(400);
      expect((await resend('nope')).json().code).toBe('validation_failed');
    });
  });

  // ───────────────────────── magic link ─────────────────────────

  describe('подтверждение magic link', () => {
    beforeEach(() => {
      settings.confirmationEnabled = true;
      settings.confirmationMethod = ConfirmationMethod.MagicLink;
    });

    it('ссылка с токеном во фрагменте → POST confirm → 204 и cookies', async () => {
      await createUser(app, email);
      const res = await login();
      expect(res.json()).toMatchObject({ method: 'magic_link' });
      const { attemptId } = res.json<{ attemptId: string }>();

      expect(mail.last().text).toContain(
        'http://front.test/login/confirm#token=',
      );
      const token = loginTokenFrom(mail.last());
      expect(token.startsWith(`${attemptId}.`)).toBe(true);

      const ok = await confirm({ token });
      expect(ok.statusCode).toBe(204);
      expectSessionCookies(ok);
    });

    it('неверный секрет → 400 без счётчика, верный после этого работает', async () => {
      await createUser(app, email);
      const { attemptId } = (await login()).json<{ attemptId: string }>();
      for (let i = 0; i < 6; i++) {
        expect(
          (await confirm({ token: `${attemptId}.${'B'.repeat(43)}` }))
            .statusCode,
        ).toBe(400);
      }
      expect((await challengeRow(attemptId)).attempts).toBe(0);
      expect(
        (await confirm({ token: loginTokenFrom(mail.last()) })).statusCode,
      ).toBe(204);
    });

    it('magic-попытку нельзя подтвердить OTP-формой', async () => {
      await createUser(app, email);
      const { attemptId } = (await login()).json<{ attemptId: string }>();
      expect((await confirm({ attemptId, code: '123456' })).statusCode).toBe(
        400,
      );
    });
  });
});
