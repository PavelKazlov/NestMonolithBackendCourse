import { MailMessage } from '@/core/mail/mail-sender';
import { ConfirmationMethod } from './registration-challenge.entity';
import { CHALLENGE_TTL_SECONDS } from './registration.constants';

/**
 * Тексты писем подтверждения. Чистые функции без зависимостей:
 * их легко проверить unit-тестом и легко поменять текст.
 */

const TTL_MINUTES = CHALLENGE_TTL_SECONDS / 60;

/**
 * Ссылка magic link: `https://app.example/register/confirm#token=<токен>`.
 *
 * Токен — во ФРАГМЕНТЕ (`#...`), а не в query (`?token=...`). Фрагмент браузер
 * не отправляет на сервер: токен не попадёт в access-логи фронтенд-сервера
 * и прокси и в заголовок Referer при переходах со страницы.
 *
 * Открытие ссылки (GET) аккаунт НЕ активирует. Страница фронтенда читает токен
 * из `location.hash` и отправляет `POST /auth/register/confirm { token }`.
 * Почтовые сканеры и превью ссылок сами открывают URL методом GET. Если бы
 * GET активировал аккаунт, одноразовый токен израсходовал бы сканер, а не человек.
 */
export function buildMagicLink(confirmUrl: string, token: string): string {
  return `${confirmUrl}#token=${encodeURIComponent(token)}`;
}

export function buildConfirmationMail(
  to: string,
  method: ConfirmationMethod,
  secret: string,
  confirmUrl: string,
): MailMessage {
  const subject = 'Подтвердите регистрацию';

  if (method === ConfirmationMethod.Otp) {
    return {
      to,
      subject,
      text:
        `Ваш код подтверждения: ${secret}\n\n` +
        `Код действует ${TTL_MINUTES} минут. Если вы не регистрировались, ` +
        `просто проигнорируйте это письмо.`,
    };
  }

  const link = buildMagicLink(confirmUrl, secret);
  return {
    to,
    subject,
    text:
      `Чтобы завершить регистрацию, откройте ссылку и нажмите «Подтвердить»:\n` +
      `${link}\n\n` +
      `Ссылка действует ${TTL_MINUTES} минут и срабатывает один раз. ` +
      `Если вы не регистрировались, просто проигнорируйте это письмо.`,
  };
}
