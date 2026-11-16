import { PasswordHasher } from './password-hasher';

/**
 * Тест на НАСТОЯЩЕМ argon2: это повторяет пример из главы 1.0
 * (хеш не равен паролю, два хеша различаются, verify проходит только для
 * исходного пароля). Один хеш занимает десятки миллисекунд, это приемлемо.
 */
describe('PasswordHasher (Argon2id)', () => {
  const hasher = new PasswordHasher();
  const password = 'секрет12';

  it('строка хеша — Argon2id с параметрами OWASP и без пароля внутри', async () => {
    const stored = await hasher.hash(password);

    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(stored).not.toContain(password);
  });

  it('два хеша одного пароля различаются (своя соль у каждого)', async () => {
    const [a, b] = await Promise.all([
      hasher.hash(password),
      hasher.hash(password),
    ]);

    expect(a).not.toBe(b);
  });

  it('verify: true для исходного пароля, false для другого', async () => {
    const stored = await hasher.hash(password);

    await expect(hasher.verify(stored, password)).resolves.toBe(true);
    await expect(hasher.verify(stored, 'секрет13')).resolves.toBe(false);
    // Крайние пробелы значимы: «секрет12 » — другой пароль.
    await expect(hasher.verify(stored, `${password} `)).resolves.toBe(false);
  });
});
