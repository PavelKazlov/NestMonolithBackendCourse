import jwt from 'jsonwebtoken';

import { AuditLogger } from '@/core/audit/audit-logger';
import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import { ReadinessRegistry } from '@/core/health/readiness.registry';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  TokenKind,
} from './token.constants';
import { TokenVerificationError } from './token-verification.error';
import { TokenService } from './token.service';

const ENV: Record<string, string> = {
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'r'.repeat(40),
  JWT_ISSUER: 'course-api',
  JWT_AUDIENCE: 'course-web',
};
const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000;

/** Подписать произвольный payload ключом access (для «подделок»). */
function forge(
  payload: object,
  key = ENV.JWT_ACCESS_SECRET,
  options: jwt.SignOptions = { algorithm: 'HS256' },
) {
  // Без iat в payload библиотека добавила бы его сама; noTimestamp это отключает.
  const noTimestamp = typeof payload === 'object' && !('iat' in payload);
  return jwt.sign(payload, key, { ...options, noTimestamp });
}

/** Корректные claims; значение `undefined` в overrides удаляет claim. */
const validClaims = (overrides: Record<string, unknown> = {}) => {
  const claims: Record<string, unknown> = {
    sub: USER_ID,
    iss: ENV.JWT_ISSUER,
    aud: ENV.JWT_AUDIENCE,
    iat: NOW,
    exp: NOW + 900,
    token_use: 'access',
    ...overrides,
  };
  for (const key of Object.keys(claims)) {
    if (claims[key] === undefined) delete claims[key];
  }
  return claims;
};

describe('TokenService', () => {
  const audit = { warn: jest.fn(), info: jest.fn() };
  const registry = new ReadinessRegistry();
  const service = new TokenService(
    { get: (key: string) => ENV[key] } as unknown as ConfigService,
    audit as unknown as AuditLogger,
    registry,
  );

  /** Категория отказа (или null, если токен принят). */
  const categoryOf = (token: string | undefined, kind = TokenKind.Access) => {
    try {
      service.verify(token, kind, NOW);
      return null;
    } catch (error) {
      return (error as TokenVerificationError).category;
    }
  };

  it('выпускает пару с claims и сроками из спеки', () => {
    const { accessToken, refreshToken } = service.issuePair(USER_ID, NOW);
    const access = jwt.decode(accessToken, { complete: true })!;
    const refresh = jwt.decode(refreshToken) as jwt.JwtPayload;

    expect(access.header).toMatchObject({ alg: 'HS256' });
    expect(access.payload).toEqual({
      sub: USER_ID,
      iss: 'course-api',
      aud: 'course-web',
      iat: NOW,
      exp: NOW + ACCESS_TOKEN_TTL_SECONDS,
      token_use: 'access',
    });
    expect(refresh.exp! - refresh.iat!).toBe(REFRESH_TOKEN_TTL_SECONDS);
    expect(refresh.token_use).toBe('refresh');
    // Ни ролей, ни email, ни jti.
    expect(Object.keys(refresh).sort()).toEqual(
      ['aud', 'exp', 'iat', 'iss', 'sub', 'token_use'].sort(),
    );
  });

  it('verify принимает свой токен и возвращает userId', () => {
    const { accessToken, refreshToken } = service.issuePair(USER_ID, NOW);
    expect(service.verify(accessToken, TokenKind.Access, NOW)).toEqual({
      userId: USER_ID,
    });
    expect(service.verify(refreshToken, TokenKind.Refresh, NOW)).toEqual({
      userId: USER_ID,
    });
  });

  it('refresh вместо access и наоборот → signature (другой ключ)', () => {
    const { accessToken, refreshToken } = service.issuePair(USER_ID, NOW);
    expect(categoryOf(refreshToken, TokenKind.Access)).toBe('signature');
    expect(categoryOf(accessToken, TokenKind.Refresh)).toBe('signature');
  });

  it('верная подпись, но чужой token_use → token_use', () => {
    expect(categoryOf(forge(validClaims({ token_use: 'refresh' })))).toBe(
      'token_use',
    );
    expect(categoryOf(forge(validClaims({ token_use: undefined })))).toBe(
      'token_use',
    );
  });

  it.each([
    ['нет токена', undefined, 'missing'],
    ['пустая строка', '', 'missing'],
    ['мусор', 'not-a-jwt', 'malformed'],
    // У строки нет aud: библиотека отклонит её ещё на проверке audience.
    [
      'payload — строка',
      jwt.sign('just-a-string', ENV.JWT_ACCESS_SECRET),
      'claims',
    ],
  ])('%s → %s', (_name, token, category) => {
    expect(categoryOf(token)).toBe(category);
  });

  it('подпись чужим ключом → signature', () => {
    expect(categoryOf(forge(validClaims(), 'x'.repeat(40)))).toBe('signature');
  });

  it('alg: none и другой алгоритм отклоняются', () => {
    const none = forge(validClaims(), '', { algorithm: 'none' });
    const hs512 = forge(validClaims(), ENV.JWT_ACCESS_SECRET, {
      algorithm: 'HS512',
    });
    expect(categoryOf(none)).toBe('signature');
    expect(categoryOf(hs512)).toBe('signature');
  });

  it('истёкший токен → expired; в пределах 30 с допуска → принят', () => {
    expect(categoryOf(forge(validClaims({ exp: NOW - 31 })))).toBe('expired');
    expect(categoryOf(forge(validClaims({ exp: NOW - 29 })))).toBeNull();
  });

  it.each([
    ['чужой iss', { iss: 'evil' }],
    ['чужой aud', { aud: 'evil' }],
    ['iat из будущего дальше 30 с', { iat: NOW + 31 }],
    ['нет iat', { iat: undefined }],
    ['нет exp', { exp: undefined }],
    ['sub не UUID', { sub: 'user-42' }],
    ['пустой sub', { sub: '' }],
    ['nbf в будущем', { nbf: NOW + 3600 }],
  ])('%s → claims', (_name, overrides) => {
    expect(categoryOf(forge(validClaims(overrides)))).toBe('claims');
  });

  it('сбой подписи → 503 token_signing_failed без утечки ошибки', () => {
    const spy = jest.spyOn(jwt, 'sign').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    let error: unknown;
    try {
      service.issuePair(USER_ID, NOW);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getStatus()).toBe(503);
    expect((error as AppException).code).toBe('token_signing_failed');
    expect(audit.warn).toHaveBeenCalledWith('token.signing_failed', {
      userId: USER_ID,
    });
    spy.mockRestore();
  });

  it('readiness: проверка подписывает и проверяет пробную пару', async () => {
    service.onModuleInit();
    const [[name, check]] = registry.entries();
    expect(name).toBe('auth-tokens');
    await expect(Promise.resolve(check())).resolves.toBeUndefined();
  });
});

describe('TokenVerificationError', () => {
  it('хранит категорию', () => {
    const error = new TokenVerificationError('expired');
    expect(error.category).toBe('expired');
    expect(error.name).toBe('TokenVerificationError');
  });
});
