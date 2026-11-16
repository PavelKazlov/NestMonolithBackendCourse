import { MailMessage } from '@/core/mail/mail-sender';
import { ConfirmationMethod } from '@/modules/auth/registration/registration-challenge.entity';
import { LOGIN_CHALLENGE_TTL_SECONDS } from './login.constants';

const TTL_MINUTES = LOGIN_CHALLENGE_TTL_SECONDS / 60;

/**
 * Токен magic link: `attemptId.secret` (спека 1.2, раздел 1.3.2).
 * Id нужен, чтобы найти попытку, а секрет доказывает доступ к почте.
 */
export function buildMagicLinkToken(attemptId: string, secret: string): string {
  return `${attemptId}.${secret}`;
}

/**
 * Ссылка `https://app.example/login/confirm#token=<attemptId.secret>`.
 *
 * Токен во ФРАГМЕНТЕ URL (`#...`). Браузер не отправляет фрагмент ни серверу,
 * ни в `Referer`, поэтому секрета нет в access-логах. Открытие ссылки (GET)
 * ничего не подтверждает: страница читает `location.hash` и отправляет
 * `POST /auth/login/confirm { token }`. Почтовый сканер, открывший ссылку
 * GET-запросом, вход не израсходует (теоретический вопрос 5 главы).
 */
export function buildLoginMagicLink(confirmUrl: string, token: string): string {
  return `${confirmUrl}#token=${encodeURIComponent(token)}`;
}

/** Письмо со вторым шагом входа. Чистая функция, легко проверить тестом. */
export function buildLoginMail(
  to: string,
  method: ConfirmationMethod,
  attemptId: string,
  secret: string,
  confirmUrl: string,
): MailMessage {
  const subject = 'Подтвердите вход';
  const warning =
    'Если вы не входили в аккаунт, проигнорируйте письмо и смените пароль: ' +
    'кто-то знает ваш пароль.';

  if (method === ConfirmationMethod.Otp) {
    return {
      to,
      subject,
      text:
        `Код для входа: ${secret}\n\n` +
        `Код действует ${TTL_MINUTES} минут. ${warning}`,
    };
  }

  const link = buildLoginMagicLink(
    confirmUrl,
    buildMagicLinkToken(attemptId, secret),
  );
  return {
    to,
    subject,
    text:
      `Чтобы войти, откройте ссылку и нажмите «Войти»:\n${link}\n\n` +
      `Ссылка действует ${TTL_MINUTES} минут и срабатывает один раз. ${warning}`,
  };
}
