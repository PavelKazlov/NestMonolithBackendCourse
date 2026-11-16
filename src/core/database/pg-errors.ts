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
 * Классы и коды SQLSTATE, которые значат «база недоступна», а не «запрос неверен»:
 * - `08xxx` — connection exception (соединение не установлено или оборвалось);
 * - `57P01` / `57P02` / `57P03` — сервер выключается или ещё не готов принимать;
 * - `53300` — too_many_connections (исчерпан лимит соединений).
 */
const PG_UNAVAILABLE_CODES = new Set(['57P01', '57P02', '57P03', '53300']);

/** Сетевые коды Node.js: до сервера БД не достучались вовсе. */
const NETWORK_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'EPIPE',
]);

/** Тексты ошибок пула `pg`, у которых нет кода. */
const UNAVAILABLE_MESSAGES = [
  'Connection terminated',
  'timeout exceeded when trying to connect',
];

/**
 * Ошибка означает недоступность БД (спека 1.2: «если база недоступна, вернуть
 * 503, а не 401»)?
 *
 * Почему это важно для аутентификации. Если бы любая ошибка БД при проверке
 * токена превращалась в 401 `invalid_session`, клиент решил бы, что сессия
 * кончилась, и выкинул бы пользователя на форму входа. А сессия в порядке,
 * просто база на секунду перезапустилась. 503 говорит «повторите позже»,
 * и клиент не теряет сессию.
 *
 * Ошибку проверяем на нескольких уровнях: сама ошибка, `driverError` внутри
 * `QueryFailedError` и `cause`. Драйвер и TypeORM заворачивают исходную
 * ошибку по-разному в зависимости от того, где она случилась: при взятии
 * соединения из пула или во время запроса.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (code.startsWith('08') && code.length === 5) return true;
      if (PG_UNAVAILABLE_CODES.has(code)) return true;
      if (NETWORK_UNAVAILABLE_CODES.has(code)) return true;
    }
    if (
      UNAVAILABLE_MESSAGES.some(
        (text) => current instanceof Error && current.message.includes(text),
      )
    ) {
      return true;
    }
    current =
      current instanceof QueryFailedError
        ? (current.driverError as unknown)
        : (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Безопасное для лога описание ошибки запроса.
 *
 * `QueryFailedError` хранит `parameters` — значения, подставленные в запрос.
 * Для входа это email, для регистрации ещё и хеш пароля. А `driverError.detail`
 * у PostgreSQL выглядит как `Key (email)=(user@example.com) already exists`.
 * Если отдать такую ошибку логгеру целиком, email и хеш окажутся в журнале
 * (спека 1.2, раздел 1.5: «в журнал не попадают email ... хеш пароля»).
 * Поэтому оставляем только код SQLSTATE, имя ограничения и текст SQL
 * с плейсхолдерами `$1`, без значений.
 */
export function describeQueryError(
  error: QueryFailedError,
): Record<string, string | undefined> {
  const driverError = error.driverError as PgDriverError;
  return {
    type: 'QueryFailedError',
    code: driverError.code,
    constraint: driverError.constraint,
    query: error.query,
  };
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
