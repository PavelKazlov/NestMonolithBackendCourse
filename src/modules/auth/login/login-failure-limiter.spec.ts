import { LoginFailureLimiter } from './login-failure-limiter';

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

describe('LoginFailureLimiter', () => {
  it('пять неуспехов за 15 минут блокируют пару до конца окна', () => {
    const limiter = new LoginFailureLimiter();
    for (let i = 0; i < 4; i++) limiter.recordFailure('k', T0 + i * MINUTE);
    expect(limiter.check('k', T0 + 4 * MINUTE)).toBeNull();

    limiter.recordFailure('k', T0 + 4 * MINUTE);
    // Окно открыла первая ошибка в T0, закроется в T0 + 15 мин.
    expect(limiter.check('k', T0 + 5 * MINUTE)).toBe(10 * 60);
    expect(limiter.check('k', T0 + 15 * MINUTE - 500)).toBe(1);
    expect(limiter.check('k', T0 + 15 * MINUTE)).toBeNull();
  });

  it('после окна счёт начинается заново', () => {
    const limiter = new LoginFailureLimiter();
    for (let i = 0; i < 5; i++) limiter.recordFailure('k', T0);
    limiter.recordFailure('k', T0 + 16 * MINUTE);
    expect(limiter.check('k', T0 + 16 * MINUTE)).toBeNull();
  });

  it('ключи независимы: другой IP той же почты не заблокирован', () => {
    const limiter = new LoginFailureLimiter();
    for (let i = 0; i < 5; i++) limiter.recordFailure('mail|1.1.1.1', T0);
    expect(limiter.check('mail|1.1.1.1', T0)).not.toBeNull();
    expect(limiter.check('mail|2.2.2.2', T0)).toBeNull();
  });

  it('prune удаляет закрытые окна', () => {
    const limiter = new LoginFailureLimiter();
    limiter.recordFailure('old', T0);
    limiter.recordFailure('fresh', T0 + 10 * MINUTE);
    limiter.prune(T0 + 16 * MINUTE);
    expect(limiter.size).toBe(1);
    // Значения по умолчанию (Date.now) тоже работают.
    limiter.prune();
    expect(limiter.check('x')).toBeNull();
  });
});
