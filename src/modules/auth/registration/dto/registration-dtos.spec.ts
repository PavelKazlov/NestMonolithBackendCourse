import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  ConfirmRegistrationDto,
  toConfirmationInput,
} from './confirm-registration.dto';
import { normalizeEmail, RegisterDto } from './register.dto';
import { ResendRegistrationDto } from './resend-registration.dto';

/**
 * Так же, как ValidationPipe: сначала class-transformer (там срабатывает
 * @Transform), затем class-validator. Возвращаем объект и имена полей с ошибками.
 */
async function check<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
) {
  const dto = plainToInstance(cls, plain);
  const errors = await validate(dto);
  return { dto, fields: errors.map((e) => e.property) };
}

const ATTEMPT_ID = '2b3f0549-d5b1-4ec1-a3e0-ead23328718d';
const TOKEN = 'a'.repeat(43);

describe('normalizeEmail', () => {
  it('обрезает крайние пробелы и приводит к нижнему регистру', () => {
    expect(normalizeEmail('  User+Tag@Example.COM ')).toBe(
      'user+tag@example.com',
    );
  });

  it('не строку возвращает как есть (её отклонит @IsEmail)', () => {
    expect(normalizeEmail(42)).toBe(42);
  });
});

describe('RegisterDto', () => {
  it('нормализует email, пароль оставляет как есть', async () => {
    const { dto, fields } = await check(RegisterDto, {
      email: ' User@Example.com ',
      password: ' секрет12 ',
    });

    expect(fields).toEqual([]);
    expect(dto.email).toBe('user@example.com');
    expect(dto.password).toBe(' секрет12 ');
  });

  it.each([
    [{ email: 'not-an-email', password: 'секрет12' }, ['email']],
    [{ email: 'a@b.co', password: 'short' }, ['password']],
    [{}, ['email', 'password']],
    [{ email: `${'a'.repeat(250)}@b.co`, password: 'секрет12' }, ['email']],
  ])('невалидный вход %p → ошибки в %p', async (plain, expected) => {
    const { fields } = await check(RegisterDto, plain);

    expect(fields).toEqual(expected);
  });
});

describe('ResendRegistrationDto', () => {
  it('нормализует email', async () => {
    const { dto, fields } = await check(ResendRegistrationDto, {
      email: ' A@B.CO',
    });

    expect(fields).toEqual([]);
    expect(dto.email).toBe('a@b.co');
  });

  it('невалидный email → ошибка', async () => {
    expect((await check(ResendRegistrationDto, { email: 'x' })).fields).toEqual(
      ['email'],
    );
  });
});

describe('ConfirmRegistrationDto', () => {
  it('OTP-вариант валиден', async () => {
    expect(
      (
        await check(ConfirmRegistrationDto, {
          attemptId: ATTEMPT_ID,
          code: '042917',
        })
      ).fields,
    ).toEqual([]);
  });

  it('вариант с токеном валиден', async () => {
    expect(
      (await check(ConfirmRegistrationDto, { token: TOKEN })).fields,
    ).toEqual([]);
  });

  it.each([
    [{}, ['attemptId', 'code', 'token']],
    [{ attemptId: 'nope', code: '12345' }, ['attemptId', 'code']],
    [{ attemptId: ATTEMPT_ID, code: 123456 }, ['code']],
    [{ token: 'short' }, ['token']],
    [{ token: TOKEN, code: 'x' }, ['code']],
  ])('%p → ошибки в %p', async (plain, expected) => {
    expect((await check(ConfirmRegistrationDto, plain)).fields).toEqual(
      expected,
    );
  });
});

describe('toConfirmationInput', () => {
  it('OTP', () => {
    expect(
      toConfirmationInput({ attemptId: ATTEMPT_ID, code: '042917' }),
    ).toEqual({ kind: 'otp', attemptId: ATTEMPT_ID, code: '042917' });
  });

  it('magic link', () => {
    expect(toConfirmationInput({ token: TOKEN })).toEqual({
      kind: 'magic_link',
      token: TOKEN,
    });
  });

  it('токен вместе с OTP-полями → 400', () => {
    expect(() =>
      toConfirmationInput({
        token: TOKEN,
        attemptId: ATTEMPT_ID,
        code: '042917',
      }),
    ).toThrow(BadRequestException);
  });
});
