import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck } from '@nestjs/terminus';

import { HealthService } from './health.service';
import { ConfigService } from '@/core/config/config.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  @HealthCheck()
  async check() {
    const healthCheckEnabled = this.configService.get('HEALTH_CHECK_ENABLED');

    if (!healthCheckEnabled) {
      return this.healthService.getEmptyResponse();
    }

    return this.healthService.checkHealth();
  }

  /**
   * Liveness: процесс жив и обрабатывает HTTP. Внешние зависимости не проверяет:
   * если упала БД, перезапуск нашего процесса не поможет, а только добавит хаоса.
   */
  @Get('live')
  @ApiOperation({ summary: 'Liveness: процесс жив' })
  live() {
    return { status: 'ok' };
  }

  /**
   * Readiness: можно ли направлять на этот экземпляр трафик.
   * 200, если всё готово, иначе 503 со списком проверок.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness: готов принимать трафик' })
  ready() {
    return this.healthService.checkReady();
  }
}
