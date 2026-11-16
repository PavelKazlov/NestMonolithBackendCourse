import { BadRequestException } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUUID, Matches, ValidateIf } from 'class-validator';

/**
 * Тело `POST /auth/register/confirm`. Два взаимоисключающих варианта:
 *   OTP:        { "attemptId": "<uuid>", "code": "123456" }
 *   magic link: { "token": "<43 символа base64url>" }
 *
 * `@ValidateIf(условие)` включает проверки поля, только если условие истинно.
 * Условия подобраны так, что:
 * - пустое тело `{}` получает ошибки по всем трём полям: клиенту видно,
 *   что нужен либо OTP (`attemptId` + `code`), либо `token`;
 * - любое присланное поле проверяется по формату;
 * - смесь `token` + `attemptId`/`code` отклоняет `toConfirmationInput` ниже.
 */
export class ConfirmRegistrationDto {
  @ApiPropertyOptional({
    description: 'Идентификатор попытки из ответа регистрации (для OTP)',
    format: 'uuid',
  })
  @ValidateIf(
    (o: ConfirmRegistrationDto) =>
      o.attemptId !== undefined || o.token === undefined,
  )
  @IsUUID('all', { message: 'attemptId must be a UUID' })
  attemptId?: string;

  @ApiPropertyOptional({
    description: 'Код из письма (OTP)',
    example: '042917',
  })
  @ValidateIf(
    (o: ConfirmRegistrationDto) =>
      o.code !== undefined || o.token === undefined,
  )
  // Строка, а не число: у кода бывают ведущие нули ("042917").
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code?: string;

  @ApiPropertyOptional({
    description: 'Токен из ссылки (magic link): 32 байта в base64url',
  })
  @ValidateIf(
    (o: ConfirmRegistrationDto) =>
      o.token !== undefined ||
      (o.attemptId === undefined && o.code === undefined),
  )
  @IsString({ message: 'token must be a string' })
  // 32 байта в base64url без `=` — ровно 43 символа из [A-Za-z0-9_-].
  // Проверка формата отсекает мусор до HMAC и запроса в БД.
  @Matches(/^[A-Za-z0-9_-]{43}$/, { message: 'token has invalid format' })
  token?: string;
}

/** Разобранный вход confirm — дискриминированное объединение (discriminated union). */
export type ConfirmationInput =
  | { kind: 'otp'; attemptId: string; code: string }
  | { kind: 'magic_link'; token: string };

/**
 * Превращает DTO в однозначный вход для сервиса.
 *
 * class-validator проверяет поля по одному и не умеет правило «либо это,
 * либо то» на уровне объекта. Это правило проверяем здесь. Сервис получает
 * тип `ConfirmationInput`, где TypeScript не даст перепутать варианты.
 */
export function toConfirmationInput(
  dto: ConfirmRegistrationDto,
): ConfirmationInput {
  if (dto.token !== undefined) {
    if (dto.attemptId !== undefined || dto.code !== undefined) {
      // Тот же формат, что у ошибок ValidationPipe: фильтр сделает validation_failed.
      throw new BadRequestException([
        'send either token or attemptId with code, not both',
      ]);
    }
    return { kind: 'magic_link', token: dto.token };
  }
  // Сюда попадаем, только если ValidationPipe проверил attemptId и code.
  return { kind: 'otp', attemptId: dto.attemptId!, code: dto.code! };
}
