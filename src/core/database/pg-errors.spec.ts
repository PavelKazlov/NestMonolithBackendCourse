import { QueryFailedError } from 'typeorm';

import { describeQueryError, isDatabaseUnavailable } from './pg-errors';

const withCode = (code: string, message = 'x') =>
  Object.assign(new Error(message), { code });

const queryError = (driverError: Error) =>
  new QueryFailedError(
    'SELECT 1 WHERE email = $1',
    ['user@example.com'],
    driverError,
  );

describe('isDatabaseUnavailable', () => {
  it.each([
    ['ECONNREFUSED', withCode('ECONNREFUSED')],
    ['SQLSTATE 08006', withCode('08006')],
    ['57P01 admin_shutdown', withCode('57P01')],
    ['53300 too_many_connections', withCode('53300')],
    ['Connection terminated', new Error('Connection terminated unexpectedly')],
    ['pool timeout', new Error('timeout exceeded when trying to connect')],
    ['внутри QueryFailedError', queryError(withCode('57P03'))],
    ['в cause', new Error('wrapped', { cause: withCode('ECONNRESET') })],
  ])('%s → true', (_name, error) => {
    expect(isDatabaseUnavailable(error)).toBe(true);
  });

  it.each([
    ['unique violation', queryError(withCode('23505'))],
    ['ошибка синтаксиса uuid', withCode('22P02')],
    ['код из 4 символов на 08', withCode('0800')],
    ['обычная ошибка', new Error('boom')],
    ['не Error', 'ECONNREFUSED'],
  ])('%s → false', (_name, error) => {
    expect(isDatabaseUnavailable(error)).toBe(false);
  });

  it('циклическая цепочка cause не зацикливает проверку', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(isDatabaseUnavailable(a)).toBe(false);
  });
});

describe('describeQueryError', () => {
  it('оставляет код, ограничение и SQL, но не значения параметров', () => {
    const driverError = Object.assign(new Error('dup'), {
      code: '23505',
      constraint: 'UQ_users_email',
      detail: 'Key (email)=(user@example.com) already exists.',
    });
    const described = describeQueryError(queryError(driverError));
    expect(described).toEqual({
      type: 'QueryFailedError',
      code: '23505',
      constraint: 'UQ_users_email',
      query: 'SELECT 1 WHERE email = $1',
    });
    expect(JSON.stringify(described)).not.toContain('user@example.com');
  });
});
