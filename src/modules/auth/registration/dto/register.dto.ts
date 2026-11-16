import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

import {
  IsPasswordPolicy,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@/modules/auth/password/password-policy';

/**
 * Нормализация email (спека 1.0, раздел 1.3.1): крайние пробелы обрезаются,
 * буквы приводятся к нижнему регистру. Делается ДО валидации и до записи в БД,
 * поэтому `  User@Example.COM ` и `user@example.com` — один и тот же адрес.
 *
 * Чего НЕ делаем: не выбрасываем `+tag` и точки (как это делает Gmail).
 * Спека прямо говорит, что `user+tag@example.com` — отдельный адрес. Правила
 * «одинаковых» адресов зависят от почтового провайдера, сервер их не знает.
 */
export function normalizeEmail(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/**
 * Тело `POST /auth/register`.
 *
 * DTO (Data Transfer Object) описывает форму входящих данных. Глобальный
 * `ValidationPipe` (app.setup.ts):
 * 1. превращает JSON в экземпляр класса (class-transformer, тут срабатывает
 *    `@Transform`);
 * 2. проверяет декораторы class-validator; при нарушении — 400 `validation_failed`;
 * 3. отклоняет лишние поля (`forbidNonWhitelisted`): `{ email, password, role: 'admin' }`
 *    получит 400, а не молча проигнорированное поле.
 */
export class RegisterDto {
  @ApiProperty({ example: 'user@example.com', maxLength: 254 })
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254, { message: 'email must be at most 254 characters long' })
  email!: string;

  /**
   * Пароль НЕ нормализуется: крайние пробелы сохраняются (спека).
   * Политику проверяет `@IsPasswordPolicy()`, см. password-policy.ts.
   */
  @ApiProperty({
    example: 'секрет12',
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    description:
      'От 8 символов, минимум одна буква любого алфавита и одна цифра',
  })
  @IsPasswordPolicy()
  password!: string;
}
