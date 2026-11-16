import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MailModule } from '@/core/mail/mail.module';
import { UsersModule } from '@/modules/users/users.module';
import { LoginChallenge } from './login/login-challenge.entity';
import { LoginChallengeSecrets } from './login/login-challenge-secrets';
import { LoginAuditInterceptor } from './login/login-audit.interceptor';
import { LoginFailureLimiter } from './login/login-failure-limiter';
import { LoginController } from './login/login.controller';
import { LoginService } from './login/login.service';
import { LoginSettings } from './login/login.settings';
import { PasswordHasher } from './password/password-hasher';
import { ChallengeSecrets } from './registration/challenge-secrets';
import { RegistrationChallenge } from './registration/registration-challenge.entity';
import { RegistrationAuditInterceptor } from './registration/registration-audit.interceptor';
import { RegistrationController } from './registration/registration.controller';
import { RegistrationService } from './registration/registration.service';
import { RegistrationSettings } from './registration/registration.settings';
import { AccessGuard } from './session/access.guard';
import { SessionController } from './session/session.controller';
import { SessionService } from './session/session.service';
import { AuthCookies } from './tokens/auth-cookies';
import { TokenService } from './tokens/token.service';

/**
 * Модуль аутентификации:
 * - регистрация (1.0): `registration/`;
 * - вход и email challenge (1.2): `login/`;
 * - JWT и cookies (1.2): `tokens/`;
 * - refresh, logout и проверка access (1.2): `session/`.
 *
 * С пользователями модуль работает только через `UsersService`.
 *
 * Экспорт `AccessGuard` и `SessionService`: другие модули (профиль 1.4,
 * RBAC admin API 1.1) подключат `@UseGuards(AccessGuard)` к своим
 * маршрутам. Guard создаётся в контексте модуля-потребителя, поэтому его
 * зависимость SessionService тоже должна быть доступна там.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([RegistrationChallenge, LoginChallenge]),
    UsersModule,
    MailModule,
  ],
  controllers: [RegistrationController, LoginController, SessionController],
  providers: [
    RegistrationService,
    RegistrationSettings,
    ChallengeSecrets,
    PasswordHasher,
    RegistrationAuditInterceptor,
    LoginService,
    LoginSettings,
    LoginChallengeSecrets,
    LoginFailureLimiter,
    LoginAuditInterceptor,
    TokenService,
    AuthCookies,
    SessionService,
    AccessGuard,
  ],
  exports: [AccessGuard, SessionService],
})
export class AuthModule {}
