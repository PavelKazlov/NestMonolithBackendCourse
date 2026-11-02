import compression from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';

import { ConfigService } from '@/core/config/config.service';
import { AllExceptionsFilter } from '@/core/errors/all-exceptions.filter';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/core/logger/request-id';

/**
 * HTTP-адаптер Fastify с нашей генерацией requestId.
 * Вынесен в функцию, потому что его создают и `main.ts`, и e2e-тесты.
 */
export function createFastifyAdapter(): FastifyAdapter {
  return new FastifyAdapter({
    genReqId: resolveRequestId,
    // Логи пишет pino через nestjs-pino. Встроенный логгер Fastify выключен,
    // иначе каждый запрос попадал бы в лог дважды.
    logger: false,
  });
}

/**
 * Вся «обвязка» приложения в одном месте. Вызывается из `main.ts` и из
 * e2e-тестов, поэтому тесты проверяют ровно ту конфигурацию, что работает в проде.
 *
 * Порядок важен и соответствует главе 0.5 «Middleware»:
 * requestId → логирование → CORS / security-заголовки → (позже) аутентификация →
 * авторизация → валидация → обработчик. Ошибки на любом шаге ловит фильтр.
 */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  const config = app.get(ConfigService);
  const swaggerEnabled = config.get('SWAGGER_ENABLED') === true;

  // Логгер Nest → pino. После этого `new Logger()` в любом классе пишет JSON-логи.
  app.useLogger(app.get(Logger));

  // Каждому ответу, включая 404 и ошибки, ставим X-Request-Id.
  // Хук `onRequest` Fastify срабатывает раньше маршрутизации, поэтому заголовок
  // получат даже несуществующие маршруты.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, reply, done) => {
      void reply.header(REQUEST_ID_HEADER, request.id);
      done();
    });

  // Security-заголовки (helmet): X-Content-Type-Options: nosniff,
  // X-Frame-Options, Strict-Transport-Security и т.д. Защищают в основном
  // браузерных клиентов от MIME-sniffing, clickjacking и downgrade на HTTP.
  // CSP выключаем, только когда включён Swagger UI: его страница грузит
  // inline-скрипты, а строгая CSP их заблокирует. JSON-ответам API CSP не нужна.
  await app.register(helmet, {
    contentSecurityPolicy: swaggerEnabled ? false : undefined,
  });

  await app.register(compression);

  // CORS: какие чужие origin (фронтенды) браузер пустит к нашему API.
  // Wildcard `*` с credentials запрещён и браузером, и спекой 1.2.
  // Список origin перенесём в конфиг на шаге 1.2.
  app.enableCors({
    origin: [
      'http://localhost:5174',
      'http://localhost:4200',
      'http://localhost:8080',
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  await app.register(fastifyCookie, {
    secret: config.get('COOKIE_SECRET'),
  });

  // Глобальная валидация входных DTO (class-validator):
  // - whitelist: поля без декораторов валидации выбрасываются из объекта;
  // - forbidNonWhitelisted: если клиент прислал лишнее поле, ответ 400, а не
  //   молчаливое игнорирование. Спека требует отклонять неизвестные поля
  //   (1.5 PATCH, 1.7 query, 2.x multipart), а молчаливое удаление скрывает
  //   ошибки клиента вроде опечатки `displayname` вместо `displayName`;
  // - transform: строки из query и path превращаются в типы DTO (number, boolean).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  if (swaggerEnabled) {
    setupSwagger(app);
  }
}

/**
 * OpenAPI-документация: UI на /docs, JSON-схема на /docs-json.
 * Схема собирается из декораторов контроллеров и DTO (@ApiProperty, @ApiResponse...).
 * Авторизация описана как cookie `access_token`: так её передаёт клиент (глава 1.2).
 */
function setupSwagger(app: NestFastifyApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Backend Course API')
      .setDescription(
        'Монолитное HTTP API: пользователи, RBAC, трансформации файлов',
      )
      .setVersion('1.0')
      .addCookieAuth('access_token')
      .build(),
  );
  SwaggerModule.setup('docs', app, document);
}
