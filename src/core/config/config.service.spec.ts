import { Test } from '@nestjs/testing';

import { ConfigModule } from './config.module';
import { ConfigService } from './config.service';
import { configValidationSchema } from './config.validation';

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
