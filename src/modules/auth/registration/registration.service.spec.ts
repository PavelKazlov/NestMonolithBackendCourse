import { FindOperator, Repository } from 'typeorm';

import { AuditLogger } from '@/core/audit/audit-logger';
import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import {
  MailDeliveryError,
  MailMessage,
  MailSender,
} from '@/core/mail/mail-sender';
import { PasswordHasher } from '@/modules/auth/password/password-hasher';
import { User, UserStatus } from '@/modules/users/user.entity';
import { emailTakenError, UsersService } from '@/modules/users/users.service';
import { ChallengeSecrets } from './challenge-secrets';
import {
  ConfirmationMethod,
  RegistrationChallenge,
} from './registration-challenge.entity';
import { RegistrationService } from './registration.service';
import { RegistrationSettings } from './registration.settings';

// Транзакции проверяют e2e-тесты на настоящей БД. Здесь — только логика.
jest.mock('typeorm-transactional', () => ({
  Transactional: () => () => undefined,
}));

const NOW = new Date('2026-11-06T10:00:00.000Z');
const USER_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';

const secrets = new ChallengeSecrets({
  get: () => 'test-hmac-key-'.repeat(4),
} as unknown as ConfigService);

function makeUser(status = UserStatus.Pending): User {
  return {
    id: USER_ID,
    email: 'user@example.com',
    status,
  } as User;
}

/** Попытка в БД. По умолчанию — свежая OTP-попытка с кодом 123456. */
function makeChallenge(
  overrides: Partial<RegistrationChallenge> = {},
): RegistrationChallenge {
  return {
    id: ATTEMPT_ID,
    userId: USER_ID,
    method: ConfirmationMethod.Otp,
    secretHash: secrets.hash(ConfirmationMethod.Otp, ATTEMPT_ID, '123456'),
    attempts: 0,
    lastSentAt: new Date(NOW.getTime() - 120_000),
    expiresAt: new Date(NOW.getTime() + 480_000),
    consumedAt: null,
    ...overrides,
  };
}

/** Достаёт секрет из текста письма: 6 цифр или токен после `#token=`. */
function secretFrom(mail: MailMessage): string {
  return (
    /#token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1] ??
    /\b(\d{6})\b/.exec(mail.text)![1]
  );
}

describe('RegistrationService', () => {
  // Моки зависимостей: только методы, которые вызывает сервис.
  let challenges: Record<
    'create' | 'insert' | 'findOne' | 'findOneBy' | 'update',
    jest.Mock
  >;
  let users: jest.Mocked<
    Pick<
      UsersService,
      'findByEmail' | 'createActive' | 'createPending' | 'activate'
    >
  >;
  let hasher: jest.Mocked<Pick<PasswordHasher, 'hash'>>;
  let mail: jest.Mocked<MailSender>;
  let settings: {
    confirmationEnabled: boolean;
    confirmationMethod: ConfirmationMethod;
    confirmUrl: string;
  };
  let audit: jest.Mocked<Pick<AuditLogger, 'info' | 'warn'>>;
  let service: RegistrationService;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });

    challenges = {
      create: jest.fn((data) => data as RegistrationChallenge),
      insert: jest.fn().mockResolvedValue({}),
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      update: jest
        .fn()
        .mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] }),
    };
    users = {
      findByEmail: jest.fn().mockResolvedValue(null),
      createActive: jest.fn().mockResolvedValue(makeUser(UserStatus.Active)),
      createPending: jest.fn().mockResolvedValue(makeUser()),
      activate: jest.fn().mockResolvedValue(makeUser(UserStatus.Active)),
    };
    hasher = { hash: jest.fn().mockResolvedValue('$argon2id$hash') };
    mail = { send: jest.fn().mockResolvedValue(undefined) };
    settings = {
      confirmationEnabled: true,
      confirmationMethod: ConfirmationMethod.Otp,
      confirmUrl: 'http://front/confirm',
    };
    audit = { info: jest.fn(), warn: jest.fn() };

    service = new RegistrationService(
      challenges as unknown as Repository<RegistrationChallenge>,
      users as unknown as UsersService,
      hasher as unknown as PasswordHasher,
      secrets,
      mail,
      settings as unknown as RegistrationSettings,
      audit as unknown as AuditLogger,
    );
  });

  afterEach(() => jest.useRealTimers());

  const dto = { email: 'user@example.com', password: 'секрет12' };

  /** Все записи аудита одной строкой — чтобы проверить, что там нет секретов. */
  const auditDump = () =>
    JSON.stringify([...audit.info.mock.calls, ...audit.warn.mock.calls]);

  // ───────────────────────────── register ─────────────────────────────

  describe('register', () => {
    it('занятый email → 409 до хеширования пароля', async () => {
      users.findByEmail.mockResolvedValue(makeUser(UserStatus.Active));

      await expect(service.register(dto)).rejects.toMatchObject({
        status: 409,
        code: 'email_taken',
      });
      expect(hasher.hash).not.toHaveBeenCalled();
      expect(audit.warn).toHaveBeenCalledWith('registration.failed', {
        reason: 'email_taken',
        existingUserId: USER_ID,
      });
    });

    it('pending тоже занимает email (повторная регистрация → 409)', async () => {
      users.findByEmail.mockResolvedValue(makeUser(UserStatus.Pending));

      await expect(service.register(dto)).rejects.toMatchObject({
        status: 409,
      });
    });

    it('подтверждение выключено → active, без попытки и письма', async () => {
      settings.confirmationEnabled = false;

      const result = await service.register(dto);

      expect(result).toEqual({
        kind: 'active',
        user: makeUser(UserStatus.Active),
      });
      expect(users.createActive).toHaveBeenCalledWith(
        'user@example.com',
        '$argon2id$hash',
      );
      expect(hasher.hash).toHaveBeenCalledWith('секрет12');
      expect(challenges.insert).not.toHaveBeenCalled();
      expect(mail.send).not.toHaveBeenCalled();
      expect(audit.info).toHaveBeenCalledWith('registration.succeeded', {
        userId: USER_ID,
        status: UserStatus.Active,
      });
    });

    it('OTP: pending + попытка с HMAC кода из письма, TTL 10 минут', async () => {
      const result = await service.register(dto);

      expect(users.createPending).toHaveBeenCalledWith(
        'user@example.com',
        '$argon2id$hash',
      );
      expect(result.kind).toBe('confirmation_required');
      const challenge = challenges.insert.mock
        .calls[0][0] as RegistrationChallenge;
      expect(challenge).toMatchObject({
        userId: USER_ID,
        method: ConfirmationMethod.Otp,
        attempts: 0,
        consumedAt: null,
        lastSentAt: NOW,
        expiresAt: new Date(NOW.getTime() + 600_000),
      });

      const sent = mail.send.mock.calls[0][0];
      expect(sent.to).toBe('user@example.com');
      const code = secretFrom(sent);
      // В БД — HMAC именно того кода, что ушёл в письме, а не сам код.
      expect(challenge.secretHash).toEqual(
        secrets.hash(ConfirmationMethod.Otp, challenge.id, code),
      );
      expect(audit.info).toHaveBeenCalledWith(
        'registration.confirmation.sent',
        expect.objectContaining({
          attemptId: challenge.id,
          trigger: 'register',
        }),
      );
      expect(auditDump()).not.toContain(code);
    });

    it('magic link: в БД — HMAC токена, в письме — ссылка с токеном', async () => {
      settings.confirmationMethod = ConfirmationMethod.MagicLink;

      await service.register(dto);

      const challenge = challenges.insert.mock
        .calls[0][0] as RegistrationChallenge;
      const sent = mail.send.mock.calls[0][0];
      expect(sent.text).toContain('http://front/confirm#token=');
      const token = secretFrom(sent);
      expect(challenge.method).toBe(ConfirmationMethod.MagicLink);
      expect(challenge.secretHash).toEqual(secrets.hashToken(token));
      expect(auditDump()).not.toContain(token);
    });

    it('гонка: email заняли между проверкой и INSERT → 409 и аудит', async () => {
      users.createPending.mockRejectedValue(emailTakenError());

      await expect(service.register(dto)).rejects.toMatchObject({
        status: 409,
      });
      expect(audit.warn).toHaveBeenCalledWith(
        'registration.failed',
        expect.objectContaining({ reason: 'email_taken' }),
      );
    });

    it('сбой SMTP → 503 с attemptId, данные уже сохранены', async () => {
      mail.send.mockRejectedValue(new MailDeliveryError(new Error('down')));

      const error = (await service
        .register(dto)
        .catch((e: unknown) => e)) as AppException;

      expect(error).toBeInstanceOf(AppException);
      expect(error.getStatus()).toBe(503);
      expect(error.code).toBe('mail_delivery_failed');
      const challenge = challenges.insert.mock
        .calls[0][0] as RegistrationChallenge;
      expect(error.extra).toEqual({
        attemptId: challenge.id,
        resendAfterSeconds: 60,
      });
      expect(audit.warn).toHaveBeenCalledWith(
        'registration.confirmation.send_failed',
        expect.objectContaining({ attemptId: challenge.id }),
      );
    });

    it('неожиданная ошибка почты — не 503, а пробрасывается (станет 500)', async () => {
      const bug = new TypeError('bug');
      mail.send.mockRejectedValue(bug);

      await expect(service.register(dto)).rejects.toBe(bug);
    });
  });

  // ───────────────────────────── confirm ──────────────────────────────

  describe('confirm (OTP)', () => {
    const input = {
      kind: 'otp' as const,
      attemptId: ATTEMPT_ID,
      code: '123456',
    };

    it('ищет попытку по id и способу с блокировкой FOR UPDATE', async () => {
      challenges.findOne.mockResolvedValue(makeChallenge());

      await service.confirm(input);

      expect(challenges.findOne).toHaveBeenCalledWith({
        where: { id: ATTEMPT_ID, method: ConfirmationMethod.Otp },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('верный код → попытка погашена, пользователь активирован', async () => {
      challenges.findOne.mockResolvedValue(makeChallenge());

      const user = await service.confirm(input);

      expect(user.status).toBe(UserStatus.Active);
      expect(challenges.update).toHaveBeenCalledWith(
        { id: ATTEMPT_ID },
        { consumedAt: NOW },
      );
      expect(users.activate).toHaveBeenCalledWith(USER_ID);
      expect(audit.info).toHaveBeenCalledWith(
        'registration.confirmation.succeeded',
        { method: 'otp', attemptId: ATTEMPT_ID, userId: USER_ID },
      );
    });

    it('пятая попытка ещё может быть успешной', async () => {
      challenges.findOne.mockResolvedValue(makeChallenge({ attempts: 4 }));

      await expect(service.confirm(input)).resolves.toBeDefined();
    });

    it('попытка не найдена → 400 confirmation_invalid', async () => {
      challenges.findOne.mockResolvedValue(null);

      await expect(service.confirm(input)).rejects.toMatchObject({
        status: 400,
        code: 'confirmation_invalid',
      });
      expect(audit.warn).toHaveBeenCalledWith(
        'registration.confirmation.failed',
        expect.objectContaining({ reason: 'not_found' }),
      );
    });

    it('неверный код → 400, счётчик +1, попытка не погашена', async () => {
      challenges.findOne.mockResolvedValue(makeChallenge({ attempts: 1 }));

      await expect(
        service.confirm({ ...input, code: '000000' }),
      ).rejects.toMatchObject({ status: 400, code: 'confirmation_invalid' });
      expect(challenges.update).toHaveBeenCalledWith(
        { id: ATTEMPT_ID },
        { attempts: 2, consumedAt: null },
      );
      expect(users.activate).not.toHaveBeenCalled();
    });

    it('пятый неверный ввод → всё ещё 400, но попытка погашена', async () => {
      challenges.findOne.mockResolvedValue(makeChallenge({ attempts: 4 }));

      await expect(
        service.confirm({ ...input, code: '000000' }),
      ).rejects.toMatchObject({ status: 400, code: 'confirmation_invalid' });
      expect(challenges.update).toHaveBeenCalledWith(
        { id: ATTEMPT_ID },
        { attempts: 5, consumedAt: NOW },
      );
    });

    it('после пятого неверного даже верный код → 429 attempts_exhausted', async () => {
      challenges.findOne.mockResolvedValue(
        makeChallenge({ attempts: 5, consumedAt: NOW }),
      );

      await expect(service.confirm(input)).rejects.toMatchObject({
        status: 429,
        code: 'attempts_exhausted',
      });
      expect(challenges.update).not.toHaveBeenCalled();
    });

    it('уже подтверждённая попытка → 400 как неверный код', async () => {
      challenges.findOne.mockResolvedValue(
        makeChallenge({ attempts: 1, consumedAt: NOW }),
      );

      await expect(service.confirm(input)).rejects.toMatchObject({
        status: 400,
        code: 'confirmation_invalid',
      });
    });

    it('просроченная → 400 confirmation_expired, счётчик не растёт', async () => {
      challenges.findOne.mockResolvedValue(makeChallenge({ expiresAt: NOW }));

      await expect(service.confirm(input)).rejects.toMatchObject({
        status: 400,
        code: 'confirmation_expired',
      });
      expect(challenges.update).not.toHaveBeenCalled();
    });
  });

  describe('confirm (magic link)', () => {
    const token = 'T'.repeat(43);

    it('ищет по HMAC токена и ТОЛЬКО среди magic link', async () => {
      challenges.findOne.mockResolvedValue(
        makeChallenge({
          method: ConfirmationMethod.MagicLink,
          secretHash: secrets.hashToken(token),
        }),
      );

      await service.confirm({ kind: 'magic_link', token });

      expect(challenges.findOne).toHaveBeenCalledWith({
        where: {
          secretHash: secrets.hashToken(token),
          method: ConfirmationMethod.MagicLink,
        },
        lock: { mode: 'pessimistic_write' },
      });
      expect(audit.info).toHaveBeenCalledWith(
        'registration.confirmation.succeeded',
        expect.objectContaining({
          method: 'magic_link',
          attemptId: ATTEMPT_ID,
        }),
      );
    });

    it('неизвестный токен → 400, без attemptId в аудите', async () => {
      challenges.findOne.mockResolvedValue(null);

      await expect(
        service.confirm({ kind: 'magic_link', token }),
      ).rejects.toMatchObject({ status: 400 });
      expect(audit.warn).toHaveBeenCalledWith(
        'registration.confirmation.failed',
        expect.objectContaining({ attemptId: undefined, reason: 'not_found' }),
      );
    });
  });

  // ───────────────────────────── resend ───────────────────────────────

  describe('resend', () => {
    beforeEach(() => {
      users.findByEmail.mockResolvedValue(makeUser());
      challenges.findOneBy.mockResolvedValue(makeChallenge());
    });

    it('новый секрет, TTL заново, счётчик 0, условие на 60 секунд', async () => {
      const result = await service.resend('user@example.com');

      const [where, values] = challenges.update.mock.calls[0] as [
        { id: string; lastSentAt: FindOperator<Date> },
        Partial<RegistrationChallenge>,
      ];
      expect(where.id).toBe(ATTEMPT_ID);
      expect(where.lastSentAt.type).toBe('lessThanOrEqual');
      expect(where.lastSentAt.value).toEqual(new Date(NOW.getTime() - 60_000));
      expect(values).toMatchObject({
        attempts: 0,
        consumedAt: null,
        lastSentAt: NOW,
        expiresAt: new Date(NOW.getTime() + 600_000),
      });

      const code = secretFrom(mail.send.mock.calls[0][0]);
      expect(values.secretHash).toEqual(
        secrets.hash(ConfirmationMethod.Otp, ATTEMPT_ID, code),
      );
      // attemptId не меняется: клиент продолжает слать тот же.
      expect(result.id).toBe(ATTEMPT_ID);
      expect(audit.info).toHaveBeenCalledWith(
        'registration.confirmation.sent',
        expect.objectContaining({ trigger: 'resend' }),
      );
    });

    it('способ берётся из попытки, а не из текущего флага', async () => {
      settings.confirmationEnabled = false;
      settings.confirmationMethod = ConfirmationMethod.MagicLink;

      await service.resend('user@example.com');

      expect(secretFrom(mail.send.mock.calls[0][0])).toMatch(/^\d{6}$/);
    });

    it('раньше 60 секунд → 429 resend_too_soon с retryAfterSeconds', async () => {
      challenges.findOneBy.mockResolvedValue(
        makeChallenge({ lastSentAt: new Date(NOW.getTime() - 20_000) }),
      );
      challenges.update.mockResolvedValue({
        affected: 0,
        raw: [],
        generatedMaps: [],
      });

      const error = (await service
        .resend('user@example.com')
        .catch((e: unknown) => e)) as AppException;

      expect(error.getStatus()).toBe(429);
      expect(error.code).toBe('resend_too_soon');
      expect(error.extra).toEqual({ retryAfterSeconds: 40 });
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('неизвестный email → 400 confirmation_invalid', async () => {
      users.findByEmail.mockResolvedValue(null);

      await expect(service.resend('x@y.zz')).rejects.toMatchObject({
        status: 400,
        code: 'confirmation_invalid',
      });
      expect(audit.warn).toHaveBeenCalledWith('registration.resend.failed', {
        reason: 'not_found',
        userId: undefined,
      });
    });

    it('уже активный пользователь → 400 (подтверждать нечего)', async () => {
      users.findByEmail.mockResolvedValue(makeUser(UserStatus.Active));

      await expect(service.resend('user@example.com')).rejects.toMatchObject({
        status: 400,
      });
      expect(challenges.findOneBy).not.toHaveBeenCalled();
      expect(audit.warn).toHaveBeenCalledWith(
        'registration.resend.failed',
        expect.objectContaining({ reason: 'not_pending' }),
      );
    });

    it('сбой SMTP при resend → 503', async () => {
      mail.send.mockRejectedValue(new MailDeliveryError(new Error('down')));

      await expect(service.resend('user@example.com')).rejects.toMatchObject({
        status: 503,
        code: 'mail_delivery_failed',
      });
    });
  });
});
