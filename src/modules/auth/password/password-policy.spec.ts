import { validate } from 'class-validator';

import { checkPasswordPolicy, IsPasswordPolicy } from './password-policy';

describe('checkPasswordPolicy', () => {
  it.each([
    ['секрет12', 'кириллица + цифры (пример из спеки)'],
    ['password1', 'латиница + цифра'],
    ['  pass 1  ', 'крайние пробелы — часть пароля'],
    ['κωδικός9x', 'греческие буквы'],
    ['a'.repeat(127) + '1', 'ровно 128 символов'],
  ])('принимает %p (%s)', (password) => {
    expect(checkPasswordPolicy(password)).toEqual([]);
  });

  it('короче 8 символов → нарушение длины', () => {
    expect(checkPasswordPolicy('abc1')).toEqual([
      'password must be at least 8 characters long',
    ]);
  });

  it('длиннее 128 символов → отклоняется, а не обрезается', () => {
    expect(checkPasswordPolicy('a'.repeat(128) + '1')).toEqual([
      'password must be at most 128 characters long',
    ]);
  });

  it('без букв и без цифр → два нарушения', () => {
    expect(checkPasswordPolicy('12345678')).toEqual([
      'password must contain at least one letter',
    ]);
    expect(checkPasswordPolicy('abcdefgh')).toEqual([
      'password must contain at least one digit',
    ]);
  });

  it('длина считается в символах Unicode, а не в UTF-16', () => {
    // 4 эмодзи = 8 UTF-16-единиц, но всего 4 символа. Вместе с 'a1' — 6 < 8.
    expect(checkPasswordPolicy('😀😀😀😀a1')).toContain(
      'password must be at least 8 characters long',
    );
  });
});

describe('@IsPasswordPolicy', () => {
  class Dto {
    @IsPasswordPolicy()
    password: unknown;
  }

  const errorsFor = async (password: unknown) => {
    const dto = new Dto();
    dto.password = password;
    const [error] = await validate(dto);
    return error?.constraints?.isPasswordPolicy;
  };

  it('валидный пароль → нет ошибок', async () => {
    expect(await errorsFor('секрет12')).toBeUndefined();
  });

  it('сообщение перечисляет нарушения и не содержит сам пароль', async () => {
    const message = await errorsFor('short');

    expect(message).toContain('at least 8 characters');
    expect(message).toContain('at least one digit');
    expect(message).not.toContain('short');
  });

  it('не строка → отдельное сообщение', async () => {
    expect(await errorsFor(12345678)).toBe('password must be a string');
  });
});
