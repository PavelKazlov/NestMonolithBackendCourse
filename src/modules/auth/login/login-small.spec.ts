import { plainToInstance } from 'class-transformer';
import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
} from '@nestjs/common';
import { validateSync } from 'class-validator';
import { lastValueFrom, of, throwError } from 'rxjs';

import { AuditLogger } from '@/core/audit/audit-logger';
import { ConfigService } from '@/core/config/config.service';
import { ConfirmationMethod } from '@/modules/auth/registration/registration-challenge.entity';
import {
  ConfirmLoginDto,
  toLoginConfirmationInput,
} from './dto/confirm-login.dto';
import { LoginDto } from './dto/login.dto';
import {
  LoginChallengeResponse,
  LoginResendResponse,
} from './dto/login-responses.dto';
import { ResendLoginDto } from './dto/resend-login.dto';
import { challengeExpiresAt } from './login-challenge.entity';
import { LoginChallengeSecrets } from './login-challenge-secrets';
import { LoginAuditInterceptor } from './login-audit.interceptor';
import { buildLoginMail, buildMagicLinkToken } from './login-mail';
import { LoginSettings } from './login.settings';

const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const SECRET = 'A'.repeat(43);

/** Ошибки валидации DTO (как их увидел бы ValidationPipe). */
function errorsOf<T extends object>(cls: new () => T, body: object): string[] {
  const dto = plainToInstance(cls, body);
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map(
    (error) => error.property,
  );
}

describe('LoginDto', () => {
  it('нормализует email, пароль оставляет как есть', () => {
    const dto = plainToInstance(LoginDto, {
      email: '  User@Example.COM ',
      password: ' pass word ',
    });
    expect(dto.email).toBe('user@example.com');
    expect(dto.password).toBe(' pass word ');
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('отклоняет плохой email, пустой и слишком длинный пароль, лишние поля', () => {
    expect(errorsOf(LoginDto, { email: 'bad', password: 'x' })).toEqual([
      'email',
    ]);
    expect(errorsOf(LoginDto, { email: 'a@b.co', password: '' })).toEqual([
      'password',
    ]);
    expect(
      errorsOf(LoginDto, { email: 'a@b.co', password: 'x'.repeat(129) }),
    ).toEqual(['password']);
    expect(
      errorsOf(LoginDto, { email: 'a@b.co', password: 'x', role: 'admin' }),
    ).toEqual(['role']);
  });
});

describe('ConfirmLoginDto', () => {
  it('OTP: attemptId + 6 цифр', () => {
    expect(
      errorsOf(ConfirmLoginDto, { attemptId: ATTEMPT_ID, code: '042917' }),
    ).toEqual([]);
    expect(
      errorsOf(ConfirmLoginDto, { attemptId: 'x', code: '12345' }),
    ).toEqual(['attemptId', 'code']);
  });

  it('magic link: token = attemptId.secret(43)', () => {
    expect(
      errorsOf(ConfirmLoginDto, { token: `${ATTEMPT_ID}.${SECRET}` }),
    ).toEqual([]);
    expect(errorsOf(ConfirmLoginDto, { token: SECRET })).toEqual(['token']);
    expect(errorsOf(ConfirmLoginDto, { token: `${ATTEMPT_ID}.short` })).toEqual(
      ['token'],
    );
  });

  it('пустое тело — ошибки по всем полям', () => {
    expect(errorsOf(ConfirmLoginDto, {})).toEqual([
      'attemptId',
      'code',
      'token',
    ]);
  });

  it('toLoginConfirmationInput разбирает оба варианта и запрещает смесь', () => {
    expect(
      toLoginConfirmationInput({
        token: `${ATTEMPT_ID.toUpperCase()}.${SECRET}`,
      }),
    ).toEqual({
      kind: ConfirmationMethod.MagicLink,
      attemptId: ATTEMPT_ID,
      secret: SECRET,
    });
    expect(
      toLoginConfirmationInput({ attemptId: ATTEMPT_ID, code: '123456' }),
    ).toEqual({
      kind: ConfirmationMethod.Otp,
      attemptId: ATTEMPT_ID,
      secret: '123456',
    });
    expect(() =>
      toLoginConfirmationInput({
        token: `${ATTEMPT_ID}.${SECRET}`,
        code: '123456',
      }),
    ).toThrow(BadRequestException);
  });

  it('ResendLoginDto требует UUID', () => {
    expect(errorsOf(ResendLoginDto, { attemptId: ATTEMPT_ID })).toEqual([]);
    expect(errorsOf(ResendLoginDto, { attemptId: 'nope' })).toEqual([
      'attemptId',
    ]);
  });
});

describe('Ответы 202', () => {
  const challenge = { id: ATTEMPT_ID, method: ConfirmationMethod.Otp };

  it('login: confirmationRequired + method, attemptId, сроки', () => {
    expect(LoginChallengeResponse.from(challenge)).toEqual({
      confirmationRequired: true,
      method: 'otp',
      attemptId: ATTEMPT_ID,
      expiresInSeconds: 600,
      resendAfterSeconds: 60,
    });
  });

  it('resend: без confirmationRequired', () => {
    expect(LoginResendResponse.from(challenge)).toEqual({
      method: 'otp',
      attemptId: ATTEMPT_ID,
      expiresInSeconds: 600,
      resendAfterSeconds: 60,
    });
  });
});

describe('LoginChallengeSecrets', () => {
  const secrets = new LoginChallengeSecrets({
    get: () => 'login-key-'.repeat(5),
  } as unknown as ConfigService);

  it('OTP — 6 цифр, magic link — 43 символа base64url', () => {
    expect(secrets.generate(ConfirmationMethod.Otp)).toMatch(/^\d{6}$/);
    expect(secrets.generate(ConfirmationMethod.MagicLink)).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  });

  it('HMAC зависит от способа и attemptId, сравнение работает', () => {
    const hash = secrets.hash(ConfirmationMethod.Otp, ATTEMPT_ID, '123456');
    expect(hash).toHaveLength(32);
    expect(
      secrets.matches(ConfirmationMethod.Otp, ATTEMPT_ID, '123456', hash),
    ).toBe(true);
    expect(
      secrets.matches(ConfirmationMethod.Otp, ATTEMPT_ID, '654321', hash),
    ).toBe(false);
    expect(
      secrets.matches(ConfirmationMethod.MagicLink, ATTEMPT_ID, '123456', hash),
    ).toBe(false);
    expect(
      secrets.matches(
        ConfirmationMethod.Otp,
        '33333333-3333-4333-8333-333333333333',
        '123456',
        hash,
      ),
    ).toBe(false);
  });
});

describe('Письмо входа', () => {
  it('OTP: код в тексте, без ссылки', () => {
    const mail = buildLoginMail(
      'u@example.com',
      ConfirmationMethod.Otp,
      ATTEMPT_ID,
      '042917',
      'https://app/login/confirm',
    );
    expect(mail).toMatchObject({
      to: 'u@example.com',
      subject: 'Подтвердите вход',
    });
    expect(mail.text).toContain('042917');
    expect(mail.text).not.toContain('https://');
  });

  it('magic link: токен attemptId.secret во фрагменте URL', () => {
    const mail = buildLoginMail(
      'u@example.com',
      ConfirmationMethod.MagicLink,
      ATTEMPT_ID,
      SECRET,
      'https://app/login/confirm',
    );
    expect(mail.text).toContain(
      `https://app/login/confirm#token=${buildMagicLinkToken(ATTEMPT_ID, SECRET)}`,
    );
  });
});

describe('LoginSettings', () => {
  const settingsWith = (values: Record<string, unknown>) =>
    new LoginSettings({
      get: (key: string) => values[key],
    } as unknown as ConfigService);

  it('читает флаг, способ и URL', () => {
    const settings = settingsWith({
      LOGIN_EMAIL_CONFIRMATION_ENABLED: true,
      LOGIN_EMAIL_CONFIRMATION_METHOD: 'magic_link',
      LOGIN_CONFIRM_URL: 'https://app/login/confirm',
    });
    expect(settings.confirmationEnabled).toBe(true);
    expect(settings.confirmationMethod).toBe(ConfirmationMethod.MagicLink);
    expect(settings.confirmUrl).toBe('https://app/login/confirm');
  });

  it('по умолчанию: выключено, OTP, локальный фронтенд', () => {
    const settings = settingsWith({});
    expect(settings.confirmationEnabled).toBe(false);
    expect(settings.confirmationMethod).toBe(ConfirmationMethod.Otp);
    expect(settings.confirmUrl).toBe('http://localhost:5174/login/confirm');
  });
});

describe('challengeExpiresAt', () => {
  it('last_sent_at + 10 минут', () => {
    const lastSentAt = new Date('2026-11-16T10:00:00Z');
    expect(challengeExpiresAt({ lastSentAt }).toISOString()).toBe(
      '2026-11-16T10:10:00.000Z',
    );
  });
});

describe('LoginAuditInterceptor', () => {
  const audit = { warn: jest.fn() };
  const interceptor = new LoginAuditInterceptor(
    audit as unknown as AuditLogger,
  );
  const contextFor = (name: string) =>
    ({ getHandler: () => ({ name }) }) as unknown as ExecutionContext;
  const failing = (error: unknown): CallHandler => ({
    handle: () => throwError(() => error),
  });

  beforeEach(() => audit.warn.mockReset());

  it.each([
    ['login', 'login.failed'],
    ['confirm', 'login.challenge.failed'],
    ['resend', 'login.resend.failed'],
  ])('ошибка валидации в %s → %s', async (handler, event) => {
    await expect(
      lastValueFrom(
        interceptor.intercept(
          contextFor(handler),
          failing(new BadRequestException(['x'])),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(audit.warn).toHaveBeenCalledWith(event, {
      reason: 'validation_failed',
    });
  });

  it('другие ошибки и успех не аудирует', async () => {
    await expect(
      lastValueFrom(
        interceptor.intercept(contextFor('login'), failing(new Error('x'))),
      ),
    ).rejects.toThrow('x');
    await expect(
      lastValueFrom(
        interceptor.intercept(contextFor('login'), { handle: () => of('ok') }),
      ),
    ).resolves.toBe('ok');
    expect(audit.warn).not.toHaveBeenCalled();
  });
});
