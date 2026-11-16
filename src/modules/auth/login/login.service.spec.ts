import { HttpStatus } from '@nestjs/common';

import { AuditIds } from '@/core/audit/audit-ids';
import { AuditLogger } from '@/core/audit/audit-logger';
import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import { MailDeliveryError, MailSender } from '@/core/mail/mail-sender';
import { PasswordHasher } from '@/modules/auth/password/password-hasher';
import { ConfirmationMethod } from '@/modules/auth/registration/registration-challenge.entity';
import { TokenService } from '@/modules/auth/tokens/token.service';
import { UserStatus } from '@/modules/users/user.entity';
import { UsersService } from '@/modules/users/users.service';
import {
  LoginChallenge,
  LoginChallengeConsumedReason as Reason,
} from './login-challenge.entity';
import { LoginChallengeSecrets } from './login-challenge-secrets';
import { LoginFailureLimiter } from './login-failure-limiter';
import { LoginService } from './login.service';
import { LoginSettings } from './login.settings';

// Транзакции и блокировки проверяют e2e-тесты на настоящей БД.
// Здесь — ветки логики, которые на живой БД трудно воспроизвести
// (гонки, сбой подписи, неожиданная ошибка почты).
jest.mock('typeorm-transactional', () => ({
  Transactional: () => () => undefined,
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'user@example.com';

const secrets = new LoginChallengeSecrets({
  get: () => 'login-key-'.repeat(5),
} as unknown as ConfigService);

function makeChallenge(
  overrides: Partial<LoginChallenge> = {},
): LoginChallenge {
  return {
    id: ATTEMPT_ID,
    userId: USER_ID,
    method: ConfirmationMethod.Otp,
    secretHash: secrets.hash(ConfirmationMethod.Otp, ATTEMPT_ID, '123456'),
    lastSentAt: new Date(Date.now() - 120_000),
    attempts: 0,
    consumedAt: null,
    consumedReason: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/** Код ошибки и статус. */
async function failure(promise: Promise<unknown>): Promise<[number, string]> {
  const error = (await promise.catch((e: unknown) => e)) as AppException;
  expect(error).toBeInstanceOf(AppException);
  return [error.getStatus(), error.code];
}

describe('LoginService (ветки без БД)', () => {
  let challenges: Record<
    'findOne' | 'findOneBy' | 'update' | 'insert' | 'create',
    jest.Mock
  >;
  let users: Record<'findForLogin' | 'lockForAuth', jest.Mock>;
  let tokens: { issuePair: jest.Mock };
  let mail: { send: jest.Mock };
  let settings: {
    confirmationEnabled: boolean;
    confirmationMethod: ConfirmationMethod;
    confirmUrl: string;
  };
  let service: LoginService;

  beforeEach(async () => {
    challenges = {
      findOne: jest.fn(),
      findOneBy: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      insert: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((value: LoginChallenge) => value),
    };
    users = {
      findForLogin: jest.fn().mockResolvedValue({
        id: USER_ID,
        status: UserStatus.Active,
        passwordHash: 'h',
      }),
      lockForAuth: jest.fn().mockResolvedValue({
        id: USER_ID,
        status: UserStatus.Active,
        email: EMAIL,
      }),
    };
    tokens = {
      issuePair: jest
        .fn()
        .mockReturnValue({ accessToken: 'A', refreshToken: 'R' }),
    };
    mail = { send: jest.fn().mockResolvedValue(undefined) };
    settings = {
      confirmationEnabled: true,
      confirmationMethod: ConfirmationMethod.Otp,
      confirmUrl: 'http://front/login',
    };
    const hasher = {
      hash: jest.fn().mockResolvedValue('dummy'),
      verify: jest.fn().mockResolvedValue(true),
    };

    service = new LoginService(
      challenges as never,
      users as unknown as UsersService,
      hasher as unknown as PasswordHasher,
      secrets,
      tokens as unknown as TokenService,
      new LoginFailureLimiter(),
      mail as unknown as MailSender,
      settings as unknown as LoginSettings,
      { warn: jest.fn(), info: jest.fn() } as unknown as AuditLogger,
      { emailId: () => 'email-id' } as unknown as AuditIds,
    );
    await service.onModuleInit();
  });

  describe('login', () => {
    it('статус сменился до блокировки → 401 без письма', async () => {
      users.lockForAuth.mockResolvedValue({
        id: USER_ID,
        status: UserStatus.Blocked,
        email: EMAIL,
      });
      expect(
        await failure(
          service.login({ email: EMAIL, password: 'p' }, '1.1.1.1'),
        ),
      ).toEqual([HttpStatus.UNAUTHORIZED, 'invalid_credentials']);
      expect(mail.send).not.toHaveBeenCalled();
      expect(challenges.insert).not.toHaveBeenCalled();
    });

    it('параллельный login создал попытку между проверкой и блокировкой → 429', async () => {
      // Быстрая проверка (шаг 6) ещё не видит попытку, а под блокировкой (шаг 7) — видит.
      challenges.findOne.mockResolvedValue(
        makeChallenge({ lastSentAt: new Date() }),
      );
      expect(
        await failure(
          service.login({ email: EMAIL, password: 'p' }, '1.1.1.1'),
        ),
      ).toEqual([HttpStatus.TOO_MANY_REQUESTS, 'resend_too_soon']);
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('после паузы прежняя попытка гасится как replaced, новая вставляется', async () => {
      challenges.findOne.mockResolvedValue(makeChallenge());
      const result = await service.login(
        { email: EMAIL, password: 'p' },
        '1.1.1.1',
      );
      expect(result.kind).toBe('confirmation_required');
      expect(challenges.update).toHaveBeenCalledWith(
        { id: ATTEMPT_ID },
        expect.objectContaining({ consumedReason: Reason.Replaced }),
      );
      expect(challenges.insert).toHaveBeenCalledTimes(1);
    });

    it('неожиданная ошибка почты (не MailDeliveryError) не превращается в 503', async () => {
      challenges.findOne.mockResolvedValue(null);
      mail.send.mockRejectedValue(new TypeError('bug'));
      await expect(
        service.login({ email: EMAIL, password: 'p' }, '1.1.1.1'),
      ).rejects.toThrow(TypeError);
    });
  });

  describe('confirm', () => {
    const otp = (secret = '123456') => ({
      kind: ConfirmationMethod.Otp,
      attemptId: ATTEMPT_ID,
      secret,
    });

    it('сбой подписи → 503 изнутри транзакции, попытка не погашена', async () => {
      challenges.findOne.mockResolvedValue(makeChallenge());
      tokens.issuePair.mockImplementation(() => {
        throw new AppException(
          HttpStatus.SERVICE_UNAVAILABLE,
          'token_signing_failed',
        );
      });
      expect(await failure(service.confirm(otp()))).toEqual([
        503,
        'token_signing_failed',
      ]);
      // Погашение (`confirmed`) не выполнялось: подпись идёт раньше.
      expect(challenges.update).not.toHaveBeenCalled();
    });

    it('строка попытки исчезла между двумя чтениями → 400', async () => {
      challenges.findOne
        .mockResolvedValueOnce({ id: ATTEMPT_ID, userId: USER_ID })
        .mockResolvedValueOnce(null);
      expect(await failure(service.confirm(otp()))).toEqual([
        400,
        'confirmation_invalid',
      ]);
    });

    it('пользователь удалён (нет строки) → попытка гасится user_inactive, 401', async () => {
      challenges.findOne.mockResolvedValue(makeChallenge());
      users.lockForAuth.mockResolvedValue(null);
      expect(await failure(service.confirm(otp()))).toEqual([
        401,
        'invalid_credentials',
      ]);
      expect(challenges.update).toHaveBeenCalledWith(
        { id: ATTEMPT_ID },
        expect.objectContaining({ consumedReason: Reason.UserInactive }),
      );
    });
  });

  describe('resend', () => {
    it('неактивный пользователь → попытка гасится user_inactive, 401', async () => {
      challenges.findOne.mockResolvedValue(makeChallenge());
      users.lockForAuth.mockResolvedValue({
        id: USER_ID,
        status: UserStatus.Deleting,
        email: EMAIL,
      });
      expect(await failure(service.resend(ATTEMPT_ID))).toEqual([
        401,
        'invalid_credentials',
      ]);
    });

    it('SMTP упал → 503 с method, attemptId и retryAfterSeconds, без confirmationRequired', async () => {
      challenges.findOne.mockResolvedValue(makeChallenge());
      mail.send.mockRejectedValue(new MailDeliveryError(new Error('down')));
      const error = (await service
        .resend(ATTEMPT_ID)
        .catch((e: unknown) => e)) as AppException;
      expect(error.getStatus()).toBe(503);
      expect(error.extra).toEqual({
        method: 'otp',
        attemptId: ATTEMPT_ID,
        retryAfterSeconds: 60,
      });
      // Новый хеш уже сохранён до отправки.
      expect(challenges.update).toHaveBeenCalledWith(
        { id: ATTEMPT_ID },
        expect.objectContaining({ attempts: 0 }),
      );
    });
  });
});
