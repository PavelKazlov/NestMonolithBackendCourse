import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import {
  generateOtp,
  generateToken,
  hmacSha256,
  safeEqual,
} from '@/core/crypto/crypto.util';
import { ConfirmationMethod } from '@/modules/auth/registration/registration-challenge.entity';
import {
  LOGIN_MAGIC_LINK_SECRET_BYTES,
  LOGIN_OTP_DIGITS,
} from './login.constants';

/**
 * Секреты попыток входа: генерация и HMAC (спека 1.2, «Email challenge»).
 *
 * Как и в регистрации (ChallengeSecrets, 1.0), в БД лежит только HMAC-SHA256.
 * Отличия:
 * - ключ ОТДЕЛЬНЫЙ: `LOGIN_CHALLENGE_HMAC_KEY` (спека 1.2: «отдельный
 *   случайный ключ длиной не менее 32 байт»);
 * - и для OTP, и для magic link в данные HMAC входит `attemptId`. Попытку
 *   входа всегда находят по id (токен ссылки — это `attemptId.secret`), так
 *   что id известен до сравнения. Поэтому одинаковые коды у разных попыток
 *   дают разные хеши.
 *
 * Разделение доменов: префикс `login:<method>:`. Даже при общем ключе HMAC
 * секрета входа не совпал бы с HMAC того же секрета в другом сценарии или
 * другим способом. Это защита в глубину поверх отдельного ключа.
 */
@Injectable()
export class LoginChallengeSecrets {
  private readonly key: string;

  constructor(config: ConfigService) {
    this.key = config.get('LOGIN_CHALLENGE_HMAC_KEY');
  }

  /**
   * Новый секрет для письма из криптостойкого генератора:
   * - OTP — ровно 6 цифр (`randomInt`, с ведущими нулями);
   * - magic link — 32 случайных байта в base64url.
   */
  generate(method: ConfirmationMethod): string {
    return method === ConfirmationMethod.Otp
      ? generateOtp(LOGIN_OTP_DIGITS)
      : generateToken(LOGIN_MAGIC_LINK_SECRET_BYTES);
  }

  hash(method: ConfirmationMethod, attemptId: string, secret: string): Buffer {
    return hmacSha256(this.key, `login:${method}:${attemptId}:${secret}`);
  }

  /** Сравнение за постоянное время (`timingSafeEqual`). */
  matches(
    method: ConfirmationMethod,
    attemptId: string,
    secret: string,
    stored: Buffer,
  ): boolean {
    return safeEqual(this.hash(method, attemptId, secret), stored);
  }
}
