import type { IncomingMessage } from 'node:http';

import { RequestWithId, resolveRequestId } from './request-id';

function req(header?: string): IncomingMessage {
  return {
    headers: header === undefined ? {} : { 'x-request-id': header },
  } as IncomingMessage;
}

describe('resolveRequestId', () => {
  it('генерирует UUID, если заголовка нет, и кладёт его на запрос', () => {
    const r = req();
    const id = resolveRequestId(r);

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((r as RequestWithId).id).toBe(id);
  });

  it('принимает безопасный входящий id', () => {
    expect(resolveRequestId(req('abc-123_x.y'))).toBe('abc-123_x.y');
  });

  it.each([
    ['перевод строки', 'abc\ninjected'],
    ['пробелы', 'a b'],
    ['слишком длинный', 'a'.repeat(129)],
    ['пустой', ''],
  ])('отклоняет небезопасный id: %s', (_case, value) => {
    expect(resolveRequestId(req(value))).not.toBe(value);
  });
});
