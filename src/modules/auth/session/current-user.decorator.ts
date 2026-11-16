import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import '@/modules/auth/tokens/auth-request';

/**
 * `@CurrentUserId()` — id пользователя, которого проверил AccessGuard:
 *
 *   @UseGuards(AccessGuard)
 *   @Get('me')
 *   me(@CurrentUserId() userId: string) { ... }
 *
 * Если guard не подключён, это ошибка программиста, а не клиента. Бросаем
 * обычный Error (→ 500 с записью в лог), чтобы её заметили сразу, а не
 * получили `undefined` и чужие данные.
 */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!request.auth) {
      throw new Error('CurrentUserId used on a route without AccessGuard');
    }
    return request.auth.userId;
  },
);
