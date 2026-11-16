import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { catchError, Observable, throwError } from 'rxjs';

import { AuditLogger } from '@/core/audit/audit-logger';

/** Метод контроллера → событие аудита для ошибки формата запроса. */
const FAILURE_EVENTS: Record<string, string> = {
  login: 'login.failed',
  confirm: 'login.challenge.failed',
  resend: 'login.resend.failed',
};

/**
 * Аудит запросов, отклонённых валидацией (неверный email, код не из 6 цифр,
 * битый токен). До сервиса такие запросы не доходят, поэтому записать их
 * может только interceptor: ValidationPipe выполняется внутри `next.handle()`.
 * Тот же приём, что RegistrationAuditInterceptor (1.0).
 *
 * Пишем только причину, без значений полей: в них мог быть пароль.
 */
@Injectable()
export class LoginAuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditLogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const event = FAILURE_EVENTS[context.getHandler().name];
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (event && error instanceof BadRequestException) {
          this.audit.warn(event, { reason: 'validation_failed' });
        }
        return throwError(() => error);
      }),
    );
  }
}
