import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import {
  MailDeliveryError,
  MailMessage,
  MailSender,
} from '@/core/mail/mail-sender';
import { PasswordHasher } from '@/modules/auth/password/password-hasher';
import { UserStatus } from '@/modules/users/user.entity';

/**
 * Фейковая почта для e2e: письма складываются в массив, `failing = true`
 * имитирует упавший SMTP. Тест «читает почтовый ящик», как пользователь.
 */
export class FakeMailSender extends MailSender {
  sent: MailMessage[] = [];
  failing = false;

  send(message: MailMessage): Promise<void> {
    if (this.failing) {
      return Promise.reject(new MailDeliveryError(new Error('SMTP down')));
    }
    this.sent.push(message);
    return Promise.resolve();
  }

  last(): MailMessage {
    return this.sent[this.sent.length - 1];
  }
}

/** OTP из письма. */
export const codeFrom = (mail: MailMessage) =>
  /\b(\d{6})\b/.exec(mail.text)![1];

/** Токен magic link `attemptId.secret` из фрагмента ссылки. */
export const loginTokenFrom = (mail: MailMessage) =>
  decodeURIComponent(/#token=([^\s]+)/.exec(mail.text)![1]);

export const PASSWORD = 'секрет12';

/**
 * Пользователь сразу в БД, в обход регистрации: тесты входа не должны
 * зависеть от сценария 1.0. Хеш считает тот же PasswordHasher (Argon2id).
 */
export async function createUser(
  app: NestFastifyApplication,
  email: string,
  status: UserStatus = UserStatus.Active,
  password = PASSWORD,
): Promise<string> {
  const id = randomUUID();
  const hash = await app.get(PasswordHasher).hash(password);
  await app
    .get(DataSource)
    .query(
      'INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, $3, $4)',
      [id, email, hash, status],
    );
  return id;
}

/** Cookie из ответа `inject` (light-my-request разбирает Set-Cookie). */
export interface ResponseCookie {
  name: string;
  value: string;
  path?: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  domain?: string;
  expires?: Date;
}

export function cookieMap(res: {
  cookies: unknown[];
}): Record<string, ResponseCookie> {
  return Object.fromEntries(
    (res.cookies as ResponseCookie[]).map((cookie) => [cookie.name, cookie]),
  );
}
