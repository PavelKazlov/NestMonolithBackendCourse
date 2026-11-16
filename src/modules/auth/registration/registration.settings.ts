import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import { ConfirmationMethod } from './registration-challenge.entity';

/**
 * Настройки сценария «регистрация».
 *
 * Спека 1.0 (раздел 1.1): «Пока нет модуля настроек, флаг задаётся
 * в конфигурации приложения». Отдельный класс вместо прямого
 * `config.get(...)` в сервисе нужен по двум причинам:
 * 1. Точка замены. Когда появится модуль настроек (флаг меняется без
 *    перезапуска), поменяется только этот класс, а сервис регистрации нет.
 * 2. Тесты. В e2e этот провайдер подменяют изменяемым объектом и переключают
 *    флаг между тестами в одном приложении, не пересобирая его.
 *
 * Значения читаются при каждом обращении (геттеры), а не один раз
 * в конструкторе. Так работает и подмена, и будущие «живые» настройки.
 */
@Injectable()
export class RegistrationSettings {
  constructor(private readonly config: ConfigService) {}

  /** Нужно ли подтверждать email у НОВЫХ регистраций. */
  get confirmationEnabled(): boolean {
    return this.config.get('REGISTRATION_CONFIRMATION_ENABLED') === true;
  }

  /** Каким способом подтверждать новые регистрации. */
  get confirmationMethod(): ConfirmationMethod {
    return this.config.get('REGISTRATION_CONFIRMATION_METHOD') === 'magic_link'
      ? ConfirmationMethod.MagicLink
      : ConfirmationMethod.Otp;
  }

  /** Страница фронтенда, на которую ведёт magic link. */
  get confirmUrl(): string {
    return (
      this.config.get('REGISTRATION_CONFIRM_URL') ??
      'http://localhost:5174/register/confirm'
    );
  }
}
