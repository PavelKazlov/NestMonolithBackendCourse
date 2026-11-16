import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AuditLogger } from '@/core/audit/audit-logger';
import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';

/** Имя пользовательского заголовка защиты от CSRF (спека 1.2, раздел 1.3.3). */
export const CSRF_HEADER = 'x-csrf-protection';

/** «Безопасные» методы по RFC 9110 не меняют состояние, CSRF им не страшен. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Проверка Origin и CSRF-заголовка для всех изменяющих запросов
 * (POST, PUT, PATCH, DELETE). Спека 1.2, разделы 1.3.3 и 1.4.
 *
 * Что такое CSRF. Аутентификация у нас на cookies, а браузер прикладывает
 * cookies к запросу САМ, кто бы этот запрос ни инициировал. Если пользователь
 * залогинен и откроет страницу злоумышленника, та может отправить
 * `POST /users/me/delete` на наш API, и браузер добавит к нему cookie сессии.
 * Запрос выглядит легитимным. Это Cross-Site Request Forgery, подделка
 * межсайтового запроса.
 *
 * Как защищаемся (три слоя):
 * 1. `SameSite=Strict` у cookies: браузер не отправит их в запросе, который
 *    начался на ДРУГОМ site. Но «site» — это домен целиком (`example.com`),
 *    поэтому соседний поддомен `evil.example.com` для браузера свой, same-site,
 *    и SameSite от него не защищает.
 * 2. Точная проверка `Origin`. Браузер сам ставит этот заголовок на
 *    cross-origin запросы (и на POST вообще), и JavaScript страницы подделать
 *    его не может. Пропускаем только свой origin (`APP_ORIGIN`) и явно
 *    перечисленные доверенные (`TRUSTED_ORIGINS`).
 * 3. Заголовок `X-CSRF-Protection: 1` для другого origin. Нестандартный
 *    заголовок делает запрос «непростым» по правилам CORS: браузер сначала
 *    отправит preflight `OPTIONS`, и наш CORS разрешит его только доверенному
 *    origin. HTML-форма такой заголовок поставить не может вовсе.
 *
 * Запрос БЕЗ заголовка `Origin` пропускаем. Браузеры ставят `Origin` на любой
 * cross-origin запрос и на любой POST. Значит, его отсутствие говорит,
 * что запрос пришёл не из браузера (curl, мобильное приложение, другой сервер).
 * Там нет «чужой страницы», которая заставила бы пользователя отправить
 * запрос, и cookie жертвы у такого клиента тоже нет. Заголовок `Origin: null`
 * (sandbox-iframe, редиректы, file://) — это браузер, и его отклоняем.
 *
 * Почему guard, а не middleware: guard видит контекст Nest и может бросить
 * `AppException`, которую глобальный фильтр превратит в единый формат ошибки.
 * Guard глобальный (APP_GUARD в SecurityModule), поэтому новые маршруты
 * защищены автоматически, а не только если разработчик не забыл декоратор.
 *
 * Код `csrf_rejected` (403) намеренно отличается от 403 RBAC (1.3): клиенту
 * и журналу важно, что запрос отклонён из-за происхождения, а не из-за прав.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly appOrigin: string;
  private readonly trustedOrigins: ReadonlySet<string>;

  constructor(
    config: ConfigService,
    private readonly audit: AuditLogger,
  ) {
    this.appOrigin = config.get('APP_ORIGIN');
    this.trustedOrigins = new Set(config.get('TRUSTED_ORIGINS'));
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (SAFE_METHODS.has(request.method)) return true;

    const origin = request.headers.origin;
    // Не браузер (см. комментарий к классу).
    if (origin === undefined) return true;
    // Same-origin: страница и API на одном origin, SameSite=Strict достаточно.
    if (origin === this.appOrigin) return true;

    const trusted = this.trustedOrigins.has(origin);
    if (trusted && request.headers[CSRF_HEADER] === '1') return true;

    // Аудит (спека 1.2, раздел 1.5: «отклонение origin или CSRF-проверки»).
    // Сам origin в журнал не пишем: это значение из запроса, его может
    // контролировать атакующий (длина, управляющие символы). Причины хватает,
    // а подробности связываются с access-логом по requestId.
    this.audit.warn('csrf.rejected', {
      reason: trusted ? 'missing_csrf_header' : 'untrusted_origin',
      method: request.method,
      route: request.routeOptions?.url,
    });
    throw new AppException(
      HttpStatus.FORBIDDEN,
      'csrf_rejected',
      'Request origin or CSRF protection header is not accepted',
    );
  }
}
