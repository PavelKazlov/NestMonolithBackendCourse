import { Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import { isUniqueViolation } from '@/core/database/pg-errors';
import { AuditLogger } from './audit-logger';

describe('AuditLogger', () => {
  it('пишет событие и поля через Nest Logger (а значит, через pino)', () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const audit = new AuditLogger();

    audit.info('registration.succeeded', { userId: 'u1' });
    audit.warn('registration.failed', { reason: 'email_taken' });

    expect(log).toHaveBeenCalledWith(
      { event: 'registration.succeeded', userId: 'u1' },
      'registration.succeeded',
    );
    expect(warn).toHaveBeenCalledWith(
      { event: 'registration.failed', reason: 'email_taken' },
      'registration.failed',
    );
    jest.restoreAllMocks();
  });
});

describe('isUniqueViolation', () => {
  const pgError = (code: string, constraint?: string) =>
    new QueryFailedError('SQL', [], { code, constraint } as unknown as Error);

  it('23505 по нужному ограничению → true', () => {
    expect(
      isUniqueViolation(pgError('23505', 'UQ_users_email'), 'UQ_users_email'),
    ).toBe(true);
  });

  it('23505 без указания ограничения → true', () => {
    expect(isUniqueViolation(pgError('23505', 'UQ_x'))).toBe(true);
  });

  it('другое ограничение, другой код или не QueryFailedError → false', () => {
    expect(isUniqueViolation(pgError('23505', 'UQ_x'), 'UQ_users_email')).toBe(
      false,
    );
    expect(isUniqueViolation(pgError('23503', 'UQ_users_email'))).toBe(false);
    expect(isUniqueViolation(new Error('x'))).toBe(false);
  });
});
