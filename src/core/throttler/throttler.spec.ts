import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerLimitDetail, ThrottlerStorage } from '@nestjs/throttler';

import { AppException } from '@/core/errors/app.exception';
import { AppThrottlerGuard } from './app-throttler.guard';
import {
  isRateLimitEnabled,
  RateLimit,
  RateLimitOn,
} from './rate-limit.decorator';

class Controller {
  @RateLimitOn(RateLimit.Registration)
  limited(): void {}

  plain(): void {}
}

const contextFor = (method: keyof Controller) =>
  ({
    getClass: () => Controller,
    getHandler: () => Controller.prototype[method],
  }) as unknown as ExecutionContext;

describe('@RateLimitOn / isRateLimitEnabled', () => {
  it('лимит включён только на помеченном обработчике', () => {
    expect(
      isRateLimitEnabled(contextFor('limited'), RateLimit.Registration),
    ).toBe(true);
    expect(
      isRateLimitEnabled(contextFor('plain'), RateLimit.Registration),
    ).toBe(false);
  });
});

describe('AppThrottlerGuard', () => {
  /** Открываем protected-метод для теста. */
  class TestableGuard extends AppThrottlerGuard {
    exposeThrow(context: ExecutionContext, detail: ThrottlerLimitDetail) {
      return this.throwThrottlingException(context, detail);
    }
  }

  it('отказ → AppException 429 rate_limited с retryAfterSeconds', () => {
    const guard = new TestableGuard(
      [],
      {} as ThrottlerStorage,
      new Reflector(),
    );
    const detail = { timeToBlockExpire: 42 } as ThrottlerLimitDetail;

    let error: unknown;
    try {
      void guard.exposeThrow(contextFor('limited'), detail);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getStatus()).toBe(429);
    expect((error as AppException).code).toBe('rate_limited');
    expect((error as AppException).extra).toEqual({ retryAfterSeconds: 42 });
  });
});
