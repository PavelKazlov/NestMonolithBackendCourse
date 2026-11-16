import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/**
 * Тело `POST /auth/login/resend`. Способ попытки не меняется (спека 1.2):
 * сервер берёт его из строки попытки, а не из запроса или текущей настройки.
 */
export class ResendLoginDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: 'attemptId must be a UUID' })
  attemptId!: string;
}
