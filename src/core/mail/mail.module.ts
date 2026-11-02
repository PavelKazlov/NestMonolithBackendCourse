import { Module } from '@nestjs/common';

import { MailSender } from './mail-sender';
import { SmtpMailSender } from './smtp-mail-sender';

/**
 * Модуль почты. Связывает порт и адаптер через DI:
 * кто внедряет `MailSender`, получает `SmtpMailSender`.
 *
 * В тестах эту привязку перекрывают:
 *   Test.createTestingModule(...).overrideProvider(MailSender).useValue(fakeMail)
 */
@Module({
  providers: [{ provide: MailSender, useClass: SmtpMailSender }],
  exports: [MailSender],
})
export class MailModule {}
