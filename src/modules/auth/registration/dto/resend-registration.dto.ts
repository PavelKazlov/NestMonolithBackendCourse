import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

import { normalizeEmail } from './register.dto';

/** Тело `POST /auth/register/resend`. Email нормализуется так же, как при регистрации. */
export class ResendRegistrationDto {
  @ApiProperty({ example: 'user@example.com', maxLength: 254 })
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254, { message: 'email must be at most 254 characters long' })
  email!: string;
}
