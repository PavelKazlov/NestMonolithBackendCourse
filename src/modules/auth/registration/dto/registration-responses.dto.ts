import { ApiProperty } from '@nestjs/swagger';

import { User, UserStatus } from '@/modules/users/user.entity';
import {
  ConfirmationMethod,
  RegistrationChallenge,
} from '../registration-challenge.entity';
import {
  CHALLENGE_TTL_SECONDS,
  RESEND_COOLDOWN_SECONDS,
} from '../registration.constants';

/**
 * Ответ 201 (регистрация без подтверждения) и 200 (успешный confirm).
 *
 * Отдельный класс ответа, а не сущность `User`: в ответ попадают ТОЛЬКО
 * перечисленные поля. Если завтра в `User` добавят поле, оно не утечёт
 * в API само собой. Пароля, хеша и токенов здесь нет и быть не может.
 */
export class RegisteredUserResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'user@example.com' })
  email!: string;

  @ApiProperty({ enum: UserStatus, example: UserStatus.Active })
  status!: UserStatus;

  static from(user: User): RegisteredUserResponse {
    return { id: user.id, email: user.email, status: user.status };
  }
}

/**
 * Ответ 202 (регистрация с подтверждением и resend).
 * Секрета (кода или токена) здесь НЕТ: он только в письме. Иначе
 * подтверждение ничего бы не доказывало: клиент получил бы код и без доступа к ящику.
 */
export class ConfirmationRequiredResponse {
  @ApiProperty({ example: true })
  confirmationRequired!: true;

  @ApiProperty({ enum: ConfirmationMethod })
  method!: ConfirmationMethod;

  @ApiProperty({ format: 'uuid', description: 'Нужен для confirm по коду' })
  attemptId!: string;

  @ApiProperty({ example: CHALLENGE_TTL_SECONDS })
  expiresInSeconds!: number;

  @ApiProperty({ example: RESEND_COOLDOWN_SECONDS })
  resendAfterSeconds!: number;

  static from(challenge: RegistrationChallenge): ConfirmationRequiredResponse {
    return {
      confirmationRequired: true,
      method: challenge.method,
      attemptId: challenge.id,
      expiresInSeconds: CHALLENGE_TTL_SECONDS,
      resendAfterSeconds: RESEND_COOLDOWN_SECONDS,
    };
  }
}

/** Схема ошибки для Swagger: единый формат из AllExceptionsFilter. */
export class ErrorResponse {
  @ApiProperty({ example: 'email_taken' })
  code!: string;

  @ApiProperty({ example: 'Email is already registered' })
  message!: string;

  @ApiProperty({ format: 'uuid' })
  requestId!: string;
}
