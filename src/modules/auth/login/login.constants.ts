/**
 * Числа из контракта 1.2. Это часть API, а не настройка: клиент получает
 * `expiresInSeconds: 600` и `resendAfterSeconds: 60` и строит на них таймеры.
 * Значения совпадают с регистрацией 1.0, но это контракт другого задания,
 * поэтому константы свои: изменение одной спеки не должно молча менять другую.
 */

/** TTL попытки входа: 10 минут от `last_sent_at`. */
export const LOGIN_CHALLENGE_TTL_SECONDS = 600;

/** Новое письмо (login или resend) не чаще раза в 60 секунд. */
export const LOGIN_RESEND_COOLDOWN_SECONDS = 60;

/** Лимит вводов OTP. Пятый ввод ещё проверяется; пятый неверный гасит попытку. */
export const LOGIN_MAX_OTP_ATTEMPTS = 5;

/** Длина OTP. */
export const LOGIN_OTP_DIGITS = 6;

/** Случайная часть magic link: 32 байта до base64url-кодирования (43 символа). */
export const LOGIN_MAGIC_LINK_SECRET_BYTES = 32;

/** Спека 1.6: «не более 5 неуспешных проверок на пару email и IP за 15 минут». */
export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;
