/**
 * Числа и имена из контракта 1.2 (раздел 1.3.3). Это часть API, а не
 * настройка: от них зависят клиент (когда вызывать refresh) и атрибуты cookies.
 */

/** Access живёт 15 минут. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Refresh живёт 30 дней. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Допустимое расхождение часов при проверке `exp` и `iat`: не более 30 секунд.
 * Часы серверов никогда не совпадают идеально. Без допуска токен, выпущенный
 * сервером A, мог бы на сервере B с отстающими часами выглядеть «выпущенным
 * в будущем». Допуск не продлевает cookie: её срок ставит браузер по Max-Age.
 */
export const CLOCK_TOLERANCE_SECONDS = 30;

/** Единственный разрешённый алгоритм подписи. */
export const JWT_ALGORITHM = 'HS256';

/** Имена cookies. */
export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';

/**
 * Refresh-cookie видна только этому пути. Браузер не прикладывает её к другим
 * запросам, и refresh-токен не «гуляет» по всему API: меньше мест, где он
 * может утечь (логи прокси, ошибки, сторонние обработчики).
 */
export const REFRESH_COOKIE_PATH = '/auth/refresh';

/** Тип токена в claim `token_use`. */
export enum TokenKind {
  Access = 'access',
  Refresh = 'refresh',
}
