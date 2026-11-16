import { Global, Module } from '@nestjs/common';

import { AuditIds } from './audit-ids';
import { AuditLogger } from './audit-logger';

/**
 * @Global — аудит нужен почти каждому фиче-модулю (регистрация, вход, RBAC,
 * удаление). Импортировать модуль в каждый из них было бы лишним шумом.
 */
@Global()
@Module({
  providers: [AuditLogger, AuditIds],
  exports: [AuditLogger, AuditIds],
})
export class AuditModule {}
