import { QueryFailedError, Repository } from 'typeorm';

import { AppException } from '@/core/errors/app.exception';
import { UserActivationHook } from './user-activation.hook';
import { User, UserStatus } from './user.entity';
import { UsersService } from './users.service';

// В unit-тесте нет БД и транзакционного контекста. Декоратор @Transactional
// превращаем в «ничего не делающий», чтобы проверить чистую логику метода.
// Настоящую транзакцию проверяют e2e-тесты.
jest.mock('typeorm-transactional', () => ({
  Transactional: () => () => undefined,
}));

/** Ошибка pg, как её отдаёт TypeORM при нарушении уникального индекса. */
function uniqueViolation(constraint: string): QueryFailedError {
  return new QueryFailedError('INSERT ...', [], {
    code: '23505',
    constraint,
  } as unknown as Error);
}

describe('UsersService', () => {
  // Мок репозитория: только методы, которые вызывает сервис.
  let repo: Record<
    'findOneBy' | 'create' | 'insert' | 'update' | 'findOneByOrFail',
    jest.Mock
  >;
  let hook: jest.Mocked<UserActivationHook>;
  let service: UsersService;

  beforeEach(() => {
    repo = {
      findOneBy: jest.fn(),
      create: jest.fn((data) => data as User),
      insert: jest.fn().mockResolvedValue({}),
      update: jest.fn(),
      findOneByOrFail: jest.fn(),
    };
    hook = { onActivated: jest.fn().mockResolvedValue(undefined) };
    service = new UsersService(repo as unknown as Repository<User>, hook);
  });

  it('findByEmail ищет по email', async () => {
    await service.findByEmail('a@b.co');

    expect(repo.findOneBy).toHaveBeenCalledWith({ email: 'a@b.co' });
  });

  it('createActive вставляет active и вызывает хук активации', async () => {
    const user = await service.createActive('a@b.co', 'hash');

    expect(user).toMatchObject({
      email: 'a@b.co',
      passwordHash: 'hash',
      status: UserStatus.Active,
    });
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(hook.onActivated).toHaveBeenCalledWith(user.id);
  });

  it('createPending не вызывает хук (роль не назначается до подтверждения)', async () => {
    const user = await service.createPending('a@b.co', 'hash');

    expect(user.status).toBe(UserStatus.Pending);
    expect(hook.onActivated).not.toHaveBeenCalled();
  });

  it('конфликт UQ_users_email → 409 email_taken', async () => {
    repo.insert.mockRejectedValue(uniqueViolation('UQ_users_email'));

    await expect(service.createPending('a@b.co', 'hash')).rejects.toMatchObject(
      { code: 'email_taken', status: 409 },
    );
  });

  it('другая ошибка БД пробрасывается как есть (станет 500)', async () => {
    const other = uniqueViolation('UQ_something_else');
    repo.insert.mockRejectedValue(other);

    await expect(service.createPending('a@b.co', 'hash')).rejects.toBe(other);
    await expect(
      service.createPending('a@b.co', 'hash'),
    ).rejects.not.toBeInstanceOf(AppException);
  });

  it('activate: pending → active, хук вызывается', async () => {
    repo.update.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });
    repo.findOneByOrFail.mockResolvedValue({ id: 'u1' } as User);

    await expect(service.activate('u1')).resolves.toEqual({ id: 'u1' });
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'u1', status: UserStatus.Pending },
      { status: UserStatus.Active },
    );
    expect(hook.onActivated).toHaveBeenCalledWith('u1');
  });

  it('activate уже активного: хук второй раз не вызывается', async () => {
    repo.update.mockResolvedValue({ affected: 0, raw: [], generatedMaps: [] });
    repo.findOneByOrFail.mockResolvedValue({ id: 'u1' } as User);

    await service.activate('u1');

    expect(hook.onActivated).not.toHaveBeenCalled();
  });
});
