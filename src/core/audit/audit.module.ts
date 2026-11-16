import { Global, Module } from '@nestjs/common';

import { AuditLogger } from './audit-logger';

/**
 * @Global — аудит нужен почти каждому фиче-модулю (регистрация, вход, RBAC,
 * удаление). Импортировать модуль в каждый из них было бы лишним шумом.
 */
@Global()
@Module({
  providers: [AuditLogger],
  exports: [AuditLogger],
})
export class AuditModule {}
