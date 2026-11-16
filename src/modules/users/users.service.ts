import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import { isUniqueViolation } from '@/core/database/pg-errors';
import { AppException } from '@/core/errors/app.exception';
import { UserActivationHook } from './user-activation.hook';
import { User, USERS_EMAIL_UNIQUE, UserStatus } from './user.entity';

/** Ошибка «email уже зарегистрирован» (спека 1.0, раздел 1.4: 409). */
export function emailTakenError(): AppException {
  return new AppException(
    HttpStatus.CONFLICT,
    'email_taken',
    'Email is already registered',
  );
}

/**
 * Бизнес-операции над пользователями.
 *
 * Слой service: знает правила («активировать можно только pending»), но не
 * знает про HTTP (статусы задаёт через AppException) и не строит SQL руками
 * без нужды. Работа с таблицей идёт через репозиторий TypeORM.
 */
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly activationHook: UserActivationHook,
  ) {}

  /** Поиск по уже нормализованному email. */
  findByEmail(email: string): Promise<User | null> {
    return this.users.findOneBy({ email });
  }

  /**
   * Регистрация без подтверждения: сразу `active`.
   *
   * `@Transactional()` открывает транзакцию (или присоединяется к уже
   * открытой). INSERT пользователя и назначение роли (хук) либо оба
   * зафиксируются, либо оба откатятся.
   */
  @Transactional()
  async createActive(email: string, passwordHash: string): Promise<User> {
    const user = await this.insert(email, passwordHash, UserStatus.Active);
    await this.activationHook.onActivated(user.id);
    return user;
  }

  /**
   * Регистрация с подтверждением: `pending`, без роли.
   * Вызывается внутри транзакции регистрации вместе с созданием попытки.
   */
  createPending(email: string, passwordHash: string): Promise<User> {
    return this.insert(email, passwordHash, UserStatus.Pending);
  }

  /**
   * Перевод `pending → active` после подтверждения email.
   *
   * Условие `status = 'pending'` в самом UPDATE делает операцию идемпотентной:
   * повторный вызов ничего не изменит, и хук (назначение роли) не сработает
   * второй раз. Спека: «назначить роль `user`, если ... роль ещё не назначена».
   */
  @Transactional()
  async activate(userId: string): Promise<User> {
    const result = await this.users.update(
      { id: userId, status: UserStatus.Pending },
      { status: UserStatus.Active },
    );
    if (result.affected) {
      await this.activationHook.onActivated(userId);
    }
    return this.users.findOneByOrFail({ id: userId });
  }

  /**
   * INSERT с переводом конфликта уникального индекса в 409.
   *
   * Даже если сервис регистрации заранее проверил, что email свободен,
   * параллельный запрос мог успеть занять его между проверкой и вставкой.
   * Тогда PostgreSQL вернёт ошибку 23505 по индексу `UQ_users_email`. Спека
   * требует, чтобы это был «обычный 409», а не необработанный 500.
   */
  private async insert(
    email: string,
    passwordHash: string,
    status: UserStatus,
  ): Promise<User> {
    const user = this.users.create({
      id: randomUUID(),
      email,
      passwordHash,
      status,
    });
    try {
      // insert, а не save: save сначала делает SELECT, чтобы решить, INSERT
      // это или UPDATE. Нам точно нужна вставка. После insert TypeORM
      // дописывает в объект сгенерированные БД поля (created_at, updated_at).
      await this.users.insert(user);
    } catch (error: unknown) {
      if (isUniqueViolation(error, USERS_EMAIL_UNIQUE)) {
        throw emailTakenError();
      }
      throw error;
    }
    return user;
  }
}
