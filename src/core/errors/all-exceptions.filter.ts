import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppException } from './app.exception';

/**
 * Единый безопасный формат ошибки для ВСЕХ ответов API:
 *
 *   { "code": "not_found", "message": "Not Found", "requestId": "…", ...extra }
 *
 * Exception filter — это «последний рубеж» в конвейере Nest. Любое исключение,
 * которое вылетело из guard, pipe, контроллера или сервиса и никем не поймано,
 * попадает сюда. Мы превращаем его в HTTP-ответ.
 *
 * Главное правило безопасности (глава 0.5): клиент никогда не видит stack trace,
 * текст SQL-ошибки или сообщение сторонней библиотеки. По ним злоумышленник
 * узнаёт версии, структуру таблиц и пути к файлам. Неожиданная ошибка (не
 * HttpException) отдаётся как безликий 500 `internal_error`, а подробности
 * пишутся в лог сервера с тем же requestId, чтобы их можно было найти.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();

    const { status, body } = this.toResponse(exception);

    if (status >= 500) {
      // Для 5xx пишем исключение целиком: стек нужен разработчику, но только в логе.
      this.logger.error(
        { err: exception, code: body.code },
        'Request failed with server error',
      );
    }

    void reply.status(status).send({ ...body, requestId: request.id });
  }

  private toResponse(exception: unknown): {
    status: number;
    body: Record<string, unknown> & { code: string; message: string };
  } {
    // 1. Наши бизнес-исключения: тело уже собрано в безопасном формате.
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        body: {
          code: exception.code,
          message: exception.message,
          ...exception.extra,
        },
      };
    }

    // 2. Стандартные исключения Nest: NotFoundException, ForbiddenException,
    //    ошибки ValidationPipe (BadRequestException со списком нарушений)...
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const body: Record<string, unknown> & { code: string; message: string } =
        {
          code: defaultCodeFor(status),
          // Текст 5xx-исключения может прийти из чужого кода и содержать
          // внутренние детали, поэтому для 5xx отдаём только общий текст.
          message: status >= 500 ? 'Service error' : exception.message,
        };

      // ValidationPipe кладёт массив сообщений class-validator в `message`
      // («email must be an email»). Эти тексты формируем мы сами из DTO,
      // поэтому отдавать их клиенту безопасно, и они помогают исправить запрос.
      if (
        typeof response === 'object' &&
        response !== null &&
        Array.isArray((response as { message?: unknown }).message)
      ) {
        body.code = 'validation_failed';
        body.message = 'Request validation failed';
        body.details = (response as { message: string[] }).message;
      }

      return { status, body };
    }

    // 3. Всё остальное: баг, упавшая БД, исключение библиотеки. Наружу не отдаём ничего.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: 'internal_error', message: 'Internal server error' },
    };
  }
}

/** Код по умолчанию для стандартных HTTP-исключений, у которых нет своего `code`. */
function defaultCodeFor(status: number): string {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 405:
      return 'method_not_allowed';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 429:
      return 'too_many_requests';
    case 503:
      return 'service_unavailable';
    case 504:
      return 'timeout';
    default:
      return status >= 500 ? 'internal_error' : 'error';
  }
}
