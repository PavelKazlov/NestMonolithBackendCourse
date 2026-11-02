import { createTransport } from 'nodemailer';

import { ConfigService } from '@/core/config/config.service';
import { MailDeliveryError } from './mail-sender';
import { SmtpMailSender } from './smtp-mail-sender';

// Подменяем nodemailer целиком: unit-тест не должен ходить в сеть.
jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('SmtpMailSender', () => {
  const sendMail = jest.fn();
  const config = {
    get: jest.fn(
      (key: string) =>
        ({
          SMTP_HOST: 'localhost',
          SMTP_PORT: 1025,
          SMTP_SECURE: false,
          SMTP_USER: '',
          SMTP_FROM: 'App <no-reply@example.test>',
        })[key],
    ),
  } as unknown as ConfigService;

  beforeEach(() => {
    sendMail.mockReset();
    (createTransport as jest.Mock).mockReturnValue({ sendMail });
  });

  it('отправляет письмо с адресом отправителя из конфига', async () => {
    sendMail.mockResolvedValue({});
    const sender = new SmtpMailSender(config);

    await sender.send({ to: 'a@example.test', subject: 'Hi', text: 'Body' });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'App <no-reply@example.test>',
      to: 'a@example.test',
      subject: 'Hi',
      text: 'Body',
    });
    // Пустой SMTP_USER → без авторизации.
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: undefined }),
    );
  });

  it('оборачивает сбой SMTP в MailDeliveryError', async () => {
    sendMail.mockRejectedValue(new Error('ECONNREFUSED'));
    const sender = new SmtpMailSender(config);

    await expect(
      sender.send({ to: 'a@example.test', subject: 'Hi', text: 'Body' }),
    ).rejects.toBeInstanceOf(MailDeliveryError);
  });
});
