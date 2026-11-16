import { ExecutionContext } from '@nestjs/common';

import { AuditLogger } from '@/core/audit/audit-logger';
import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import { CsrfGuard } from './csrf.guard';

const config = {
  get: (key: string) =>
    key === 'APP_ORIGIN'
      ? 'https://api.example.com'
      : ['https://app.example.com'],
} as unknown as ConfigService;

function contextFor(method: string, headers: Record<string, string> = {}) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        headers,
        routeOptions: { url: '/auth/login' },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('CsrfGuard', () => {
  const audit = { warn: jest.fn() };
  const guard = new CsrfGuard(config, audit as unknown as AuditLogger);

  /** Пропущен ли запрос (true) или отклонён с 403 csrf_rejected (false). */
  const allowed = (method: string, headers: Record<string, string> = {}) => {
    try {
      return guard.canActivate(contextFor(method, headers));
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).getStatus()).toBe(403);
      expect((error as AppException).code).toBe('csrf_rejected');
      return false;
    }
  };

  beforeEach(() => audit.warn.mockClear());

  it('безопасные методы не проверяются', () => {
    expect(allowed('GET', { origin: 'https://evil.example' })).toBe(true);
    expect(allowed('HEAD', { origin: 'https://evil.example' })).toBe(true);
  });

  it('без Origin (не браузер) — пропуск', () => {
    expect(allowed('POST')).toBe(true);
  });

  it('свой origin (same-origin) — пропуск без заголовка', () => {
    expect(allowed('POST', { origin: 'https://api.example.com' })).toBe(true);
  });

  it('доверенный origin с X-CSRF-Protection: 1 — пропуск', () => {
    expect(
      allowed('PATCH', {
        origin: 'https://app.example.com',
        'x-csrf-protection': '1',
      }),
    ).toBe(true);
  });

  it('доверенный origin без заголовка или с другим значением — 403', () => {
    expect(allowed('POST', { origin: 'https://app.example.com' })).toBe(false);
    expect(
      allowed('DELETE', {
        origin: 'https://app.example.com',
        'x-csrf-protection': 'true',
      }),
    ).toBe(false);
    expect(audit.warn).toHaveBeenCalledWith('csrf.rejected', {
      reason: 'missing_csrf_header',
      method: 'POST',
      route: '/auth/login',
    });
  });

  it('чужой origin, соседний поддомен и Origin: null — 403 даже с заголовком', () => {
    for (const origin of [
      'https://evil.example',
      'https://evil.example.com',
      'https://app.example.com:8443',
      'null',
    ]) {
      expect(allowed('POST', { origin, 'x-csrf-protection': '1' })).toBe(false);
    }
    expect(audit.warn).toHaveBeenLastCalledWith(
      'csrf.rejected',
      expect.objectContaining({ reason: 'untrusted_origin' }),
    );
  });
});
