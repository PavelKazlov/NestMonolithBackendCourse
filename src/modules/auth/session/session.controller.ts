import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AuditLogger } from '@/core/audit/audit-logger';
import { AppThrottlerGuard } from '@/core/throttler/app-throttler.guard';
import { RateLimit, RateLimitOn } from '@/core/throttler/rate-limit.decorator';
import { ErrorResponse } from '@/modules/auth/registration/dto/registration-responses.dto';
import { AuthCookies } from '@/modules/auth/tokens/auth-cookies';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
} from '@/modules/auth/tokens/token.constants';
import { SessionService } from './session.service';

/**
 * Обновление пары токенов и выход (спека 1.2, разделы 1.3.4 и 1.3.5).
 *
 * Оба маршрута — POST: они меняют состояние клиента (cookies). GET не должен
 * этого делать (спека: «GET не выполняет вход, refresh, logout»): GET-ссылку
 * можно подсунуть в `<img src>` на чужой странице, и браузер выполнит её сам.
 */
@ApiTags('auth: session')
@Controller('auth')
@UseGuards(AppThrottlerGuard)
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly cookies: AuthCookies,
    private readonly audit: AuditLogger,
  ) {}

  @Post('refresh')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimitOn(RateLimit.Refresh)
  @ApiCookieAuth('refresh_token')
  @ApiOperation({
    summary: 'Новая пара токенов по refresh-cookie',
    description:
      'Refresh берётся только из cookie `refresh_token` (Path=/auth/refresh). ' +
      'Тело, query и заголовок Authorization игнорируются. Прежний refresh ' +
      'остаётся действующим до своего exp (stateless-схема).',
  })
  @ApiNoContentResponse({ description: 'Две Set-Cookie: новая пара' })
  @ApiUnauthorizedResponse({
    type: ErrorResponse,
    description: 'invalid_session',
  })
  @ApiForbiddenResponse({ type: ErrorResponse, description: 'csrf_rejected' })
  @ApiTooManyRequestsResponse({
    type: ErrorResponse,
    description: 'rate_limited',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorResponse,
    description: 'service_unavailable | token_signing_failed',
  })
  async refresh(
    @Req() request: FastifyRequest,
    // passthrough: Nest сам завершит ответ (204), а мы только добавим cookies.
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    // Только cookie. Значение из тела, query или другого заголовка не
    // принимаем (спека, шаг 1): иначе refresh пришлось бы хранить там, где
    // его видит JavaScript, и HttpOnly потерял бы смысл.
    const pair = await this.sessions.refresh(request.cookies?.[REFRESH_COOKIE]);
    this.cookies.set(reply, pair);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Выход: очистить обе auth-cookies',
    description:
      'Всегда 204, даже без cookies или с невалидными. Токен НЕ отзывается: ' +
      'скопированный refresh остаётся действующим до своего exp.',
  })
  @ApiNoContentResponse({ description: 'Две Set-Cookie с Max-Age=0' })
  @ApiForbiddenResponse({ type: ErrorResponse, description: 'csrf_rejected' })
  logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): void {
    // Идемпотентно: не требует ни access, ни refresh (спека, раздел 1.3.5).
    // Повторный logout даёт тот же результат, что и первый.
    this.cookies.clear(reply);
    this.audit.info('logout', {
      userId: this.sessions.tryIdentify(request.cookies?.[ACCESS_COOKIE]),
    });
  }
}
