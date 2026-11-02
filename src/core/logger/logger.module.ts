import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ConfigModule } from '@/core/config/config.module';
import { ConfigService } from '@/core/config/config.service';
import { RequestWithId } from './request-id';

/**
 * Структурированное логирование на базе pino (через nestjs-pino).
 *
 * «Структурированное» значит, что каждая строка лога — JSON-объект с полями
 * (`level`, `time`, `reqId`, `req.method`, `res.statusCode`, `responseTime`...),
 * а не произвольный текст. Такие логи система сбора (ELK, Loki, CloudWatch)
 * может фильтровать и агрегировать: «покажи все 5xx за час по пути /auth/login».
 *
 * Что делает модуль:
 * 1. На каждый HTTP-запрос пишет одну строку access-лога: метод, путь, статус,
 *    длительность и requestId. Это требование главы 0.5.
 * 2. Подменяет стандартный Nest Logger: `new Logger(...)` в сервисах пишет
 *    через pino, и строка автоматически получает `reqId` текущего запроса
 *    (pino хранит его в AsyncLocalStorage, «контексте» асинхронного вызова).
 * 3. Вырезает секреты: cookies, Authorization, Set-Cookie. В логах не должно
 *    быть токенов. Логи читает больше людей, чем имеют доступ к БД.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isDev = config.get('NODE_ENV') === 'development';

        return {
          pinoHttp: {
            level: config.get('LOG_LEVEL') ?? 'info',

            // id уже вычислен Fastify'ем (см. request-id.ts), берём его.
            genReqId: (req: IncomingMessage) =>
              (req as RequestWithId).id ?? 'unknown',

            // Уровень строки access-лога зависит от результата:
            // 5xx — ошибка сервера (error), 4xx — ошибка клиента (warn).
            customLogLevel: (
              _req: IncomingMessage,
              res: ServerResponse,
              err?: Error,
            ) => {
              if (err || res.statusCode >= 500) return 'error';
              if (res.statusCode >= 400) return 'warn';
              return 'info';
            },

            // Логируем только безопасный минимум. Сериализатор по умолчанию
            // пишет все заголовки, а с ними и cookie с JWT. Query string тоже
            // отрезаем: в ней бывают email, токены и курсоры (глава 1.2: «не
            // логировать полный URL»).
            serializers: {
              req: (req: { id: string; method: string; url: string }) => ({
                // requestId попадает в каждую строку лога этого запроса,
                // включая логи сервисов (nestjs-pino добавляет `req` автоматически).
                requestId: req.id,
                method: req.method,
                path: req.url?.split('?')[0],
              }),
              res: (res: { statusCode: number }) => ({
                statusCode: res.statusCode,
              }),
            },

            // Вторая линия обороны: если кто-то случайно залогирует объект
            // с этими полями, pino заменит значения на "[Redacted]".
            redact: {
              paths: [
                'req.headers.cookie',
                'req.headers.authorization',
                'res.headers["set-cookie"]',
                '*.password',
                '*.token',
              ],
              censor: '[Redacted]',
            },

            // В разработке — человекочитаемый цветной вывод,
            // в production — сырой JSON (его читают машины).
            transport: isDev
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          },
        };
      },
    }),
  ],
})
export class LoggerModule {}
