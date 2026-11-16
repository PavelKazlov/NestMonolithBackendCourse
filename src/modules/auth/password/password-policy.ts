import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * Политика пароля (спека 1.0, раздел 1.3.1):
 * - от 8 символов;
 * - минимум одна буква ЛЮБОГО алфавита (не только латиница: «секрет12» валиден);
 * - минимум одна цифра;
 * - слишком длинный пароль отклоняется, а не обрезается молча.
 */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * Верхняя граница. Argon2id, в отличие от bcrypt, ничего не обрезает
 * (bcrypt молча отбрасывает байты после 72-го). Но предел всё равно нужен:
 * хешировать мегабайтный «пароль» дорого, это готовый вектор DoS.
 * 128 символов хватит любой парольной фразе и менеджеру паролей.
 * Если когда-то перейдём на bcrypt, предел придётся считать в БАЙТАХ UTF-8 (≤ 72).
 */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Регулярные выражения с флагом `u` (Unicode) и классами свойств:
 * - `\p{L}` — любая буква любого алфавита: латиница, кириллица, греческий...
 *   Обычный `[a-zA-Z]` отверг бы пароль «секрет12», а спека его разрешает.
 * - `\p{Nd}` — десятичная цифра (0–9 и цифры других письменностей).
 */
const HAS_LETTER = /\p{L}/u;
const HAS_DIGIT = /\p{Nd}/u;

/**
 * Возвращает список нарушений политики (пустой — пароль подходит).
 *
 * Длину считаем в символах Unicode (code points), а не в `string.length`:
 * `length` считает UTF-16-единицы, и эмодзи «😀» для него — 2 символа.
 * `[...password]` разбивает строку по code points.
 *
 * Пароль НЕ обрезаем (`trim`): крайние пробелы — часть пароля (спека).
 */
export function checkPasswordPolicy(password: string): string[] {
  const violations: string[] = [];
  const length = [...password].length;

  if (length < PASSWORD_MIN_LENGTH) {
    violations.push(
      `password must be at least ${PASSWORD_MIN_LENGTH} characters long`,
    );
  }
  if (length > PASSWORD_MAX_LENGTH) {
    violations.push(
      `password must be at most ${PASSWORD_MAX_LENGTH} characters long`,
    );
  }
  if (!HAS_LETTER.test(password)) {
    violations.push('password must contain at least one letter');
  }
  if (!HAS_DIGIT.test(password)) {
    violations.push('password must contain at least one digit');
  }
  return violations;
}

/**
 * Декоратор class-validator для DTO: `@IsPasswordPolicy()`.
 *
 * `registerDecorator` — способ написать свой валидатор. `validate` решает,
 * прошло ли значение, `defaultMessage` формирует текст ошибки для `details`
 * в ответе 400. Сам пароль в сообщение не попадает, только правило.
 */
export function IsPasswordPolicy(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isPasswordPolicy',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && checkPasswordPolicy(value).length === 0,
        defaultMessage: (args) =>
          typeof args?.value === 'string'
            ? checkPasswordPolicy(args.value).join('; ')
            : 'password must be a string',
      },
    });
  };
}
