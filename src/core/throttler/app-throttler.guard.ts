import {
  ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';

import { AppException } from '@/core/errors/app.exception';

/**
 * ThrottlerGuard, который отвечает в едином формате ошибок проекта.
 *
 * Стандартный guard бросает `ThrottlerException` с текстом
 * «ThrottlerException: Too Many Requests». Наш фильтр превратил бы его в
 * `{ code: 'too_many_requests' }` без подсказки, когда можно повторить.
 * Здесь мы бросаем `AppException` с кодом `rate_limited` и полем
 * `retryAfterSeconds`. Фильтр продублирует его в стандартный заголовок
 * `Retry-After`, понятный HTTP-клиентам и прокси.
 *
 * Подключение: `@UseGuards(AppThrottlerGuard)` на контроллере.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger('Audit');

  protected throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    // timeToBlockExpire — сколько секунд осталось до снятия блокировки.
    const retryAfterSeconds = Math.max(1, Math.ceil(detail.timeToBlockExpire));

    // Аудит: отказ по частоте — тоже «неуспешная попытка» (спека 1.0, 1.5).
    // Пишем маршрут и время ожидания. IP не пишем: это персональные данные,
    // а связать запись с клиентом можно по requestId из access-лога.
    this.logger.warn(
      {
        event: 'rate_limit.exceeded',
        handler: `${context.getClass().name}.${context.getHandler().name}`,
        retryAfterSeconds,
      },
      'Rate limit exceeded',
    );

    throw new AppException(
      HttpStatus.TOO_MANY_REQUESTS,
      'rate_limited',
      'Too many requests, try again later',
      { retryAfterSeconds },
    );
  }
}
