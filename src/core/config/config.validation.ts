import Joi from 'joi';

import { Config } from './config.types';

/** Заглушка ключа из `.env.example`. С ней приложение не стартует. */
export const CHALLENGE_HMAC_KEY_PLACEHOLDER =
  'change-me-to-a-random-string-of-at-least-32-chars';

/**
 * Joi-схема переменных окружения.
 *
 * `@nestjs/config` прогоняет `process.env` через эту схему при старте:
 * - обязательная переменная отсутствует → приложение падает сразу с понятной
 *   ошибкой (лучше упасть при деплое, чем на первом запросе пользователя);
 * - `.default(...)` подставляет значение, если переменная не задана;
 * - Joi приводит типы: строка "5432" из env становится числом 5432.
 */
export const configValidationSchema = Joi.object<Config>({
  PORT: Joi.number().port().required(),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').required(),

  /**
   * Cookie secret
   */
  COOKIE_SECRET: Joi.string().required(),

  /**
   * Logging & API docs
   */
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .optional()
    .default('info'),
  // По умолчанию документация включена везде, кроме production.
  SWAGGER_ENABLED: Joi.boolean()
    .optional()
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.boolean().default(false),
      otherwise: Joi.boolean().default(true),
    }),

  /**
   * Health check options
   */
  HEALTH_CHECK_ENABLED: Joi.boolean().optional().default(false),

  /**
   * Throttler options
   */
  THROTTLE_GLOBAL_TTL: Joi.number().optional().default(10000),
  THROTTLE_GLOBAL_LIMIT: Joi.number().optional().default(10),

  /**
   * PostgreSQL database options
   */
  POSTGRES_HOST: Joi.string().hostname().required(),
  POSTGRES_PORT: Joi.number().port().required(),
  POSTGRES_USER: Joi.string().required(),
  POSTGRES_PASSWORD: Joi.string().required(),
  POSTGRES_DB: Joi.string().required(),
  POSTGRES_SYNCHRONIZE: Joi.boolean().optional().default(false),
  POSTGRES_LOGGING: Joi.boolean().optional().default(false),
  POSTGRES_MIGRATIONS_RUN: Joi.boolean().optional().default(false),

  /**
   * Mail (SMTP) options
   */
  SMTP_HOST: Joi.string().hostname().required(),
  SMTP_PORT: Joi.number().port().required(),
  SMTP_SECURE: Joi.boolean().optional().default(false),
  // Пустая строка в .env означает «без авторизации на SMTP» (как у Mailpit).
  SMTP_USER: Joi.string().allow('').optional(),
  SMTP_PASSWORD: Joi.string().allow('').optional(),
  SMTP_FROM: Joi.string().required(),

  /**
   * Ключ HMAC для секретов из писем.
   * Обязателен и без значения по умолчанию: ключ «по умолчанию» оказался бы
   * в git, и любой, кто читал репозиторий, мог бы посчитать HMAC сам.
   * Минимум 32 символа: ключ HMAC-SHA256 должен быть не короче его выхода
   * (32 байта). Сгенерировать: `openssl rand -base64 48`.
   * Значение-заглушку из `.env.example` отвергаем: иначе `cp .env.example .env`
   * тихо запустил бы приложение с ключом, который знает весь интернет.
   */
  CHALLENGE_HMAC_KEY: Joi.string()
    .min(32)
    .invalid(CHALLENGE_HMAC_KEY_PLACEHOLDER)
    .required(),

  /**
   * Registration (задание 1.0)
   */
  // Флаг сценария «регистрация». По умолчанию выключен: аккаунт активен сразу.
  REGISTRATION_CONFIRMATION_ENABLED: Joi.boolean().optional().default(false),
  // Способ подтверждения выбирает сервер, а не клиент (спека 1.0, «Модель»).
  REGISTRATION_CONFIRMATION_METHOD: Joi.string()
    .valid('otp', 'magic_link')
    .optional()
    .default('otp'),
  REGISTRATION_CONFIRM_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .optional()
    .default('http://localhost:5174/register/confirm'),
  // «Числовой порог регистрации задаётся в конфигурации» (спека 1.0, раздел 1.6).
  REGISTRATION_RATE_LIMIT: Joi.number().integer().min(1).optional().default(5),
  REGISTRATION_RATE_TTL: Joi.number()
    .integer()
    .min(1)
    .optional()
    .default(60000),
});
