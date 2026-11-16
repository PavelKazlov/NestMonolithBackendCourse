import { HttpStatus, Injectable } from '@nestjs/common';

import { AuditLogger } from '@/core/audit/audit-logger';
import { AppException } from '@/core/errors/app.exception';
import { UserStatus } from '@/modules/users/user.entity';
import { UsersService } from '@/modules/users/users.service';
import { TokenKind } from '@/modules/auth/tokens/token.constants';
import { TokenVerificationError } from '@/modules/auth/tokens/token-verification.error';
import { TokenPair, TokenService } from '@/modules/auth/tokens/token.service';

/**
 * 401 `invalid_session` — один ответ на любую проблему с токеном или
 * пользователем (спека 1.2, раздел 1.4): «Ошибка сессии имеет общий код
 * invalid_session и не сообщает, какая проверка JWT или пользователя не прошла».
 */
export function invalidSessionError(): AppException {
  return new AppException(
    HttpStatus.UNAUTHORIZED,
    'invalid_session',
    'Session is missing, invalid or expired',
  );
}

/**
 * «Сессия» в stateless-схеме: проверка токена + проверка пользователя в БД.
 *
 * Состояния сессии на сервере нет (спека 1.2: «Refresh-сессии на сервере не
 * хранятся»). Но одной подписи мало: каждый access и каждый refresh ещё
 * проверяют, что пользователь существует и `active`. Поэтому блокировка или
 * удаление пользователя гасит ВСЕ его токены сразу, без всякого denylist:
 * следующий же запрос получит 401 (теоретический вопрос 4 главы).
 *
 * sessions: при переходе на серверные сессии сюда добавится шаг «найти
 * `auth_sessions` по `sid` из токена и убедиться, что она не отозвана», а
 * `refresh` начнёт ротировать refresh внутри сессии с reuse detection.
 * AccessGuard и контроллер при этом не изменятся.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    private readonly audit: AuditLogger,
  ) {}

  /**
   * Проверить токен ожидаемого типа и пользователя. Возвращает `userId`
   * active-пользователя или бросает 401 `invalid_session`.
   *
   * Ошибки БД (недоступна) НЕ перехватываются: глобальный фильтр превратит их
   * в 503. Спека: «Недоступность базы даёт 503», а не 401. Иначе клиент
   * при кратком сбое БД разлогинил бы пользователя.
   */
  async authenticate(
    token: string | undefined,
    kind: TokenKind,
  ): Promise<string> {
    let userId: string;
    try {
      ({ userId } = this.tokens.verify(token, kind));
    } catch (error: unknown) {
      if (error instanceof TokenVerificationError) {
        this.reject(kind, error.category);
      }
      throw error;
    }

    // Только `id` и `status` (спека, раздел 1.3.6, шаг 2).
    const user = await this.users.findAuthState(userId);
    if (user?.status !== UserStatus.Active) {
      this.reject(kind, 'user_inactive', userId);
    }
    return userId;
  }

  /**
   * Обновление пары (спека 1.2, раздел 1.3.4).
   *
   * Новый access на 15 минут и новый refresh на 30 дней ОТ ТЕКУЩЕГО момента
   * (скользящая сессия). Прежний refresh никуда не записывается и в denylist
   * не попадает: он остаётся криптографически действующим до своего `exp`.
   * Это осознанное ограничение stateless-схемы (см. docs/tasks/1.2).
   */
  async refresh(refreshToken: string | undefined): Promise<TokenPair> {
    const userId = await this.authenticate(refreshToken, TokenKind.Refresh);
    // Если подпись упадёт, issuePair бросит 503 до установки cookies.
    // Прежняя cookie клиента останется пригодной для повторной попытки.
    const pair = this.tokens.issuePair(userId);
    this.audit.info('refresh.succeeded', { userId });
    return pair;
  }

  /**
   * Для журнала logout: кто выходит, если access ещё валиден. Logout от этого
   * не зависит (он очищает cookies всегда), поэтому любые ошибки глотаем.
   */
  tryIdentify(accessToken: string | undefined): string | undefined {
    try {
      return this.tokens.verify(accessToken, TokenKind.Access).userId;
    } catch {
      return undefined;
    }
  }

  private reject(
    kind: TokenKind,
    reason: TokenVerificationError['category'],
    userId?: string,
  ): never {
    // Категорию пишем в журнал, наружу — общий 401 (спека, раздел 1.5).
    this.audit.warn(
      kind === TokenKind.Access ? 'access.denied' : 'refresh.failed',
      { reason, userId },
    );
    throw invalidSessionError();
  }
}
