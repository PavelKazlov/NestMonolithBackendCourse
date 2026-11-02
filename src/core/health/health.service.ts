import { HttpStatus, Injectable } from '@nestjs/common';
import { HealthCheckService, HealthCheckResult } from '@nestjs/terminus';
import { DataSource } from 'typeorm';

import { AppException } from '@/core/errors/app.exception';
import { ReadinessRegistry } from './readiness.registry';

/** Сколько ждём одну проверку, прежде чем считать её проваленной. */
const CHECK_TIMEOUT_MS = 2_000;

export type CheckStatus = 'up' | 'down';

@Injectable()
export class HealthService {
  constructor(
    private readonly healthCheckService: HealthCheckService,
    private readonly dataSource: DataSource,
    private readonly registry: ReadinessRegistry,
  ) {}

  getEmptyResponse(): HealthCheckResult {
    return {
      status: 'ok',
      details: {},
    };
  }

  checkHealth() {
    return this.healthCheckService.check([]);
  }

  /**
   * Readiness: БД отвечает, и все зарегистрированные модулями проверки прошли.
   * В ответе только имя проверки и `up`/`down`, без текстов ошибок: эндпоинт
   * может быть виден снаружи, а причину сбоя ищут в логах.
   */
  async checkReady(): Promise<{
    status: 'ok';
    checks: Record<string, CheckStatus>;
  }> {
    const all: [string, () => unknown][] = [
      ['database', () => this.dataSource.query('SELECT 1')],
      ...this.registry.entries(),
    ];

    // Проверки независимы, поэтому запускаем их параллельно.
    const results = await Promise.all(
      all.map(async ([name, check]): Promise<[string, CheckStatus]> => {
        try {
          await withTimeout(Promise.resolve(check()), CHECK_TIMEOUT_MS);
          return [name, 'up'];
        } catch {
          return [name, 'down'];
        }
      }),
    );

    const checks = Object.fromEntries(results);
    if (results.some(([, status]) => status === 'down')) {
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'not_ready',
        'Service is not ready',
        { checks },
      );
    }
    return { status: 'ok', checks };
  }
}

/** Отклоняет промис, если он не завершился за `ms` миллисекунд. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
