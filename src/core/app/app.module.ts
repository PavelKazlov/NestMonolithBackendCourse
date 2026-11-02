import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { ConfigModule } from '@/core/config/config.module';
import { DatabaseModule } from '@/core/database/database.module';
import { HealthModule } from '@/core/health/health.module';
import { LoggerModule } from '@/core/logger/logger.module';
import { ThrottlerModule } from '@/core/throttler/throttler.module';

/**
 *
 * Application modules
 *
 */
import { UsersModule } from '@/modules/users/users.module';

/**
 * Корневой модуль. Собирает инфраструктуру (core) и фиче-модули (modules).
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    DatabaseModule,
    HealthModule,
    ThrottlerModule,
    // Планировщик фоновых задач (@Cron, @Interval). Понадобится для воркеров:
    // удаление пользователей (1.6), очистка хранилища (1.5), сохранение и
    // retention результатов трансформаций (2.3, 2.4).
    ScheduleModule.forRoot(),
    /**
     *
     * Application modules
     *
     */
    UsersModule,
  ],
})
export class AppModule {}
