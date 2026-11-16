import { BadRequestException } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUUID, Matches, ValidateIf } from 'class-validator';

import { ConfirmationMethod } from '@/modules/auth/registration/registration-challenge.entity';

/**
 * Токен magic link: `<attemptId (UUID)>.<секрет: 43 символа base64url>`.
 * 32 байта в base64url без `=` — ровно 43 символа из `[A-Za-z0-9_-]`.
 */
const MAGIC_LINK_TOKEN_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i;

/**
 * Тело `POST /auth/login/confirm`. Два взаимоисключающих варианта
 * (спека 1.2, раздел 1.3.2):
 *   OTP:        { "attemptId": "<uuid>", "code": "123456" }
 *   magic link: { "token": "<attemptId>.<secret>" }
 *
 * Условия `@ValidateIf` устроены как в регистрации (1.0): пустое тело получает
 * ошибки по всем полям, присланные поля проверяются по формату, а смесь
 * вариантов отклоняет `toLoginConfirmationInput`.
 */
export class ConfirmLoginDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'attemptId из ответа 202 (для OTP)',
  })
  @ValidateIf(
    (o: ConfirmLoginDto) => o.attemptId !== undefined || o.token === undefined,
  )
  @IsUUID('all', { message: 'attemptId must be a UUID' })
  attemptId?: string;

  @ApiPropertyOptional({
    example: '042917',
    description: 'Код из письма (OTP)',
  })
  @ValidateIf(
    (o: ConfirmLoginDto) => o.code !== undefined || o.token === undefined,
  )
  // Строка, а не число: у кода бывают ведущие нули.
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code?: string;

  @ApiPropertyOptional({
    description: 'Токен из фрагмента ссылки: attemptId.secret',
  })
  @ValidateIf(
    (o: ConfirmLoginDto) =>
      o.token !== undefined ||
      (o.attemptId === undefined && o.code === undefined),
  )
  @IsString({ message: 'token must be a string' })
  @Matches(MAGIC_LINK_TOKEN_PATTERN, { message: 'token has invalid format' })
  token?: string;
}

/**
 * Разобранный вход confirm. В обоих вариантах есть `attemptId`: попытку
 * всегда ищут по id, а `kind` должен совпасть со способом попытки.
 */
export type LoginConfirmationInput = {
  kind: ConfirmationMethod;
  attemptId: string;
  secret: string;
};

/** DTO → однозначный вход сервиса; правило «либо OTP, либо token». */
export function toLoginConfirmationInput(
  dto: ConfirmLoginDto,
): LoginConfirmationInput {
  if (dto.token !== undefined) {
    if (dto.attemptId !== undefined || dto.code !== undefined) {
      throw new BadRequestException([
        'send either token or attemptId with code, not both',
      ]);
    }
    // Формат уже проверен ValidationPipe, поэтому match не может быть null.
    const [, attemptId, secret] = MAGIC_LINK_TOKEN_PATTERN.exec(dto.token)!;
    return {
      kind: ConfirmationMethod.MagicLink,
      attemptId: attemptId.toLowerCase(),
      secret,
    };
  }
  return {
    kind: ConfirmationMethod.Otp,
    attemptId: dto.attemptId!.toLowerCase(),
    secret: dto.code!,
  };
}
