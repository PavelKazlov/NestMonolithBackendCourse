import { ConfigService } from '@/core/config/config.service';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  const healthService = {
    getEmptyResponse: jest.fn().mockReturnValue({ status: 'ok', details: {} }),
    checkHealth: jest
      .fn()
      .mockResolvedValue({ status: 'ok', details: { x: 1 } }),
    checkReady: jest.fn().mockResolvedValue({ status: 'ok', checks: {} }),
  };

  function makeController(healthCheckEnabled: boolean) {
    const config = { get: jest.fn().mockReturnValue(healthCheckEnabled) };
    return new HealthController(
      healthService as unknown as HealthService,
      config as unknown as ConfigService,
    );
  }

  it('GET /health при выключенном флаге отдаёт пустой ответ', async () => {
    await expect(makeController(false).check()).resolves.toEqual({
      status: 'ok',
      details: {},
    });
  });

  it('GET /health при включённом флаге запускает проверки', async () => {
    await expect(makeController(true).check()).resolves.toEqual({
      status: 'ok',
      details: { x: 1 },
    });
  });

  it('GET /health/live всегда ok', () => {
    expect(makeController(false).live()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready делегирует сервису', async () => {
    await makeController(false).ready();
    expect(healthService.checkReady).toHaveBeenCalled();
  });
});
