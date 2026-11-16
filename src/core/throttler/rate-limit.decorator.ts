import { ExecutionContext, SetMetadata } from '@nestjs/common';

/** Имена именованных лимитов. Совпадают с `name` в `ThrottlerModule`. */
export enum RateLimit {
  Registration = 'registration',
  /** 1.2: `POST /auth/login` — 30 запросов с IP за минуту. */
  Login = 'login',
  /** 1.2: `POST /auth/refresh` — 30 запросов с IP за минуту. */
  Refresh = 'refresh',
}

const RATE_LIMITS_KEY = 'app:rate-limits';

/**
 * Включает именованный лимит на обработчике контроллера:
 *
 *   @RateLimitOn(RateLimit.Registration)
 *   @Post('register')
 *
 * `SetMetadata` кладёт список имён в метаданные метода (через reflect-metadata).
 * Потом `skipIf` лимита читает их и решает, считать ли этот запрос.
 */
export const RateLimitOn = (...limits: RateLimit[]) =>
  SetMetadata(RATE_LIMITS_KEY, limits);

/** Включён ли лимит `name` на обработчике текущего запроса. */
export function isRateLimitEnabled(
  context: ExecutionContext,
  name: RateLimit,
): boolean {
  const limits = Reflect.getMetadata(RATE_LIMITS_KEY, context.getHandler()) as
    | RateLimit[]
    | undefined;
  return limits?.includes(name) ?? false;
}
