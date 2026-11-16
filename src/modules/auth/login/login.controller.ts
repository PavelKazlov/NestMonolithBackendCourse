import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppThrottlerGuard } from '@/core/throttler/app-throttler.guard';
import { RateLimit, RateLimitOn } from '@/core/throttler/rate-limit.decorator';
import { ErrorResponse } from '@/modules/auth/registration/dto/registration-responses.dto';
import { AuthCookies } from '@/modules/auth/tokens/auth-cookies';
import {
  ConfirmLoginDto,
  toLoginConfirmationInput,
} from './dto/confirm-login.dto';
import { LoginDto } from './dto/login.dto';
import {
  LoginChallengeResponse,
  LoginResendResponse,
} from './dto/login-responses.dto';
import { ResendLoginDto } from './dto/resend-login.dto';
import { LoginAuditInterceptor } from './login-audit.interceptor';
import { LoginService } from './login.service';

/**
 * HTTP-слой входа (спека 1.2, разделы 1.3.1–1.3.2). Тонкий контроллер:
 * DTO → сервис → статус ответа и cookies.
 *
 * Токены уходят клиенту ТОЛЬКО в `Set-Cookie` с HttpOnly, никогда в теле.
 * Тело успешного входа пустое (204 No Content).
 */
@ApiTags('auth: login')
@Controller('auth/login')
// Rate limit в guard: срабатывает до pipes и обработчика, отклонённый
// запрос не тратит CPU на Argon2.
@UseGuards(AppThrottlerGuard)
@UseInterceptors(LoginAuditInterceptor)
export class LoginController {
  constructor(
    private readonly logins: LoginService,
    private readonly cookies: AuthCookies,
  ) {}

  @Post()
  @RateLimitOn(RateLimit.Login)
  @ApiOperation({
    summary: 'Вход по email и паролю',
    description:
      'Без подтверждения → 204 и две Set-Cookie. С подтверждением → 202, ' +
      'код или ссылка уходят на почту (способ выбирает сервер). ' +
      'Для другого доверенного origin нужен заголовок X-CSRF-Protection: 1.',
  })
  @ApiNoContentResponse({
    description: 'Set-Cookie: access_token и refresh_token',
  })
  @ApiAcceptedResponse({ type: LoginChallengeResponse })
  @ApiBadRequestResponse({
    type: ErrorResponse,
    description: 'validation_failed',
  })
  @ApiUnauthorizedResponse({
    type: ErrorResponse,
    description: 'invalid_credentials',
  })
  @ApiForbiddenResponse({ type: ErrorResponse, description: 'csrf_rejected' })
  @ApiTooManyRequestsResponse({
    type: ErrorResponse,
    description: 'rate_limited | resend_too_soon',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorResponse,
    description:
      'service_unavailable | mail_delivery_failed | token_signing_failed',
  })
  async login(
    @Body() dto: LoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginChallengeResponse | void> {
    // IP — второй компонент ключа лимита неуспехов. За обратным прокси
    // Fastify нужно настроить `trustProxy`, иначе здесь будет IP прокси.
    const result = await this.logins.login(dto, request.ip);

    if (result.kind === 'session') {
      // Обе подписи уже выполнены сервисом. Теперь cookies одним ответом.
      this.cookies.set(reply, result.tokens);
      reply.status(HttpStatus.NO_CONTENT);
      return;
    }
    // 202 Accepted: пароль верный, но вход ещё не завершён.
    reply.status(HttpStatus.ACCEPTED);
    return LoginChallengeResponse.from(result.challenge);
  }

  @Post('confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Подтверждение входа: { attemptId, code } или { token }',
    description:
      'Magic link подтверждается только этим POST. Открытие ссылки (GET) ' +
      'показывает страницу и ничего не меняет.',
  })
  @ApiNoContentResponse({
    description: 'Set-Cookie: access_token и refresh_token',
  })
  @ApiBadRequestResponse({
    type: ErrorResponse,
    description: 'validation_failed | confirmation_invalid',
  })
  @ApiUnauthorizedResponse({
    type: ErrorResponse,
    description: 'invalid_credentials',
  })
  @ApiForbiddenResponse({ type: ErrorResponse, description: 'csrf_rejected' })
  @ApiTooManyRequestsResponse({
    type: ErrorResponse,
    description: 'attempts_exhausted',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorResponse,
    description: 'service_unavailable | token_signing_failed',
  })
  async confirm(
    @Body() dto: ConfirmLoginDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const { tokens } = await this.logins.confirm(toLoginConfirmationInput(dto));
    this.cookies.set(reply, tokens);
  }

  @Post('resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Новый код или ссылка для попытки (не чаще раза в 60 с)',
  })
  @ApiAcceptedResponse({ type: LoginResendResponse })
  @ApiBadRequestResponse({
    type: ErrorResponse,
    description: 'validation_failed | confirmation_invalid',
  })
  @ApiUnauthorizedResponse({
    type: ErrorResponse,
    description: 'invalid_credentials',
  })
  @ApiForbiddenResponse({ type: ErrorResponse, description: 'csrf_rejected' })
  @ApiTooManyRequestsResponse({
    type: ErrorResponse,
    description: 'resend_too_soon | attempts_exhausted',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorResponse,
    description: 'mail_delivery_failed',
  })
  async resend(@Body() dto: ResendLoginDto): Promise<LoginResendResponse> {
    const challenge = await this.logins.resend(dto.attemptId.toLowerCase());
    return LoginResendResponse.from(challenge);
  }
}
