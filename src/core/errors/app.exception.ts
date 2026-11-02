import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Бизнес-исключение приложения с машиночитаемым кодом.
 *
 * Зачем нужен `code`, если есть HTTP-статус? Статус слишком грубый. Например,
 * 401 бывает `invalid_credentials` (неверный логин или пароль) и
 * `invalid_session` (протух access-токен), и клиент реагирует на них
 * по-разному: в первом случае показывает ошибку формы, во втором запускает
 * refresh. Коды задаёт спека курса, и клиент опирается на них, а не на текст
 * `message`.
 *
 * `extra` — дополнительные безопасные поля ответа. Например, при 429 туда
 * кладётся `retryAfterSeconds`, а при 503 после сбоя SMTP — `attemptId`.
 *
 * Сервисы бросают `AppException`, а превращает его в HTTP-ответ глобальный
 * фильтр `AllExceptionsFilter`. Так сервис не знает про HTTP-ответы (глава
 * 0.3: «сервис не знает об HTTP»), только про коды результата.
 */
export class AppException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string = code,
    readonly extra: Record<string, unknown> = {},
  ) {
    super({ code, message, ...extra }, status);
  }
}
