import { Test } from '@nestjs/testing';

import { ConfigModule } from './config.module';
import { ConfigService } from './config.service';
import {
  CHALLENGE_HMAC_KEY_PLACEHOLDER,
  configValidationSchema,
  isExactOrigin,
  SECRET_PLACEHOLDERS,
} from './config.validation';

/** Минимальный валидный набор переменных окружения. */
const baseEnv = {
  PORT: '3007',
  NODE_ENV: 'development',
  COOKIE_SECRET: 'secret',
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: '5432',
  POSTGRES_USER: 'u',
  POSTGRES_PASSWORD: 'p',
  POSTGRES_DB: 'db',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_FROM: 'App <no-reply@example.test>',
  CHALLENGE_HMAC_KEY: 'k'.repeat(48),
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'r'.repeat(48),
  LOGIN_CHALLENGE_HMAC_KEY: 'l'.repeat(48),
  AUDIT_HMAC_KEY: 'u'.repeat(48),
  JWT_ISSUER: 'course-api',
  JWT_AUDIENCE: 'course-web',
  APP_ORIGIN: 'http://localhost:3007',
};

describe('configValidationSchema', () => {
  const validate = (env: Record<string, string>) =>
    configValidationSchema.validate(env, {
      allowUnknown: true,
    });

  it('приводит строки из env к типам и подставляет значения по умолчанию', () => {
    const { error, value } = validate(baseEnv);

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      PORT: 3007,
      SMTP_SECURE: false,
      LOG_LEVEL: 'info',
      SWAGGER_ENABLED: true,
    });
  });

  it('SWAGGER_ENABLED по умолчанию выключен в production', () => {
    expect(
      validate({ ...baseEnv, NODE_ENV: 'production' }).value?.SWAGGER_ENABLED,
    ).toBe(false);
  });

  it('ошибка при отсутствии обязательной переменной', () => {
    const withoutSmtp: Record<string, string> = { ...baseEnv };
    delete withoutSmtp.SMTP_HOST;

    expect(validate(withoutSmtp).error?.message).toMatch(/SMTP_HOST/);
  });

  describe('CHALLENGE_HMAC_KEY', () => {
    it('обязателен: без ключа приложение не стартует', () => {
      const env: Record<string, string> = { ...baseEnv };
      delete env.CHALLENGE_HMAC_KEY;

      expect(validate(env).error?.message).toMatch(/CHALLENGE_HMAC_KEY/);
    });

    it('короче 32 символов — ошибка', () => {
      expect(
        validate({ ...baseEnv, CHALLENGE_HMAC_KEY: 'short' }).error?.message,
      ).toMatch(/at least 32/);
    });

    it('заглушка из .env.example отвергается', () => {
      expect(
        validate({
          ...baseEnv,
          CHALLENGE_HMAC_KEY: CHALLENGE_HMAC_KEY_PLACEHOLDER,
        }).error,
      ).toBeDefined();
    });
  });

  it('регистрация: по умолчанию без подтверждения, OTP, лимит 5 за 60 с', () => {
    expect(validate(baseEnv).value).toMatchObject({
      REGISTRATION_CONFIRMATION_ENABLED: false,
      REGISTRATION_CONFIRMATION_METHOD: 'otp',
      REGISTRATION_RATE_LIMIT: 5,
      REGISTRATION_RATE_TTL: 60000,
    });
  });

  it('неизвестный способ подтверждения — ошибка', () => {
    expect(
      validate({ ...baseEnv, REGISTRATION_CONFIRMATION_METHOD: 'sms' }).error,
    ).toBeDefined();
  });
});

describe('configValidationSchema: аутентификация (1.2)', () => {
  const validate = (env: Record<string, string>) =>
    configValidationSchema.validate(env, { allowUnknown: true });
  const keys = Object.keys(
    SECRET_PLACEHOLDERS,
  ) as (keyof typeof SECRET_PLACEHOLDERS)[];

  it('значения по умолчанию из спеки', () => {
    expect(validate(baseEnv).value).toMatchObject({
      LOGIN_EMAIL_CONFIRMATION_ENABLED: false,
      LOGIN_EMAIL_CONFIRMATION_METHOD: 'otp',
      TRUSTED_ORIGINS: [],
      AUTH_COOKIE_SAME_SITE: 'strict',
      LOGIN_RATE_LIMIT: 30,
      LOGIN_RATE_TTL: 60000,
      REFRESH_RATE_LIMIT: 30,
      REFRESH_RATE_TTL: 60000,
    });
  });

  it.each(keys)('%s: обязателен', (key) => {
    const env: Record<string, string> = { ...baseEnv };
    delete env[key];
    expect(validate(env).error?.message).toContain(key);
  });

  it.each(keys)('%s: не короче 32 байт', (key) => {
    expect(
      validate({ ...baseEnv, [key]: 'x'.repeat(31) }).error?.message,
    ).toMatch(/at least 32/);
  });

  it('длина считается в байтах UTF-8, а не в символах', () => {
    // 16 кириллических букв = 32 байта: ключ проходит.
    expect(
      validate({ ...baseEnv, AUDIT_HMAC_KEY: 'ж'.repeat(16) }).error,
    ).toBeUndefined();
  });

  it.each(keys)('%s: заглушка из .env.example отвергается', (key) => {
    expect(
      validate({ ...baseEnv, [key]: SECRET_PLACEHOLDERS[key] }).error,
    ).toBeDefined();
  });

  it('одинаковые ключи запрещены', () => {
    const same = 's'.repeat(40);
    expect(
      validate({
        ...baseEnv,
        JWT_ACCESS_SECRET: same,
        JWT_REFRESH_SECRET: same,
      }).error?.message,
    ).toContain('JWT_REFRESH_SECRET');
    expect(
      validate({
        ...baseEnv,
        LOGIN_CHALLENGE_HMAC_KEY: baseEnv.CHALLENGE_HMAC_KEY,
      }).error,
    ).toBeDefined();
    expect(
      validate({ ...baseEnv, AUDIT_HMAC_KEY: baseEnv.JWT_ACCESS_SECRET }).error,
    ).toBeDefined();
  });

  it('JWT_ISSUER и JWT_AUDIENCE обязательны', () => {
    const env: Record<string, string> = { ...baseEnv };
    delete env.JWT_AUDIENCE;
    expect(validate(env).error?.message).toContain('JWT_AUDIENCE');
  });

  it('TRUSTED_ORIGINS разбирается в список точных origin', () => {
    expect(
      validate({
        ...baseEnv,
        TRUSTED_ORIGINS: ' http://localhost:5174, https://app.example.com ',
      }).value?.TRUSTED_ORIGINS,
    ).toEqual(['http://localhost:5174', 'https://app.example.com']);
    expect(
      validate({ ...baseEnv, TRUSTED_ORIGINS: '' }).value?.TRUSTED_ORIGINS,
    ).toEqual([]);
    expect(
      validate({ ...baseEnv, TRUSTED_ORIGINS: 'https://app.example.com/' })
        .error,
    ).toBeDefined();
  });

  it('APP_ORIGIN — точный origin', () => {
    expect(
      validate({ ...baseEnv, APP_ORIGIN: 'http://localhost:3007/api' }).error,
    ).toBeDefined();
  });

  it('isExactOrigin', () => {
    expect(isExactOrigin('https://a.example')).toBe(true);
    expect(isExactOrigin('https://a.example:8443')).toBe(true);
    expect(isExactOrigin('https://a.example/')).toBe(false);
    expect(isExactOrigin('ftp://a.example')).toBe(false);
    expect(isExactOrigin('not a url')).toBe(false);
  });
});

describe('ConfigService', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('get() отдаёт значения уже приведённых типов', async () => {
    Object.assign(process.env, baseEnv);

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule],
    }).compile();
    const config = moduleRef.get(ConfigService);

    expect(config.get('SMTP_PORT')).toBe(1025);
    expect(config.get('SMTP_SECURE')).toBe(false);
  });
});
