/**
 * Типизированное описание всех переменных окружения приложения.
 *
 * Ключи этого интерфейса — единственные имена, которые принимает
 * `ConfigService.get(...)`: опечатка в имени переменной станет ошибкой
 * компиляции, а не `undefined` в рантайме.
 *
 * Значения проверяются Joi-схемой в `config.validation.ts` при старте —
 * если чего-то не хватает, приложение не запустится («fail fast»).
 */
export interface Config {
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';

  /**
   * Cookie secret
   */
  COOKIE_SECRET: string;

  /**
   * Logging & API docs
   */
  LOG_LEVEL?:
    | 'fatal'
    | 'error'
    | 'warn'
    | 'info'
    | 'debug'
    | 'trace'
    | 'silent';
  SWAGGER_ENABLED?: boolean;

  /**
   * Health check options
   */
  HEALTH_CHECK_ENABLED?: boolean;

  /**
   * Throttler options
   */
  THROTTLE_GLOBAL_TTL?: number;
  THROTTLE_GLOBAL_LIMIT?: number;

  /**
   * PostgreSQL database options
   */
  POSTGRES_HOST: string;
  POSTGRES_PORT: number;
  POSTGRES_USER: string;
  POSTGRES_PASSWORD: string;
  POSTGRES_DB: string;
  POSTGRES_SYNCHRONIZE?: boolean;
  POSTGRES_LOGGING?: boolean;
  POSTGRES_MIGRATIONS_RUN?: boolean;

  /**
   * Mail (SMTP) options
   */
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_SECURE?: boolean;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM: string;
}
