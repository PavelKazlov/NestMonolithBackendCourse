/**
 * Результат аутентификации, который AccessGuard кладёт в запрос.
 *
 * Только `userId`. Ролей тут нет и не будет (спека 1.2: «Аутентификация
 * передаёт RBAC только проверенный userId»). Права RBAC (1.1) читает из
 * своих таблиц на каждом запросе, поэтому снятие роли действует сразу,
 * а не через 15 минут, когда истечёт access.
 */
export interface AuthContext {
  userId: string;
}

/**
 * Расширение типа запроса Fastify (declaration merging): TypeScript будет
 * знать о поле `request.auth` во всём проекте.
 */
declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}
