import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MailModule } from '@/core/mail/mail.module';
import { UsersModule } from '@/modules/users/users.module';
import { PasswordHasher } from './password/password-hasher';
import { ChallengeSecrets } from './registration/challenge-secrets';
import { RegistrationChallenge } from './registration/registration-challenge.entity';
import { RegistrationAuditInterceptor } from './registration/registration-audit.interceptor';
import { RegistrationController } from './registration/registration.controller';
import { RegistrationService } from './registration/registration.service';
import { RegistrationSettings } from './registration/registration.settings';

/**
 * Модуль аутентификации. Сейчас — регистрация (1.0).
 * В 1.2 сюда добавятся вход, refresh и logout: они переиспользуют
 * `PasswordHasher` и подход с HMAC-попытками (`login_challenges`).
 *
 * С пользователями модуль работает только через `UsersService`
 * (импорт `UsersModule`). Таблицей `users` владеет модуль users.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([RegistrationChallenge]),
    UsersModule,
    MailModule,
  ],
  controllers: [RegistrationController],
  providers: [
    RegistrationService,
    RegistrationSettings,
    ChallengeSecrets,
    PasswordHasher,
    RegistrationAuditInterceptor,
  ],
})
export class AuthModule {}
