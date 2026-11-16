import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

import { PASSWORD_MAX_LENGTH } from '@/modules/auth/password/password-policy';
import { normalizeEmail } from '@/modules/auth/registration/dto/register.dto';

/**
 * Тело `POST /auth/login` (спека 1.2, раздел 1.3.1).
 *
 * - `email` нормализуется так же, как при регистрации (trim + нижний регистр),
 *   иначе `User@Example.com` не нашёлся бы по индексу.
 * - `password` НЕ нормализуется: пробелы по краям и внутри — часть пароля.
 *   Политику пароля (длина, буквы, цифры) при входе НЕ проверяем: она для
 *   новых паролей. Если политику ужесточат, старый пароль всё равно должен
 *   подходить. Ограничиваем только формат и длину сверху: мегабайтный «пароль»
 *   заставил бы Argon2 работать вхолостую (дешёвая DoS-атака).
 */
export class LoginDto {
  @ApiProperty({ example: 'user@example.com', maxLength: 254 })
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254, { message: 'email must be at most 254 characters long' })
  email!: string;

  @ApiProperty({ example: 'секрет12', maxLength: PASSWORD_MAX_LENGTH })
  @IsString({ message: 'password must be a string' })
  @MinLength(1, { message: 'password must not be empty' })
  @MaxLength(PASSWORD_MAX_LENGTH, {
    message: `password must be at most ${PASSWORD_MAX_LENGTH} characters long`,
  })
  password!: string;
}
