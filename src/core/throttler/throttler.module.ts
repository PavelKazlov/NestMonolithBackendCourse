import { Module } from '@nestjs/common';
import { ThrottlerModule as NestThrottlerModule } from '@nestjs/throttler';

import { ConfigModule } from '@/core/config/config.module';
import { ConfigService } from '@/core/config/config.service';
import { isRateLimitEnabled, RateLimit } from './rate-limit.decorator';

/**
 * Rate limiting (ограничение частоты запросов) на базе @nestjs/throttler.
 *
 * Как это работает: на каждый запрос guard увеличивает счётчик с ключом
 * «класс + метод контроллера + имя лимита + IP клиента» и хранит его ttl мс.
 * Если счётчик превысил limit, запрос отклоняется с 429 ещё ДО контроллера.
 * Значит, не тратятся ни CPU на хеш пароля, ни SMTP на письмо.
 *
 * Лимитов несколько, у каждого своё имя:
 * - `default` — общий «потолок» для любого маршрута, где стоит guard;
 * - `registration` — отдельный порог для `register` и `resend` (спека 1.0,
 *   раздел 1.6: «rate limit на регистрацию и повторную отправку, числовой
 *   порог регистрации задаётся в конфигурации»);
 * - `login` и `refresh` — пороги задания 1.2.
 *
 * Особенность библиотеки: ThrottlerGuard применяет КАЖДЫЙ именованный лимит
 * к КАЖДОМУ маршруту, где он стоит. Чтобы `registration` не зацепил
 * посторонние маршруты (в 1.3 guard может стать глобальным), лимит включается
 * только явно: `skipIf` пропускает его, если на обработчике нет декоратора
 * `@RateLimitOn(RateLimit.Registration)`. Это opt-in вместо opt-out.
 *
 * Хранилище счётчиков — память процесса (по умолчанию). Для нескольких
 * экземпляров приложения за балансировщиком нужно общее хранилище (Redis),
 * иначе каждый экземпляр считает свой лимит, и фактический порог умножается
 * на число экземпляров.
 */
@Module({
  imports: [
    NestThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          name: 'default',
          ttl: Number(config.get('THROTTLE_GLOBAL_TTL')),
          limit: Number(config.get('THROTTLE_GLOBAL_LIMIT')),
        },
        {
          name: RateLimit.Registration,
          ttl: Number(config.get('REGISTRATION_RATE_TTL')),
          limit: Number(config.get('REGISTRATION_RATE_LIMIT')),
          skipIf: (context) =>
            !isRateLimitEnabled(context, RateLimit.Registration),
        },
        // Спека 1.2, раздел 1.6: «POST /auth/login допускает не более 30
        // запросов с IP за минуту ... Refresh — не более 30 запросов с IP за минуту».
        // Второй лимит login (5 НЕУСПЕШНЫХ проверок на email + IP) throttler
        // выразить не может: он считает все запросы, а не только неуспешные.
        // Его считает LoginFailureLimiter (modules/auth/login).
        {
          name: RateLimit.Login,
          ttl: Number(config.get('LOGIN_RATE_TTL')),
          limit: Number(config.get('LOGIN_RATE_LIMIT')),
          skipIf: (context) => !isRateLimitEnabled(context, RateLimit.Login),
        },
        {
          name: RateLimit.Refresh,
          ttl: Number(config.get('REFRESH_RATE_TTL')),
          limit: Number(config.get('REFRESH_RATE_LIMIT')),
          skipIf: (context) => !isRateLimitEnabled(context, RateLimit.Refresh),
        },
      ],
    }),
  ],
  // NestThrottlerModule глобальный: guard (`@UseGuards(AppThrottlerGuard)`)
  // в любом модуле получит опции и хранилище счётчиков без импорта.
  exports: [NestThrottlerModule],
})
export class ThrottlerModule {}
