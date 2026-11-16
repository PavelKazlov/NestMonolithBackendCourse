import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

import { Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppException } from './app.exception';

/** Фейковые request/reply Fastify, достаточные для фильтра. */
function makeHost() {
  const reply = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    header: jest.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => ({ id: 'req-1' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, reply };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('AppException → свой статус, code и extra', () => {
    const { host, reply } = makeHost();

    filter.catch(
      new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        'resend_too_early',
        'Wait',
        {
          retryAfterSeconds: 42,
        },
      ),
      host,
    );

    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith({
      code: 'resend_too_early',
      message: 'Wait',
      retryAfterSeconds: 42,
      requestId: 'req-1',
    });
    // retryAfterSeconds дублируется в стандартный заголовок.
    expect(reply.header).toHaveBeenCalledWith('Retry-After', '42');
  });

  it('без retryAfterSeconds заголовок Retry-After не ставится', () => {
    const { host, reply } = makeHost();

    filter.catch(new NotFoundException(), host);

    expect(reply.header).not.toHaveBeenCalled();
  });

  it('ошибка ValidationPipe → validation_failed с details', () => {
    const { host, reply } = makeHost();

    filter.catch(new BadRequestException(['email must be an email']), host);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      code: 'validation_failed',
      message: 'Request validation failed',
      details: ['email must be an email'],
      requestId: 'req-1',
    });
  });

  it('стандартный HttpException → код по статусу', () => {
    const { host, reply } = makeHost();

    filter.catch(new NotFoundException(), host);

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'not_found', requestId: 'req-1' }),
    );
  });

  it('5xx HttpException не раскрывает свой текст', () => {
    const { host, reply } = makeHost();

    filter.catch(
      new InternalServerErrorException('db password is wrong'),
      host,
    );

    expect(reply.send).toHaveBeenCalledWith({
      code: 'internal_error',
      message: 'Service error',
      requestId: 'req-1',
    });
  });

  it('неизвестная ошибка → 500 internal_error без деталей', () => {
    const { host, reply } = makeHost();

    filter.catch(new TypeError('cannot read x of undefined'), host);

    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({
      code: 'internal_error',
      message: 'Internal server error',
      requestId: 'req-1',
    });
  });
});

describe('AllExceptionsFilter: база данных (1.2)', () => {
  const filter = new AllExceptionsFilter();

  afterEach(() => jest.restoreAllMocks());

  it('недоступная БД → 503 service_unavailable, а не 500', () => {
    const { host, reply } = makeHost();

    filter.catch(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), {
        code: 'ECONNREFUSED',
      }),
      host,
    );

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({
      code: 'service_unavailable',
      message: 'Service temporarily unavailable',
      requestId: 'req-1',
    });
  });

  it('ошибка SQL пишется в лог без значений параметров', () => {
    const { host } = makeHost();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    filter.catch(
      new QueryFailedError(
        'SELECT * FROM users WHERE email = $1',
        ['secret@example.com'],
        Object.assign(new Error('boom'), { code: '42P01' }),
      ),
      host,
    );

    const logged = JSON.stringify(error.mock.calls[0][0]);
    expect(logged).toContain('42P01');
    expect(logged).not.toContain('secret@example.com');
  });
});

describe('AllExceptionsFilter: коды по умолчанию', () => {
  const filter = new AllExceptionsFilter();

  it.each([
    [400, 'bad_request'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [405, 'method_not_allowed'],
    [409, 'conflict'],
    [413, 'payload_too_large'],
    [415, 'unsupported_media_type'],
    [429, 'too_many_requests'],
    [503, 'service_unavailable'],
    [504, 'timeout'],
    [502, 'internal_error'],
    [418, 'error'],
  ])('статус %i → code %s', (status, code) => {
    const { host, reply } = makeHost();

    filter.catch(new HttpException('x', status), host);

    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ code }));
  });
});
