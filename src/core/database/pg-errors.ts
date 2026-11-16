import { QueryFailedError } from 'typeorm';

/**
 * Коды ошибок PostgreSQL (SQLSTATE), которые приложение обрабатывает явно.
 * Полный список: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export const PG_UNIQUE_VIOLATION = '23505';

/** То, что драйвер `pg` кладёт в `QueryFailedError.driverError`. */
interface PgDriverError {
  code?: string;
  constraint?: string;
}

/**
 * Это нарушение уникального ограничения (и, если указано, именно `constraint`)?
 *
 * Зачем проверять имя ограничения: у таблицы может быть несколько уникальных
 * индексов. Превращать в «email занят» нужно только конфликт по email, а
 * любой другой конфликт — это баг, и он должен стать 500 с записью в логе.
 *
 * Имена ограничений мы задаём в сущностях явно (`UQ_users_email`), а не
 * доверяем автогенерации TypeORM (`IDX_97672ac88f789774dd47f7c8be`): так имя
 * в коде и в миграции совпадает и читается.
 */
export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as PgDriverError;
  return (
    driverError.code === PG_UNIQUE_VIOLATION &&
    (constraint === undefined || driverError.constraint === constraint)
  );
}
