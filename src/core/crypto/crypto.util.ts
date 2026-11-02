import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Криптографические примитивы, общие для нескольких заданий
 * (коды подтверждения, magic link, подписанные курсоры).
 * Всё построено на встроенном модуле `node:crypto`, без самописной криптографии.
 */

/**
 * HMAC-SHA256: «подпись» данных секретным ключом.
 *
 * Зачем HMAC, а не просто SHA-256 для хранения OTP-кода в БД? Кодов из 6 цифр
 * всего миллион. Если БД утечёт, а там лежит голый SHA-256(code), перебрать
 * миллион хешей можно за доли секунды. HMAC без ключа не посчитать, а ключ
 * лежит в конфигурации приложения, а не в БД. Утечка одной только базы
 * не раскрывает коды.
 */
export function hmacSha256(key: string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * Сравнение двух секретов за постоянное время.
 *
 * Обычное `a === b` останавливается на первом несовпавшем байте. Время ответа
 * чуть-чуть зависит от того, сколько первых байт угадано, и по этой разнице
 * атакующий может подбирать секрет побайтно (timing attack). `timingSafeEqual`
 * всегда сравнивает все байты.
 *
 * `timingSafeEqual` падает на буферах разной длины, поэтому длину проверяем
 * заранее. Длина HMAC фиксирована (32 байта), так что эта проверка ничего не выдаёт.
 */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Одноразовый цифровой код (OTP) из `digits` цифр, например "042917".
 * `randomInt` берёт криптостойкий генератор. `Math.random()` для секретов
 * не годится: он предсказуем.
 */
export function generateOtp(digits = 6): string {
  return randomInt(0, 10 ** digits)
    .toString()
    .padStart(digits, '0');
}

/**
 * Случайный секрет в base64url. Это base64 без `+`, `/` и `=`, его можно
 * без экранирования класть в URL. Для magic link спека требует 32 байта (256 бит).
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Случайная hex-строка: 16 байт дают 32 hex-символа (например, jobId в 1.6). */
export function generateHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}
