import { Global, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { ReadinessRegistry } from './readiness.registry';

/**
 * @Global — чтобы любой фиче-модуль мог внедрить ReadinessRegistry и
 * зарегистрировать свою проверку, не импортируя HealthModule явно.
 */
@Global()
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [HealthService, ReadinessRegistry],
  exports: [ReadinessRegistry],
})
export class HealthModule {}
