import { ModuleMetadata } from '@nestjs/common';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from '@/core/app/app.module';
import { configureApp, createFastifyAdapter } from '@/core/app/app.setup';

let transactionalContextReady = false;

/**
 * Поднимает полноценное приложение для e2e-тестов: тот же AppModule и та же
 * `configureApp`, что в `main.ts`, но без прослушивания порта. Запросы идут
 * через `app.inject()` (встроенный в Fastify «виртуальный» HTTP) или supertest.
 *
 * `override` позволяет подменить провайдеры, например отправку почты на фейк.
 */
export async function createTestApp(
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
  extra: ModuleMetadata = {},
): Promise<NestFastifyApplication> {
  if (!transactionalContextReady) {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });
    transactionalContextReady = true;
  }

  let builder = Test.createTestingModule({
    ...extra,
    imports: [AppModule, ...(extra.imports ?? [])],
  });
  if (override) builder = override(builder);
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(),
    { bufferLogs: true },
  );
  await configureApp(app);
  await app.init();
  // Fastify требует дождаться готовности плагинов перед inject().
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
