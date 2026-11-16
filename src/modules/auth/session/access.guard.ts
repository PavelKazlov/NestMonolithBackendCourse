import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import '@/modules/auth/tokens/auth-request';
import {
  ACCESS_COOKIE,
  TokenKind,
} from '@/modules/auth/tokens/token.constants';
import { SessionService } from './session.service';

/**
 * Единая проверка access для защищённых операций (спека 1.2, раздел 1.3.6):
 * «каждая защищённая операция сначала вызывает единую проверку аутентификации».
 *
 * Подключение: `@UseGuards(AccessGuard)` на контроллере или методе. В задании
 * 1.3 guard войдёт в обязательную цепочку access → user → CSRF → RBAC, и
 * каждый маршрут будет явно объявлен публичным или защищённым.
 *
 * Шаги:
 * 1. Взять access ТОЛЬКО из cookie `access_token`. Заголовок `Authorization`
 *    не читаем: токены живут в HttpOnly cookies, JavaScript их не видит.
 * 2. Проверить JWT и пользователя (`SessionService.authenticate`):
 *    подпись, claims, `token_use=access`, пользователь существует и `active`.
 * 3. Положить в запрос `{ userId }` для обработчика и RBAC. Ролей из JWT нет.
 *
 * Отказ → 401 `invalid_session`; БД недоступна → 503. При успехе своего
 * HTTP-ответа нет: запрос идёт дальше, к RBAC и обработчику.
 *
 * sessions: AccessGuard не меняется. Проверка `sid` по таблице сессий
 * добавится внутри `SessionService.authenticate`.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const userId = await this.sessions.authenticate(
      request.cookies?.[ACCESS_COOKIE],
      TokenKind.Access,
    );
    request.auth = { userId };
    return true;
  }
}
