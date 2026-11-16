import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { catchError, Observable, throwError } from 'rxjs';

import { AuditLogger } from '@/core/audit/audit-logger';

/** Имя метода контроллера → событие аудита для неуспеха. */
const FAILURE_EVENTS: Record<string, string> = {
  register: 'registration.failed',
  confirm: 'registration.confirmation.failed',
  resend: 'registration.resend.failed',
};

/**
 * Аудит неуспешных попыток, которые НЕ доходят до сервиса: невалидный email,
 * слабый пароль, неверный формат кода.
 *
 * Почему interceptor. Порядок конвейера Nest:
 *   guards → interceptors (до) → pipes → обработчик → interceptors (после)
 * ValidationPipe работает ВНУТРИ `next.handle()`, поэтому его исключение
 * проходит через `catchError` этого interceptor'а. Сервис его не видит:
 * до сервиса запрос просто не дошёл.
 *
 * Бизнес-неуспехи (409, 400 неверный код, 429, 503) аудирует сам сервис:
 * там есть контекст (userId, attemptId, причина). Здесь только валидация.
 *
 * В журнал пишем только причину. Ни значений полей, ни текстов ошибок:
 * в тексте могло бы оказаться имя лишнего поля, которое прислал клиент.
 */
@Injectable()
export class RegistrationAuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditLogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const event = FAILURE_EVENTS[context.getHandler().name];

    return next.handle().pipe(
      catchError((error: unknown) => {
        // AppException тоже наследует HttpException, но не BadRequestException,
        // поэтому сюда попадают только ошибки ValidationPipe и toConfirmationInput.
        if (event && error instanceof BadRequestException) {
          this.audit.warn(event, { reason: 'validation_failed' });
        }
        // Пробрасываем ошибку дальше без изменений: ответ сформирует фильтр.
        return throwError(() => error);
      }),
    );
  }
}
