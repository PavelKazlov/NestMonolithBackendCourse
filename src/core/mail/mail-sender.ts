/**
 * Порт (port) отправки почты.
 *
 * Это интерфейс на границе с внешним миром (глава 0.3: «порты только на границах
 * с внешним — хранилище, почта»). Бизнес-код (регистрация, вход, смена email)
 * зависит от абстракции `MailSender`, а не от Nodemailer или SMTP. Отсюда два плюса:
 * - в тестах подменяем отправку фейком и проверяем, какое письмо «ушло»,
 *   без настоящего SMTP;
 * - сменить провайдера (SMTP → SendGrid API) значит написать новый адаптер,
 *   а сервисы не трогать.
 *
 * Абстрактный класс, а не `interface`: интерфейсы TypeScript исчезают после
 * компиляции, поэтому Nest не может использовать их как токен внедрения
 * зависимостей. Абстрактный класс существует в рантайме и служит токеном.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export abstract class MailSender {
  /**
   * Отправляет письмо. При неудаче бросает `MailDeliveryError`. Вызывающий
   * сервис решает, что делать: по спеке 1.0 и 1.2 сбой SMTP превращается в
   * ответ 503, а уже сохранённая попытка подтверждения остаётся в БД.
   */
  abstract send(message: MailMessage): Promise<void>;
}

/**
 * Ошибка доставки письма. Исходную ошибку библиотеки храним в `cause` для лога,
 * а наружу она не уходит.
 */
export class MailDeliveryError extends Error {
  constructor(cause: unknown) {
    super('Mail delivery failed', { cause });
    this.name = 'MailDeliveryError';
  }
}
