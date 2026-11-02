import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Request ID (correlation ID) — уникальный идентификатор одного HTTP-запроса.
 *
 * Зачем: все строки лога, которые написал один запрос, помечены одним `requestId`.
 * Пользователь присылает в поддержку значение заголовка `X-Request-Id`, а мы по
 * нему находим в логах всё, что происходило именно с этим запросом.
 *
 * Если запрос пришёл через прокси или другой сервис, у него может уже быть
 * `X-Request-Id`. Тогда мы его переиспользуем, и цепочка вызовов связывается
 * одним id. Но клиенту нельзя доверять слепо: в заголовок можно положить
 * переводы строк или мегабайт текста и «отравить» логи (log injection).
 * Поэтому чужой id принимаем, только если он короткий и состоит из безопасных
 * символов. Иначе генерируем свой.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Запрос, к которому мы «приклеили» id (поле `id` использует и pino-http). */
export type RequestWithId = IncomingMessage & { id?: string };

/**
 * Возвращает id запроса: входящий `X-Request-Id`, если он безопасен, иначе новый UUID.
 * Fastify вызывает эту функцию один раз на запрос (опция `genReqId` адаптера).
 */
export function resolveRequestId(req: IncomingMessage): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming)
      ? incoming
      : randomUUID();

  // Кладём id на «сырой» Node-запрос. Fastify хранит свой `request.id` в обёртке,
  // а pino-http (логгер) и Nest-middleware видят только сырой запрос.
  // Так у логгера, фильтра ошибок и заголовка ответа будет один и тот же id.
  (req as RequestWithId).id = id;
  return id;
}
