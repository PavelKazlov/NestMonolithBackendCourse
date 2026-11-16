import Joi from 'joi';

import { Config } from './config.types';

/** Заглушка ключа из `.env.example`. С ней приложение не стартует. */
export const CHALLENGE_HMAC_KEY_PLACEHOLDER =
  'change-me-to-a-random-string-of-at-least-32-chars';

/**
 * Заглушки ключей задания 1.2 из `.env.example`. У каждого ключа своя строка:
 * так сообщение Joi сразу показывает, какой именно ключ забыли заменить.
 */
export const SECRET_PLACEHOLDERS = {
  JWT_ACCESS_SECRET: 'change-me-jwt-access-secret-of-at-least-32-chars',
  JWT_REFRESH_SECRET: 'change-me-jwt-refresh-secret-of-at-least-32-chars',
  LOGIN_CHALLENGE_HMAC_KEY:
    'change-me-login-challenge-key-of-at-least-32-chars',
  AUDIT_HMAC_KEY: 'change-me-audit-hmac-key-of-at-least-32-chars',
} as const;

/** Все заглушки сразу: ни один ключ не может быть равен чужой заглушке. */
const ALL_PLACEHOLDERS = [
  CHALLENGE_HMAC_KEY_PLACEHOLDER,
  ...Object.values(SECRET_PLACEHOLDERS),
];

/**
 * Секретный ключ (спека 1.2, раздел 1.1):
 * - обязателен и без значения по умолчанию: «тестовое значение, случайный ключ
 *   на каждый запуск ... запрещены»;
 * - не короче 32 БАЙТ. Второй аргумент `min(32, 'utf8')` заставляет Joi считать
 *   байты, а не символы (кириллическая буква — 2 байта в UTF-8);
 * - не равен заглушке из `.env.example`;
 * - не равен ни одному из уже объявленных ключей (`Joi.ref`). Спека: «общий ключ
 *   для access, refresh и email challenge запрещён». Если ключи совпадут, утечка
 *   одного раскроет все сразу, а access и refresh станут взаимозаменяемы по подписи.
 */
function secretKey(...distinctFrom: string[]): Joi.StringSchema {
  return Joi.string()
    .min(32, 'utf8')
    .invalid(...ALL_PLACEHOLDERS, ...distinctFrom.map((key) => Joi.ref(key)))
    .required();
}

/**
 * Список доверенных frontend-origin через запятую:
 *   TRUSTED_ORIGINS=http://localhost:5174,https://app.example.com
 *
 * Каждый элемент должен быть именно origin: схема + хост + порт, без пути,
 * query и завершающего `/`. Origin сравнивается со значением заголовка `Origin`
 * ПОСИМВОЛЬНО (спека: «точный origin»), и `https://app.example.com/` с косой
 * чертой не совпал бы никогда. Лучше упасть при старте, чем молча не пускать фронт.
 */
function parseOrigins(value: string): string[] {
  const origins = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const origin of origins) {
    if (!isExactOrigin(origin)) {
      throw new Error(`"${origin}" is not an origin (scheme://host[:port])`);
    }
  }
  return origins;
}

/** Строка — это ровно origin (`new URL(x).origin === x`), без пути и `/` в конце. */
export function isExactOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

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
   * Authentication (задание 1.2): ключи.
   * Четыре разных ключа — четыре разных «домена» ответственности. Утечка
   * одного не даёт подделать артефакты другого.
   */
  JWT_ACCESS_SECRET: secretKey('CHALLENGE_HMAC_KEY'),
  JWT_REFRESH_SECRET: secretKey('CHALLENGE_HMAC_KEY', 'JWT_ACCESS_SECRET'),
  LOGIN_CHALLENGE_HMAC_KEY: secretKey(
    'CHALLENGE_HMAC_KEY',
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
  ),
  AUDIT_HMAC_KEY: secretKey(
    'CHALLENGE_HMAC_KEY',
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'LOGIN_CHALLENGE_HMAC_KEY',
  ),
  // «JWT_ISSUER и JWT_AUDIENCE обязательны и одинаково используются при выпуске
  // и проверке» (спека 1.2, раздел 1.1).
  JWT_ISSUER: Joi.string().required(),
  JWT_AUDIENCE: Joi.string().required(),

  /**
   * Authentication (задание 1.2): подтверждение входа через email.
   * По умолчанию выключено: правильный пароль сразу даёт cookies.
   */
  LOGIN_EMAIL_CONFIRMATION_ENABLED: Joi.boolean().optional().default(false),
  LOGIN_EMAIL_CONFIRMATION_METHOD: Joi.string()
    .valid('otp', 'magic_link')
    .optional()
    .default('otp'),
  LOGIN_CONFIRM_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .optional()
    .default('http://localhost:5174/login/confirm'),

  /**
   * Authentication (задание 1.2): origin, cookies, CORS и CSRF.
   */
  // Собственный публичный origin API (страница и API на одном origin — режим
  // по умолчанию в спеке). POST с таким Origin — same-origin, CSRF-заголовок не нужен.
  APP_ORIGIN: Joi.string()
    .custom((value: string) => {
      if (!isExactOrigin(value)) throw new Error('must be an exact origin');
      return value;
    })
    .required(),
  // Другие доверенные frontend-origin. Пусто — только APP_ORIGIN.
  TRUSTED_ORIGINS: Joi.string().empty('').custom(parseOrigins).default([]),
  // `strict` — frontend на том же site (по умолчанию в спеке).
  // `none` — frontend на другом site: без этого браузер не отправит cookie
  // в cross-site запросе. `None` браузер принимает только вместе с `Secure`.
  AUTH_COOKIE_SAME_SITE: Joi.string()
    .valid('strict', 'none')
    .optional()
    .default('strict'),

  /**
   * Authentication (задание 1.2): rate limit. Значения по умолчанию — из спеки
   * (раздел 1.6): 30 запросов с IP за минуту на login и на refresh. В env они
   * вынесены только ради тестов: `.env.test` поднимает порог, чтобы десятки
   * e2e-входов с одного 127.0.0.1 не упирались в лимит. Сам лимит проверяет
   * отдельный e2e-файл с порогом из спеки.
   */
  LOGIN_RATE_LIMIT: Joi.number().integer().min(1).optional().default(30),
  LOGIN_RATE_TTL: Joi.number().integer().min(1).optional().default(60000),
  REFRESH_RATE_LIMIT: Joi.number().integer().min(1).optional().default(30),
  REFRESH_RATE_TTL: Joi.number().integer().min(1).optional().default(60000),

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
