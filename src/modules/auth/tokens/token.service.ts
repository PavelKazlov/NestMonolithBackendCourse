import { HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

import { AuditLogger } from '@/core/audit/audit-logger';
import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import { ReadinessRegistry } from '@/core/health/readiness.registry';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CLOCK_TOLERANCE_SECONDS,
  JWT_ALGORITHM,
  REFRESH_TOKEN_TTL_SECONDS,
  TokenKind,
} from './token.constants';
import { TokenVerificationError } from './token-verification.error';

/** Пара свежевыпущенных токенов. Живёт только в памяти до записи в cookies. */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * Payload нашего JWT (спека 1.2, раздел 1.3.3). Больше в нём НИЧЕГО нет:
 * ни ролей, ни email, ни `jti`. Payload JWT кодируется base64url, но не
 * шифруется: его прочитает любой, у кого есть токен.
 */
interface AppJwtPayload {
  sub: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  token_use: TokenKind;
}

/** Строгая форма UUID: `sub` уходит в запрос `WHERE id = $1` по колонке uuid. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Выпуск и криптографическая проверка JWT (спека 1.2, раздел 1.3.3).
 *
 * Сервис ничего не знает о БД, cookies и HTTP: только подпись и claims.
 * Проверку «пользователь существует и active» делает SessionService, а
 * cookies ставит AuthCookies.
 *
 * Два ключа, два типа (теоретический вопрос 2 главы):
 * - access подписывается `JWT_ACCESS_SECRET`, refresh — `JWT_REFRESH_SECRET`;
 * - в каждом токене есть `token_use`.
 * Refresh, подсунутый вместо access, не пройдёт проверку подписи (другой ключ).
 * Если бы ключи случайно совпали (конфиг это запрещает), его остановил бы
 * `token_use`. Две независимые защиты: ошибка в одной не открывает дыру.
 * Вдобавок утечка ключа access не позволяет выпускать 30-дневные refresh.
 *
 * sessions: если понадобится отзыв токенов (см. docs/tasks/1.2, раздел
 * «Инвалидация токенов»), здесь в payload добавится claim `sid` (id строки
 * `auth_sessions`). `issuePair(userId, sessionId)` начнёт его подписывать,
 * а `verify` — возвращать. Остальной код менять не придётся.
 */
@Injectable()
export class TokenService implements OnModuleInit {
  private readonly keys: Record<TokenKind, string>;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    config: ConfigService,
    private readonly audit: AuditLogger,
    private readonly readiness: ReadinessRegistry,
  ) {
    this.keys = {
      [TokenKind.Access]: config.get('JWT_ACCESS_SECRET'),
      [TokenKind.Refresh]: config.get('JWT_REFRESH_SECRET'),
    };
    this.issuer = config.get('JWT_ISSUER');
    this.audience = config.get('JWT_AUDIENCE');
  }

  /**
   * Readiness (спека 1.2, раздел 1.1): если ключи не годятся, приложение «не
   * проходит readiness-проверку». Пустые и короткие ключи отсекает Joi ещё при
   * старте. Здесь проверяем, что подпись и проверка реально работают:
   * выпускаем пробную пару и тут же проверяем оба токена.
   */
  onModuleInit(): void {
    this.readiness.register('auth-tokens', () => {
      const probe = randomUUID();
      const pair = this.sign(probe, Math.floor(Date.now() / 1000));
      this.verify(pair.accessToken, TokenKind.Access);
      this.verify(pair.refreshToken, TokenKind.Refresh);
    });
  }

  /**
   * Выпустить новую пару для пользователя.
   *
   * Обе подписи выполняются ДО того, как контроллер начнёт писать ответ.
   * Если упала хотя бы одна, наружу не уходит ни одна cookie (спека: «если
   * подпись хотя бы одного токена не удалась, заголовки Set-Cookie не
   * отправляются и возвращается 503»). Пол-пары хуже, чем ничего: клиент
   * остался бы с access без refresh или наоборот.
   *
   * @param nowSeconds текущее время в секундах; параметр нужен тестам.
   */
  issuePair(
    userId: string,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): TokenPair {
    try {
      return this.sign(userId, nowSeconds);
    } catch {
      // Текст ошибки библиотеки в журнал не пишем: там мог бы оказаться payload.
      this.audit.warn('token.signing_failed', { userId });
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'token_signing_failed',
        'Session could not be issued, try again later',
      );
    }
  }

  private sign(userId: string, iat: number): TokenPair {
    return {
      accessToken: this.signOne(
        userId,
        TokenKind.Access,
        iat,
        ACCESS_TOKEN_TTL_SECONDS,
      ),
      refreshToken: this.signOne(
        userId,
        TokenKind.Refresh,
        iat,
        REFRESH_TOKEN_TTL_SECONDS,
      ),
    };
  }

  private signOne(
    sub: string,
    kind: TokenKind,
    iat: number,
    ttlSeconds: number,
  ): string {
    const payload: AppJwtPayload = {
      sub,
      iss: this.issuer,
      aud: this.audience,
      iat,
      // exp считаем сами, а не через опцию `expiresIn`: так в коде прямо
      // видно правило спеки «exp = iat + 15 минут / + 30 дней».
      exp: iat + ttlSeconds,
      token_use: kind,
    };
    // Алгоритм задан явно. HS256 — HMAC-SHA256 с общим секретным ключом:
    // один и тот же сервис и подписывает, и проверяет.
    return jwt.sign(payload, this.keys[kind], { algorithm: JWT_ALGORITHM });
  }

  /**
   * Криптографическая проверка токена ожидаемого типа. Возвращает `userId`
   * (`sub`). При отказе бросает TokenVerificationError с категорией.
   *
   * Проверки (спека 1.2, разделы 1.3.4 и 1.3.6):
   * 1. Токен есть (`missing`).
   * 2. Алгоритм ровно HS256 (`algorithms: ['HS256']`). Алгоритм из заголовка
   *    токена НЕ используется как настройка: иначе подделка с `alg: none`
   *    («подписи нет») или с подменой алгоритма прошла бы проверку. Это
   *    классическая уязвимость JWT-библиотек (RFC 8725, раздел 3.1).
   * 3. Подпись ключом ожидаемого типа (`signature`).
   * 4. `exp` с допуском 30 с (`expired`); `iss`, `aud` (`claims`).
   * 5. Вручную: `exp` и `iat` — числа, `iat` не из будущего, `sub` — UUID
   *    (`claims`). Библиотека не требует наличия `exp` и не проверяет `iat`,
   *    а не-UUID в `sub` уронил бы запрос к БД с ошибкой 22P02 (→ 500).
   * 6. `token_use` совпадает с ожидаемым (`token_use`).
   */
  verify(
    token: string | undefined,
    kind: TokenKind,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): { userId: string } {
    if (!token) throw new TokenVerificationError('missing');

    let decoded: string | jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, this.keys[kind], {
        algorithms: [JWT_ALGORITHM],
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        clockTimestamp: nowSeconds,
      });
    } catch (error: unknown) {
      throw new TokenVerificationError(categorize(error));
    }

    if (typeof decoded !== 'object') {
      throw new TokenVerificationError('malformed');
    }
    const { sub, iat, exp } = decoded;
    if (
      typeof exp !== 'number' ||
      typeof iat !== 'number' ||
      iat > nowSeconds + CLOCK_TOLERANCE_SECONDS ||
      typeof sub !== 'string' ||
      !UUID_PATTERN.test(sub)
    ) {
      throw new TokenVerificationError('claims');
    }
    if ((decoded as { token_use?: unknown }).token_use !== kind) {
      throw new TokenVerificationError('token_use');
    }
    return { userId: sub };
  }
}

/**
 * Ошибка jsonwebtoken → категория для аудита. Различаем по классу и тексту
 * ошибки: других признаков библиотека не даёт.
 */
function categorize(error: unknown): TokenVerificationError['category'] {
  if (error instanceof jwt.TokenExpiredError) return 'expired';
  if (error instanceof jwt.NotBeforeError) return 'claims';
  if (error instanceof jwt.JsonWebTokenError) {
    const message = error.message;
    if (
      message === 'invalid signature' ||
      message === 'invalid algorithm' ||
      message === 'jwt signature is required'
    ) {
      return 'signature';
    }
    if (
      message.startsWith('jwt audience invalid') ||
      message.startsWith('jwt issuer invalid')
    ) {
      return 'claims';
    }
  }
  return 'malformed';
}
