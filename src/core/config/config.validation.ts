import Joi from 'joi';

import { Config } from './config.types';

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
});
