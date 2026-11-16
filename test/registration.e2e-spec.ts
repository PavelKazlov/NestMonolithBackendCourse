import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';

import {
  MailDeliveryError,
  MailMessage,
  MailSender,
} from '@/core/mail/mail-sender';
import { ConfirmationMethod } from '@/modules/auth/registration/registration-challenge.entity';
import { RegistrationSettings } from '@/modules/auth/registration/registration.settings';
import { UserActivationHook } from '@/modules/users/user-activation.hook';
import { createTestApp } from './utils/create-test-app';

/**
 * Фейковая почта: вместо SMTP складывает письма в массив.
 * Так тест «читает почтовый ящик» и достаёт из письма код или токен,
 * как это сделал бы пользователь. `failing = true` имитирует упавший SMTP.
 */
class FakeMailSender extends MailSender {
  sent: MailMessage[] = [];
  failing = false;

  send(message: MailMessage): Promise<void> {
    if (this.failing) {
      return Promise.reject(new MailDeliveryError(new Error('SMTP down')));
    }
    this.sent.push(message);
    return Promise.resolve();
  }

  last(): MailMessage {
    return this.sent[this.sent.length - 1];
  }
}

/** Изменяемые настройки сценария: переключаем флаг между тестами в одном приложении. */
const settings = {
  confirmationEnabled: false,
  confirmationMethod: ConfirmationMethod.Otp,
  confirmUrl: 'http://front.test/register/confirm',
};

/** Хук активации: проверяем, что вызывается и что его ошибка откатывает активацию. */
const activationHook = { onActivated: jest.fn() };

const codeFrom = (mail: MailMessage) => /\b(\d{6})\b/.exec(mail.text)![1];
const tokenFrom = (mail: MailMessage) =>
  /#token=([A-Za-z0-9_-]{43})/.exec(mail.text)![1];

describe('Registration 1.0 (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DataSource;
  const mail = new FakeMailSender();

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder
        .overrideProvider(MailSender)
        .useValue(mail)
        .overrideProvider(RegistrationSettings)
        .useValue(settings)
        .overrideProvider(UserActivationHook)
        .useValue(activationHook),
    );
    db = app.get(DataSource);
  });

  beforeEach(async () => {
    // Чистая БД перед каждым тестом. CASCADE удалит и попытки (FK на users).
    await db.query('TRUNCATE users CASCADE');
    mail.sent = [];
    mail.failing = false;
    settings.confirmationEnabled = false;
    settings.confirmationMethod = ConfirmationMethod.Otp;
    activationHook.onActivated.mockReset().mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, payload });
  const register = (email = 'user@example.com', password = 'секрет12') =>
    post('/auth/register', { email, password });
  const confirm = (payload: Record<string, unknown>) =>
    post('/auth/register/confirm', payload);
  const resend = (email = 'user@example.com') =>
    post('/auth/register/resend', { email });

  /** Строки таблиц, как их возвращает драйвер pg (snake_case, bytea → Buffer). */
  interface UserRow {
    id: string;
    status: string;
    password_hash: string;
  }
  interface ChallengeRow {
    attempts: number;
    consumed_at: Date | null;
    secret_hash: Buffer;
  }

  const userRow = async (email = 'user@example.com') =>
    (
      await db.query<UserRow[]>('SELECT * FROM users WHERE email = $1', [email])
    )[0];
  const challengeRow = async (id: string) =>
    (
      await db.query<ChallengeRow[]>(
        'SELECT * FROM registration_challenges WHERE id = $1',
        [id],
      )
    )[0];

  /** Сдвигает отправку письма в прошлое (оба поля — из-за CHECK в БД). */
  const backdate = (attemptId: string, seconds: number) =>
    db.query(
      `UPDATE registration_challenges
          SET last_sent_at = last_sent_at - make_interval(secs => $2),
              expires_at   = expires_at   - make_interval(secs => $2)
        WHERE id = $1`,
      [attemptId, seconds],
    );

  // ───────────────────── регистрация без подтверждения ─────────────────────

  describe('без подтверждения', () => {
    it('201: active, нормализованный email, ни пароля, ни хеша в ответе', async () => {
      const res = await register('  User@Example.COM ');

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        email: 'user@example.com',
        status: 'active',
      });
      expect(res.body).not.toContain('секрет12');
      expect(res.body).not.toContain('argon2');
      expect(mail.sent).toHaveLength(0);

      const row = await userRow();
      expect(row.status).toBe('active');
      expect(row.password_hash).toMatch(/^\$argon2id\$/);
      // Хук «назначить роль» вызван в момент активации.
      expect(activationHook.onActivated).toHaveBeenCalledWith(row.id);
    });

    it('409 на тот же email в другом регистре и с пробелами', async () => {
      await register('user@example.com');

      const res = await register(' USER@example.com');

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'email_taken' });
    });

    it('user+tag@example.com — отдельный адрес', async () => {
      await register('user@example.com');

      expect((await register('user+tag@example.com')).statusCode).toBe(201);
    });

    it('параллельные регистрации одного email: одна 201, другая 409, не 500', async () => {
      const results = await Promise.all([register(), register(), register()]);

      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    });

    it('ошибка хука в транзакции откатывает создание пользователя', async () => {
      activationHook.onActivated.mockRejectedValue(new Error('rbac down'));

      expect((await register()).statusCode).toBe(500);
      expect(await userRow()).toBeUndefined();
    });
  });

  describe('валидация (400)', () => {
    it.each([
      [{ email: 'not-an-email', password: 'секрет12' }],
      [{ email: 'user@example.com', password: 'short1' }],
      [{ email: 'user@example.com', password: 'onlyletters' }],
      [{ email: 'user@example.com', password: 'a1'.repeat(65) }],
      [{ email: 'user@example.com', password: 'секрет12', role: 'admin' }],
    ])('%p → 400 validation_failed', async (payload) => {
      const res = await post('/auth/register', payload);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'validation_failed' });
      expect(await userRow()).toBeUndefined();
    });
  });

  // ─────────────────────────────── OTP ───────────────────────────────

  describe('подтверждение кодом (OTP)', () => {
    beforeEach(() => {
      settings.confirmationEnabled = true;
    });

    it('202 без секрета → письмо с кодом → 200 active', async () => {
      const res = await register();

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body).toEqual({
        confirmationRequired: true,
        method: 'otp',
        attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      const code = codeFrom(mail.last());
      expect(res.body).not.toContain(code);
      expect(mail.last().to).toBe('user@example.com');

      // pending, роли ещё нет, email уже занят.
      expect((await userRow()).status).toBe('pending');
      expect(activationHook.onActivated).not.toHaveBeenCalled();
      expect((await register()).statusCode).toBe(409);

      // В БД — 32 байта HMAC, а не код.
      const stored = await challengeRow(body.attemptId);
      expect(stored.secret_hash).toHaveLength(32);
      expect(stored.secret_hash.toString('utf8')).not.toContain(code);

      const ok = await confirm({ attemptId: body.attemptId, code });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({
        id: (await userRow()).id,
        email: 'user@example.com',
        status: 'active',
      });
      expect(activationHook.onActivated).toHaveBeenCalledTimes(1);

      // Попытка погашена: повторно тот же код не проходит.
      expect((await challengeRow(body.attemptId)).consumed_at).not.toBeNull();
      const again = await confirm({ attemptId: body.attemptId, code });
      expect(again.statusCode).toBe(400);
      expect(again.json().code).toBe('confirmation_invalid');
    });

    it('неизвестный attemptId → 400 как неверный код', async () => {
      const res = await confirm({
        attemptId: '00000000-0000-4000-8000-000000000000',
        code: '123456',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('confirmation_invalid');
    });

    it('5 неверных: пятый — 400, следующий даже с верным кодом — 429', async () => {
      const { attemptId } = (await register()).json();
      const code = codeFrom(mail.last());
      const wrong = code === '000000' ? '111111' : '000000';

      for (let i = 1; i <= 5; i++) {
        const res = await confirm({ attemptId, code: wrong });
        expect(res.statusCode).toBe(400);
      }
      expect((await challengeRow(attemptId)).attempts).toBe(5);

      const blocked = await confirm({ attemptId, code });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().code).toBe('attempts_exhausted');
      expect((await userRow()).status).toBe('pending');
    });

    it('параллельные неверные вводы не обходят лимит (SELECT FOR UPDATE)', async () => {
      const { attemptId } = (await register()).json();
      const code = codeFrom(mail.last());
      const wrong = code === '000000' ? '111111' : '000000';

      const results = await Promise.all(
        Array.from({ length: 8 }, () => confirm({ attemptId, code: wrong })),
      );

      // Ровно 5 «неверный код», остальные — «лимит исчерпан».
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([400, 400, 400, 400, 400, 429, 429, 429]);
      expect((await challengeRow(attemptId)).attempts).toBe(5);
    });

    it('пятая попытка ещё может быть успешной', async () => {
      const { attemptId } = (await register()).json();
      const code = codeFrom(mail.last());
      const wrong = code === '000000' ? '111111' : '000000';

      for (let i = 0; i < 4; i++) await confirm({ attemptId, code: wrong });

      expect((await confirm({ attemptId, code })).statusCode).toBe(200);
    });

    it('просроченный код → 400 confirmation_expired, счётчик не растёт', async () => {
      const { attemptId } = (await register()).json();
      await backdate(attemptId, 601);

      const res = await confirm({ attemptId, code: codeFrom(mail.last()) });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('confirmation_expired');
      expect((await challengeRow(attemptId)).attempts).toBe(0);
    });
  });

  // ───────────────────────────── resend ──────────────────────────────

  describe('повторная отправка', () => {
    beforeEach(() => {
      settings.confirmationEnabled = true;
    });

    it('раньше 60 с → 429 resend_too_soon с Retry-After', async () => {
      await register();

      const res = await resend();

      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({
        code: 'resend_too_soon',
        retryAfterSeconds: expect.any(Number),
      });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(55);
      expect(mail.sent).toHaveLength(1);
    });

    it('через 60 с: новый код, старый не подходит, тот же attemptId', async () => {
      const { attemptId } = (await register()).json();
      const oldCode = codeFrom(mail.last());
      await backdate(attemptId, 61);

      const res = await resend(' USER@example.com ');

      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ attemptId, method: 'otp' });
      const newCode = codeFrom(mail.last());
      if (newCode !== oldCode) {
        // Старый код больше не подходит (кроме редкого совпадения 1:10^6).
        expect((await confirm({ attemptId, code: oldCode })).statusCode).toBe(
          400,
        );
      }
      expect((await confirm({ attemptId, code: newCode })).statusCode).toBe(
        200,
      );
    });

    it('resend после исчерпания лимита обнуляет счётчик', async () => {
      const { attemptId } = (await register()).json();
      const wrong = codeFrom(mail.last()) === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) await confirm({ attemptId, code: wrong });
      await backdate(attemptId, 61);

      expect((await resend()).statusCode).toBe(202);
      expect((await challengeRow(attemptId)).attempts).toBe(0);
      expect(
        (await confirm({ attemptId, code: codeFrom(mail.last()) })).statusCode,
      ).toBe(200);
    });

    it('параллельные resend: письмо уходит один раз', async () => {
      const { attemptId } = (await register()).json();
      await backdate(attemptId, 61);

      const results = await Promise.all([resend(), resend(), resend()]);

      expect(results.map((r) => r.statusCode).sort()).toEqual([202, 429, 429]);
      expect(mail.sent).toHaveLength(2); // регистрация + один resend
    });

    it('неизвестный или уже активный email → 400', async () => {
      expect((await resend('nobody@example.com')).statusCode).toBe(400);

      settings.confirmationEnabled = false;
      await register();
      const res = await resend();
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('confirmation_invalid');
    });

    it('флаг выключили после регистрации: pending остаётся, resend и confirm работают', async () => {
      const { attemptId } = (await register()).json();
      settings.confirmationEnabled = false;
      settings.confirmationMethod = ConfirmationMethod.MagicLink;

      expect((await userRow()).status).toBe('pending');
      await backdate(attemptId, 61);
      // Способ — из попытки (otp), а не из текущих настроек.
      expect((await resend()).json().method).toBe('otp');
      expect(
        (await confirm({ attemptId, code: codeFrom(mail.last()) })).statusCode,
      ).toBe(200);
    });
  });

  // ─────────────────────────── magic link ────────────────────────────

  describe('подтверждение ссылкой (magic link)', () => {
    beforeEach(() => {
      settings.confirmationEnabled = true;
      settings.confirmationMethod = ConfirmationMethod.MagicLink;
    });

    it('202 → ссылка с токеном во фрагменте → POST token → 200; повтор → 400', async () => {
      const res = await register();
      expect(res.statusCode).toBe(202);
      expect(res.json().method).toBe('magic_link');

      expect(mail.last().text).toContain(
        'http://front.test/register/confirm#token=',
      );
      const token = tokenFrom(mail.last());
      expect(res.body).not.toContain(token);

      const ok = await confirm({ token });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().status).toBe('active');

      // Токен одноразовый.
      expect((await confirm({ token })).statusCode).toBe(400);
    });

    it('GET по ссылке ничего не активирует (маршрута нет)', async () => {
      await register();
      const token = tokenFrom(mail.last());

      const res = await app.inject({
        method: 'GET',
        url: `/auth/register/confirm?token=${token}`,
      });

      expect(res.statusCode).toBe(404);
      expect((await userRow()).status).toBe('pending');
    });

    it('чужой токен → 400', async () => {
      await register();

      const res = await confirm({ token: 'A'.repeat(43) });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('confirmation_invalid');
    });

    it('OTP-код к попытке magic link не подходит', async () => {
      const { attemptId } = (await register()).json();

      const res = await confirm({ attemptId, code: '123456' });

      expect(res.statusCode).toBe(400);
    });

    it('resend гасит старую ссылку', async () => {
      const { attemptId } = (await register()).json();
      const oldToken = tokenFrom(mail.last());
      await backdate(attemptId, 61);

      await resend();

      expect((await confirm({ token: oldToken })).statusCode).toBe(400);
      expect(
        (await confirm({ token: tokenFrom(mail.last()) })).statusCode,
      ).toBe(200);
    });

    it('токен вместе с attemptId и code → 400 validation_failed', async () => {
      const { attemptId } = (await register()).json();

      const res = await confirm({
        token: tokenFrom(mail.last()),
        attemptId,
        code: '123456',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('validation_failed');
    });
  });

  // ───────────────────────────── сбой SMTP ─────────────────────────────

  describe('сбой почты', () => {
    beforeEach(() => {
      settings.confirmationEnabled = true;
    });

    it('503 с attemptId; pending и попытка сохранены; повторный register — 409; письмо — через resend', async () => {
      mail.failing = true;

      const res = await register();

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body).toMatchObject({
        code: 'mail_delivery_failed',
        attemptId: expect.any(String),
        resendAfterSeconds: 60,
      });
      expect((await userRow()).status).toBe('pending');
      expect(await challengeRow(body.attemptId)).toBeDefined();

      mail.failing = false;
      expect((await register()).statusCode).toBe(409);

      await backdate(body.attemptId, 61);
      expect((await resend()).statusCode).toBe(202);
      expect(
        (
          await confirm({
            attemptId: body.attemptId,
            code: codeFrom(mail.last()),
          })
        ).statusCode,
      ).toBe(200);
    });
  });

  // ─────────────────────── транзакция confirm ────────────────────────

  it('ошибка хука при confirm откатывает и активацию, и погашение попытки', async () => {
    settings.confirmationEnabled = true;
    const { attemptId } = (await register()).json();
    activationHook.onActivated.mockRejectedValue(new Error('rbac down'));

    const res = await confirm({ attemptId, code: codeFrom(mail.last()) });

    expect(res.statusCode).toBe(500);
    expect((await userRow()).status).toBe('pending');
    expect((await challengeRow(attemptId)).consumed_at).toBeNull();
  });

  it('OpenAPI описывает три операции регистрации', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs-json' });
    const paths = Object.keys(res.json().paths as object);

    expect(paths).toEqual(
      expect.arrayContaining([
        '/auth/register',
        '/auth/register/confirm',
        '/auth/register/resend',
      ]),
    );
  });
});
