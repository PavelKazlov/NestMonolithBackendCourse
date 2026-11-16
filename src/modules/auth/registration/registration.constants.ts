/**
 * Числа из контракта 1.0. Это часть API, а не настройка: клиент получает
 * `expiresInSeconds: 600` и `resendAfterSeconds: 60` в ответе и строит на них
 * таймеры в интерфейсе. Поэтому значения зафиксированы в коде, а не в env.
 */

/** TTL попытки: 10 минут после отправки письма. */
export const CHALLENGE_TTL_SECONDS = 600;

/** Повторная отправка не чаще раза в 60 секунд. */
export const RESEND_COOLDOWN_SECONDS = 60;

/** Лимит неверных вводов кода. Пятый неверный ввод гасит попытку. */
export const MAX_CONFIRM_ATTEMPTS = 5;

/** Длина OTP-кода. */
export const OTP_DIGITS = 6;

/** Длина токена magic link в байтах (256 бит случайности). */
export const MAGIC_LINK_TOKEN_BYTES = 32;
