import { Injectable } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';

import { Config } from './config.types';

/**
 * Обёртка над ConfigService из @nestjs/config с типизацией по интерфейсу `Config`.
 *
 * `get('SMTP_PORT')` возвращает `number`, `get('SMTP_SECURE')` — `boolean`:
 * @nestjs/config отдаёт значения уже после Joi-валидации, где строки из env
 * приведены к нужным типам.
 */
@Injectable()
export class ConfigService extends NestConfigService<Config, true> {
  get<T extends keyof Config>(key: T): Config[T] {
    return super.get(key, { infer: true });
  }
}
