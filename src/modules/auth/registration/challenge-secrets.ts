import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import {
  generateOtp,
  generateToken,
  hmacSha256,
  safeEqual,
} from '@/core/crypto/crypto.util';
import { ConfirmationMethod } from './registration-challenge.entity';
import { MAGIC_LINK_TOKEN_BYTES, OTP_DIGITS } from './registration.constants';

/**
 * Секреты попыток подтверждения: генерация и HMAC.
 *
 * В БД хранится только `HMAC-SHA256(ключ, данные)`. Ключ лежит в конфигурации
 * (`CHALLENGE_HMAC_KEY`), а не в БД. Даже с полной копией базы нельзя ни
 * восстановить код, ни перебрать миллион вариантов: без ключа HMAC не посчитать.
 *
 * Разделение доменов (domain separation): в данные HMAC добавляем префикс
 * сценария и способа: `registration:otp:...`, `registration:magic_link:...`.
 * Ключ HMAC общий и для входа (1.2), и для смены email (1.5). Без префикса
 * хеш секрета из одного сценария совпал бы с хешем того же секрета в другом.
 * С префиксом «подпись» из одного контекста бесполезна в другом.
 */
@Injectable()
export class ChallengeSecrets {
  private readonly key: string;

  constructor(config: ConfigService) {
    this.key = config.get('CHALLENGE_HMAC_KEY');
  }

  /**
   * Новый секрет для письма:
   * - OTP — 6 цифр из криптостойкого генератора (`randomInt`);
   * - magic link — 32 случайных байта в base64url (43 символа).
   */
  generate(method: ConfirmationMethod): string {
    return method === ConfirmationMethod.Otp
      ? generateOtp(OTP_DIGITS)
      : generateToken(MAGIC_LINK_TOKEN_BYTES);
  }

  /**
   * HMAC секрета для хранения и сравнения.
   *
   * Для OTP в данные входит ещё и `attemptId`. Зачем: кодов всего миллион,
   * и у тысяч пользователей коды неизбежно совпадут. Без `attemptId`
   * одинаковые коды дали бы одинаковые хеши, и по утёкшей таблице было бы
   * видно, у кого коды совпали. С `attemptId` хеш уникален для каждой попытки.
   */
  hash(method: ConfirmationMethod, attemptId: string, secret: string): Buffer {
    return method === ConfirmationMethod.Otp
      ? hmacSha256(this.key, `registration:otp:${attemptId}:${secret}`)
      : this.hashToken(secret);
  }

  /**
   * HMAC токена magic link. Для него `attemptId` НЕ входит в данные:
   * попытку ищут ПО ЭТОМУ ХЕШУ (спека: «идентификатор в токен не входит»),
   * и к моменту поиска id ещё неизвестен.
   */
  hashToken(token: string): Buffer {
    return hmacSha256(this.key, `registration:magic_link:${token}`);
  }

  /**
   * Совпадает ли присланный секрет с сохранённым HMAC.
   * Сравнение за постоянное время (`timingSafeEqual`): обычное `===` или
   * `Buffer.equals` останавливается на первом различии, и по времени ответа
   * можно подбирать хеш побайтно (timing attack).
   */
  matches(
    method: ConfirmationMethod,
    attemptId: string,
    secret: string,
    stored: Buffer,
  ): boolean {
    return safeEqual(this.hash(method, attemptId, secret), stored);
  }
}
