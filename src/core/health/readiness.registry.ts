import { Injectable } from '@nestjs/common';

/**
 * Проверка готовности. Бросает исключение (или отклоняет Promise),
 * если компонент не готов обслуживать запросы.
 */
export type ReadinessCheck = () => void | Promise<void>;

/**
 * Реестр проверок готовности (readiness).
 *
 * Liveness и readiness — два разных вопроса оркестратора (Kubernetes,
 * балансировщика):
 * - liveness: «процесс жив?» Если нет, его перезапускают;
 * - readiness: «можно слать трафик?» Если нет, процесс не убивают, а просто
 *   не направляют на него запросы, пока он не будет готов.
 *
 * Готовность зависит от модулей, которых ещё нет. По спекам readiness не проходит, если:
 * - не загружен снимок RBAC (1.1);
 * - не заданы ключи JWT или HMAC (1.2);
 * - у маршрута нет декларации доступа (1.3).
 * Поэтому HealthModule не знает о них напрямую: каждый модуль сам регистрирует
 * свою проверку здесь (в `onModuleInit`). Так зависимость направлена от фичи к
 * инфраструктуре, а не наоборот.
 */
@Injectable()
export class ReadinessRegistry {
  private readonly checks = new Map<string, ReadinessCheck>();

  register(name: string, check: ReadinessCheck): void {
    this.checks.set(name, check);
  }

  entries(): [string, ReadinessCheck][] {
    return [...this.checks.entries()];
  }
}
