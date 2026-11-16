import { ApiProperty } from '@nestjs/swagger';

import { ConfirmationMethod } from '@/modules/auth/registration/registration-challenge.entity';
import {
  LOGIN_CHALLENGE_TTL_SECONDS,
  LOGIN_RESEND_COOLDOWN_SECONDS,
} from '../login.constants';
import type { LoginChallenge } from '../login-challenge.entity';

/**
 * Ответ 202 на resend (спека 1.2, раздел 1.3.2). Секрета здесь нет: он только
 * в письме. Иначе второй шаг ничего бы не доказывал.
 */
export class LoginResendResponse {
  @ApiProperty({ enum: ConfirmationMethod })
  method!: ConfirmationMethod;

  @ApiProperty({ format: 'uuid' })
  attemptId!: string;

  @ApiProperty({ example: LOGIN_CHALLENGE_TTL_SECONDS })
  expiresInSeconds!: number;

  @ApiProperty({ example: LOGIN_RESEND_COOLDOWN_SECONDS })
  resendAfterSeconds!: number;

  static from(
    challenge: Pick<LoginChallenge, 'id' | 'method'>,
  ): LoginResendResponse {
    return {
      method: challenge.method,
      attemptId: challenge.id,
      expiresInSeconds: LOGIN_CHALLENGE_TTL_SECONDS,
      resendAfterSeconds: LOGIN_RESEND_COOLDOWN_SECONDS,
    };
  }
}

/**
 * Ответ 202 на login, когда нужен второй шаг (спека 1.2, раздел 1.3.1).
 * Тот же набор полей плюс `confirmationRequired: true`: по нему клиент
 * понимает, что cookies ещё нет и надо показать форму кода или «проверьте почту».
 */
export class LoginChallengeResponse extends LoginResendResponse {
  @ApiProperty({ example: true })
  confirmationRequired!: true;

  static from(
    challenge: Pick<LoginChallenge, 'id' | 'method'>,
  ): LoginChallengeResponse {
    return {
      confirmationRequired: true,
      ...LoginResendResponse.from(challenge),
    };
  }
}
