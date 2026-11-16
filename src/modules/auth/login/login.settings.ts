import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import { ConfirmationMethod } from '@/modules/auth/registration/registration-challenge.entity';

/**
 * Настройки подтверждения входа (спека 1.2, раздел 1.1): «Пока отдельного API
 * настроек нет, флаг и способ подтверждения входа меняются в конфигурации».
 *
 * Тот же приём, что RegistrationSettings (1.0): отдельный провайдер вместо
 * `config.get` в сервисе. Это будущая точка замены на модуль настроек, а в
 * e2e его подменяют изменяемым объектом и переключают режимы между тестами.
 * Геттеры читают значение при каждом обращении: изменение действует только
 * на НОВЫЕ входы, уже созданная попытка хранит свой способ в БД.
 */
@Injectable()
export class LoginSettings {
  constructor(private readonly config: ConfigService) {}

  get confirmationEnabled(): boolean {
    return this.config.get('LOGIN_EMAIL_CONFIRMATION_ENABLED') === true;
  }

  get confirmationMethod(): ConfirmationMethod {
    return this.config.get('LOGIN_EMAIL_CONFIRMATION_METHOD') === 'magic_link'
      ? ConfirmationMethod.MagicLink
      : ConfirmationMethod.Otp;
  }

  get confirmUrl(): string {
    return (
      this.config.get('LOGIN_CONFIRM_URL') ??
      'http://localhost:5174/login/confirm'
    );
  }
}
