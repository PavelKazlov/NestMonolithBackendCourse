import { config } from 'dotenv';
import { resolve } from 'node:path';

/**
 * Выполняется Jest'ом перед каждым e2e-файлом (`setupFiles` в jest-e2e.json).
 *
 * Загружаем `.env.test` в `process.env` с `override: true`. @nestjs/config отдаёт
 * переменным из process.env приоритет над файлом `.env`, поэтому тесты пойдут
 * в тестовую БД `app_test`, а не в базу разработки.
 */
config({
  path: resolve(__dirname, '../.env.test'),
  override: true,
  quiet: true,
});
