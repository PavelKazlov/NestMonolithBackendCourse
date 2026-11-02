import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from '@/core/app/app.module';
import { configureApp, createFastifyAdapter } from '@/core/app/app.setup';
import { ConfigService } from '@/core/config/config.service';

/**
 * Точка входа. Создаёт Nest-приложение поверх Fastify, настраивает его
 * (см. `configureApp`) и начинает слушать порт.
 */
async function bootstrap() {
  // typeorm-transactional хранит «текущую транзакцию» в AsyncLocalStorage.
  // Инициализировать нужно до создания любых DataSource.
  initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createFastifyAdapter(),
    // Буферизуем логи старта, пока не подключён pino-логгер, чтобы и они
    // вышли в едином JSON-формате.
    { bufferLogs: true },
  );

  await configureApp(app);

  // Корректное завершение: по SIGTERM (так останавливает контейнер Docker или k8s)
  // Nest вызовет onModuleDestroy и закроет соединения с БД, а не оборвёт их.
  app.enableShutdownHooks();

  const port = app.get(ConfigService).get('PORT');
  // 0.0.0.0 — слушать все интерфейсы. Это нужно, чтобы приложение было
  // доступно снаружи Docker-контейнера. Fastify по умолчанию слушает только localhost.
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
