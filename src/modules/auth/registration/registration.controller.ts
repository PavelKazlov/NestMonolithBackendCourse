import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { AppThrottlerGuard } from '@/core/throttler/app-throttler.guard';
import { RateLimit, RateLimitOn } from '@/core/throttler/rate-limit.decorator';
import {
  ConfirmRegistrationDto,
  toConfirmationInput,
} from './dto/confirm-registration.dto';
import { RegisterDto } from './dto/register.dto';
import {
  ConfirmationRequiredResponse,
  ErrorResponse,
  RegisteredUserResponse,
} from './dto/registration-responses.dto';
import { ResendRegistrationDto } from './dto/resend-registration.dto';
import { RegistrationAuditInterceptor } from './registration-audit.interceptor';
import { RegistrationService } from './registration.service';

/**
 * HTTP-слой регистрации. Контроллер «тонкий»: принять DTO, вызвать сервис,
 * выбрать статус ответа и форму тела. Вся логика — в RegistrationService.
 *
 * Все три операции публичные: их вызывает гость без сессии.
 * Декларация доступа маршрутов (`@Public()`) появится в задании 1.3.
 */
@ApiTags('auth: registration')
@Controller('auth/register')
// Rate limit. Guard проверяет лимиты ДО pipes и обработчика: отклонённый
// запрос не тратит ни CPU на Argon2, ни SMTP на письмо.
@UseGuards(AppThrottlerGuard)
@UseInterceptors(RegistrationAuditInterceptor)
export class RegistrationController {
  constructor(private readonly registration: RegistrationService) {}

  @Post()
  @RateLimitOn(RateLimit.Registration)
  @ApiOperation({
    summary: 'Регистрация по email и паролю',
    description:
      'Без подтверждения → 201 и активный пользователь. С подтверждением → 202, ' +
      'код или ссылка уходят на почту. Способ выбирает сервер.',
  })
  @ApiCreatedResponse({ type: RegisteredUserResponse })
  @ApiAcceptedResponse({ type: ConfirmationRequiredResponse })
  @ApiBadRequestResponse({
    type: ErrorResponse,
    description: 'validation_failed',
  })
  @ApiConflictResponse({ type: ErrorResponse, description: 'email_taken' })
  @ApiTooManyRequestsResponse({
    type: ErrorResponse,
    description: 'rate_limited',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorResponse,
    description:
      'mail_delivery_failed: pending и попытка сохранены, нужен resend',
  })
  async register(
    @Body() dto: RegisterDto,
    // passthrough: true — мы только меняем статус, а тело Nest сериализует сам.
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RegisteredUserResponse | ConfirmationRequiredResponse> {
    const result = await this.registration.register(dto);

    if (result.kind === 'active') {
      // 201 Created: ресурс (пользователь) создан и готов к использованию.
      reply.status(HttpStatus.CREATED);
      return RegisteredUserResponse.from(result.user);
    }
    // 202 Accepted: запрос принят, но процесс не завершён — ждём подтверждения.
    reply.status(HttpStatus.ACCEPTED);
    return ConfirmationRequiredResponse.from(result.challenge);
  }

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Подтверждение email кодом (attemptId + code) или токеном ссылки',
    description:
      'Активация — только через POST. Открытие ссылки (GET) статус не меняет: ' +
      'почтовые сканеры открывают ссылки сами и израсходовали бы токен.',
  })
  @ApiOkResponse({ type: RegisteredUserResponse })
  @ApiBadRequestResponse({
    type: ErrorResponse,
    description:
      'validation_failed | confirmation_invalid | confirmation_expired',
  })
  @ApiTooManyRequestsResponse({
    type: ErrorResponse,
    description: 'attempts_exhausted | rate_limited',
  })
  async confirm(
    @Body() dto: ConfirmRegistrationDto,
  ): Promise<RegisteredUserResponse> {
    const user = await this.registration.confirm(toConfirmationInput(dto));
    return RegisteredUserResponse.from(user);
  }

  @Post('resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimitOn(RateLimit.Registration)
  @ApiOperation({
    summary: 'Повторная отправка кода или ссылки (не чаще раза в 60 с)',
  })
  @ApiAcceptedResponse({ type: ConfirmationRequiredResponse })
  @ApiBadRequestResponse({
    type: ErrorResponse,
    description: 'validation_failed | confirmation_invalid',
  })
  @ApiTooManyRequestsResponse({
    type: ErrorResponse,
    description: 'resend_too_soon | rate_limited',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorResponse,
    description: 'mail_delivery_failed',
  })
  async resend(
    @Body() dto: ResendRegistrationDto,
  ): Promise<ConfirmationRequiredResponse> {
    const challenge = await this.registration.resend(dto.email);
    return ConfirmationRequiredResponse.from(challenge);
  }
}
