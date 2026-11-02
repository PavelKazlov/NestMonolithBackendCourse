import { HttpStatus } from '@nestjs/common';
import { HealthCheckService } from '@nestjs/terminus';
import { DataSource } from 'typeorm';

import { AppException } from '@/core/errors/app.exception';
import { HealthService } from './health.service';
import { ReadinessRegistry } from './readiness.registry';

/**
 * Unit-тест: сервис создаём руками с фейковыми зависимостями, без Nest и без БД.
 * Так тест быстрый и проверяет только логику самого сервиса.
 */
describe('HealthService', () => {
  let dataSource: { query: jest.Mock };
  let registry: ReadinessRegistry;
  let service: HealthService;

  beforeEach(() => {
    dataSource = { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    registry = new ReadinessRegistry();
    service = new HealthService(
      { check: jest.fn() } as unknown as HealthCheckService,
      dataSource as unknown as DataSource,
      registry,
    );
  });

  it('ready: всё up → status ok', async () => {
    registry.register('rbac', () => undefined);

    await expect(service.checkReady()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'up', rbac: 'up' },
    });
  });

  it('ready: БД недоступна → 503 not_ready', async () => {
    dataSource.query.mockRejectedValue(new Error('ECONNREFUSED'));

    const error = await service.checkReady().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getStatus()).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect((error as AppException).extra).toEqual({
      checks: { database: 'down' },
    });
  });

  it('ready: проверка модуля бросает → down', async () => {
    registry.register('jwt-keys', () => {
      throw new Error('missing key');
    });

    const error = (await service
      .checkReady()
      .catch((e: unknown) => e)) as AppException;

    expect(error.extra).toEqual({
      checks: { database: 'up', 'jwt-keys': 'down' },
    });
  });

  it('ready: зависшая проверка считается down по таймауту', async () => {
    jest.useFakeTimers();
    registry.register('slow', () => new Promise(() => undefined));

    const promise = service.checkReady().catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(2_000);
    const error = (await promise) as AppException;

    expect(error.extra).toEqual({ checks: { database: 'up', slow: 'down' } });
    jest.useRealTimers();
  });

  it('getEmptyResponse возвращает ok без деталей', () => {
    expect(service.getEmptyResponse()).toEqual({ status: 'ok', details: {} });
  });
});
