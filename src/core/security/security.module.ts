import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { CsrfGuard } from './csrf.guard';

/**
 * Сквозная HTTP-безопасность. Сейчас это проверка Origin/CSRF (спека 1.2).
 *
 * `APP_GUARD` регистрирует guard ГЛОБАЛЬНО: он выполняется для каждого
 * маршрута приложения раньше guard'ов контроллера (например, rate limit).
 * Запрос с чужого origin отклоняется, не тратя ни лимит, ни БД.
 *
 * В задании 1.3 появится фиксированная цепочка access → user → CSRF → RBAC,
 * и этот guard займёт в ней своё место.
 */
@Module({
  providers: [{ provide: APP_GUARD, useClass: CsrfGuard }],
})
export class SecurityModule {}
