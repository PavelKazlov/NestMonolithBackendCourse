import { Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';

import { ConfigService } from '@/core/config/config.service';
import { MailDeliveryError, MailMessage, MailSender } from './mail-sender';

/**
 * Адаптер порта `MailSender` для SMTP на базе Nodemailer.
 * Локально SMTP-сервер — Mailpit из docker-compose (письма видны на :8025).
 */
@Injectable()
export class SmtpMailSender extends MailSender {
  private readonly logger = new Logger(SmtpMailSender.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: ConfigService) {
    super();
    const user = config.get('SMTP_USER');

    // Transporter — долгоживущий объект с пулом соединений.
    // Создаём один раз, а не на каждое письмо.
    this.transporter = createTransport({
      host: config.get('SMTP_HOST'),
      port: config.get('SMTP_PORT'),
      secure: config.get('SMTP_SECURE') === true,
      auth: user ? { user, pass: config.get('SMTP_PASSWORD') } : undefined,
      // Таймауты обязательны: без них зависший SMTP-сервер «подвесит» HTTP-запрос
      // пользователя на минуты. Лучше быстро ответить 503.
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
    this.from = config.get('SMTP_FROM');
  }

  async send(message: MailMessage): Promise<void> {
    try {
      await this.transporter.sendMail({ from: this.from, ...message });
    } catch (error: unknown) {
      // В лог не пишем ни адресата, ни тело письма: там email (персональные
      // данные) и одноразовые коды. Только факт и текст ошибки SMTP.
      this.logger.error({ err: error }, 'SMTP delivery failed');
      throw new MailDeliveryError(error);
    }
  }
}
