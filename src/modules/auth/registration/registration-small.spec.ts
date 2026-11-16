import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
} from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';

import { AuditLogger } from '@/core/audit/audit-logger';
import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import { ConfirmationMethod } from './registration-challenge.entity';
import { RegistrationAuditInterceptor } from './registration-audit.interceptor';
import { RegistrationSettings } from './registration.settings';

describe('RegistrationSettings', () => {
  const settingsWith = (values: Record<string, unknown>) =>
    new RegistrationSettings({
      get: (key: string) => values[key],
    } as unknown as ConfigService);

  it('читает флаг, способ и URL из конфигурации', () => {
    const settings = settingsWith({
      REGISTRATION_CONFIRMATION_ENABLED: true,
      REGISTRATION_CONFIRMATION_METHOD: 'magic_link',
      REGISTRATION_CONFIRM_URL: 'https://app.example/confirm',
    });

    expect(settings.confirmationEnabled).toBe(true);
    expect(settings.confirmationMethod).toBe(ConfirmationMethod.MagicLink);
    expect(settings.confirmUrl).toBe('https://app.example/confirm');
  });

  it('значения по умолчанию: выключено, OTP, локальный фронтенд', () => {
    const settings = settingsWith({});

    expect(settings.confirmationEnabled).toBe(false);
    expect(settings.confirmationMethod).toBe(ConfirmationMethod.Otp);
    expect(settings.confirmUrl).toBe('http://localhost:5174/register/confirm');
  });
});

describe('RegistrationAuditInterceptor', () => {
  const audit = { warn: jest.fn(), info: jest.fn() };
  const interceptor = new RegistrationAuditInterceptor(
    audit as unknown as AuditLogger,
  );
  const contextFor = (handlerName: string) =>
    ({
      getHandler: () => ({ name: handlerName }),
    }) as unknown as ExecutionContext;
  const failing = (error: unknown): CallHandler => ({
    handle: () => throwError(() => error),
  });

  beforeEach(() => audit.warn.mockReset());

  it.each([
    ['register', 'registration.failed'],
    ['confirm', 'registration.confirmation.failed'],
    ['resend', 'registration.resend.failed'],
  ])('ошибка валидации в %s → аудит %s', async (handler, event) => {
    const error = new BadRequestException(['email must be an email']);

    await expect(
      lastValueFrom(interceptor.intercept(contextFor(handler), failing(error))),
    ).rejects.toBe(error);
    expect(audit.warn).toHaveBeenCalledWith(event, {
      reason: 'validation_failed',
    });
  });

  it('бизнес-ошибки (AppException) не дублирует: их пишет сервис', async () => {
    const error = new AppException(409, 'email_taken');

    await expect(
      lastValueFrom(
        interceptor.intercept(contextFor('register'), failing(error)),
      ),
    ).rejects.toBe(error);
    expect(audit.warn).not.toHaveBeenCalled();
  });

  it('успешный ответ проходит без изменений', async () => {
    await expect(
      lastValueFrom(
        interceptor.intercept(contextFor('register'), {
          handle: () => of('ok'),
        }),
      ),
    ).resolves.toBe('ok');
  });
});
