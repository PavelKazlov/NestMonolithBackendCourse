import { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';

import { AuditLogger } from '@/core/audit/audit-logger';
import { AppException } from '@/core/errors/app.exception';
import { TokenKind } from '@/modules/auth/tokens/token.constants';
import { TokenVerificationError } from '@/modules/auth/tokens/token-verification.error';
import { TokenService } from '@/modules/auth/tokens/token.service';
import { UserStatus } from '@/modules/users/user.entity';
import { UsersService } from '@/modules/users/users.service';
import { AccessGuard } from './access.guard';
import { CurrentUserId } from './current-user.decorator';
import { SessionService } from './session.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('SessionService', () => {
  const tokens = { verify: jest.fn(), issuePair: jest.fn() };
  const users = { findAuthState: jest.fn() };
  const audit = { warn: jest.fn(), info: jest.fn() };
  const service = new SessionService(
    tokens as unknown as TokenService,
    users as unknown as UsersService,
    audit as unknown as AuditLogger,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    tokens.verify.mockReturnValue({ userId: USER_ID });
    users.findAuthState.mockResolvedValue({
      id: USER_ID,
      status: UserStatus.Active,
    });
  });

  /** Ожидаем 401 invalid_session. */
  const expectInvalidSession = async (promise: Promise<unknown>) => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getStatus()).toBe(401);
    expect((error as AppException).code).toBe('invalid_session');
  };

  it('active-пользователь с валидным токеном → userId', async () => {
    await expect(service.authenticate('t', TokenKind.Access)).resolves.toBe(
      USER_ID,
    );
    expect(tokens.verify).toHaveBeenCalledWith('t', TokenKind.Access);
  });

  it('отказ проверки JWT → 401, категория в аудит', async () => {
    tokens.verify.mockImplementation(() => {
      throw new TokenVerificationError('expired');
    });
    await expectInvalidSession(service.authenticate('t', TokenKind.Access));
    expect(audit.warn).toHaveBeenCalledWith('access.denied', {
      reason: 'expired',
      userId: undefined,
    });
  });

  it.each([
    null,
    ...[
      UserStatus.Pending,
      UserStatus.Blocked,
      UserStatus.Deleting,
      UserStatus.Deleted,
    ].map((status) => ({ id: USER_ID, status })),
  ])('пользователь %p → 401 user_inactive', async (user) => {
    users.findAuthState.mockResolvedValue(user);
    await expectInvalidSession(service.authenticate('t', TokenKind.Refresh));
    expect(audit.warn).toHaveBeenCalledWith('refresh.failed', {
      reason: 'user_inactive',
      userId: USER_ID,
    });
  });

  it('ошибка БД не превращается в 401', async () => {
    const dbDown = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    users.findAuthState.mockRejectedValue(dbDown);
    await expect(service.authenticate('t', TokenKind.Access)).rejects.toBe(
      dbDown,
    );
  });

  it('неожиданная ошибка verify пробрасывается как есть', async () => {
    const bug = new Error('bug');
    tokens.verify.mockImplementation(() => {
      throw bug;
    });
    await expect(service.authenticate('t', TokenKind.Access)).rejects.toBe(bug);
  });

  it('refresh: проверка refresh-токена и новая пара', async () => {
    tokens.issuePair.mockReturnValue({ accessToken: 'A', refreshToken: 'R' });
    await expect(service.refresh('r')).resolves.toEqual({
      accessToken: 'A',
      refreshToken: 'R',
    });
    expect(tokens.verify).toHaveBeenCalledWith('r', TokenKind.Refresh);
    expect(audit.info).toHaveBeenCalledWith('refresh.succeeded', {
      userId: USER_ID,
    });
  });

  it('tryIdentify: userId или undefined, без исключений', () => {
    expect(service.tryIdentify('t')).toBe(USER_ID);
    tokens.verify.mockImplementation(() => {
      throw new TokenVerificationError('missing');
    });
    expect(service.tryIdentify(undefined)).toBeUndefined();
  });
});

describe('AccessGuard', () => {
  it('берёт access из cookie и кладёт userId в request.auth', async () => {
    const sessions = { authenticate: jest.fn().mockResolvedValue(USER_ID) };
    const request: Record<string, unknown> = {
      cookies: { access_token: 'A', refresh_token: 'R' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(
      new AccessGuard(sessions as unknown as SessionService).canActivate(
        context,
      ),
    ).resolves.toBe(true);
    expect(sessions.authenticate).toHaveBeenCalledWith('A', TokenKind.Access);
    expect(request.auth).toEqual({ userId: USER_ID });
  });
});

describe('@CurrentUserId', () => {
  /** Достаём фабрику param-декоратора так же, как это делает Nest. */
  function factory(): (data: unknown, ctx: ExecutionContext) => string {
    class Target {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      handler(@CurrentUserId() _userId: string): void {}
    }
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      Target,
      'handler',
    ) as Record<
      string,
      { factory: (data: unknown, ctx: ExecutionContext) => string }
    >;
    return Object.values(args)[0].factory;
  }
  const contextWith = (request: object) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;

  it('возвращает userId из request.auth', () => {
    expect(
      factory()(undefined, contextWith({ auth: { userId: USER_ID } })),
    ).toBe(USER_ID);
  });

  it('без AccessGuard — ошибка программиста', () => {
    expect(() => factory()(undefined, contextWith({}))).toThrow(
      /without AccessGuard/,
    );
  });
});
