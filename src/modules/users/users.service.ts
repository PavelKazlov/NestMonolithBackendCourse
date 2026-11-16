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
   * Пользователь для проверки пароля при входе (1.2): `id`, `status` и
   * `password_hash`.
   *
   * Колонка `password_hash` помечена `select: false` и обычными `find*()`
   * не загружается. Здесь она нужна, поэтому запрашиваем её явно через
   * `addSelect`. Это единственное место в коде, где хеш читается из БД.
   * Поиск идёт по уникальному индексу `UQ_users_email` (спека 1.6:
   * «индексы покрывают поиск по нормализованному email»).
   */
  findForLogin(
    email: string,
  ): Promise<Pick<User, 'id' | 'status' | 'passwordHash'> | null> {
    return this.users
      .createQueryBuilder('user')
      .select(['user.id', 'user.status'])
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email })
      .getOne();
  }

  /**
   * Состояние пользователя для проверки access и refresh (1.2, раздел 1.3.6):
   * «получить пользователя по `sub`, выбрав только `id` и `status`».
   *
   * Только две колонки, а не вся строка: запрос выполняется на КАЖДОМ
   * защищённом запросе, и лишние данные (email, хеш) там не нужны. Меньше
   * данных — меньше шанс, что они куда-то утекут.
   */
  findAuthState(id: string): Promise<Pick<User, 'id' | 'status'> | null> {
    return this.users.findOne({
      select: { id: true, status: true },
      where: { id },
    });
  }

  /**
   * `id`, `status` и `email` с блокировкой строки (`SELECT ... FOR UPDATE`).
   * Email нужен resend, чтобы отправить письмо. Вызывается
   * ТОЛЬКО внутри транзакции (иначе блокировка снимется сразу же).
   *
   * Зачем блокировать пользователя при работе с попыткой входа (1.2, шаги 7
   * login и 1 confirm/resend): параллельная транзакция, которая блокирует
   * или удаляет пользователя, будет ждать, пока мы не закончим. Значит,
   * прочитанный здесь статус `active` не устареет до COMMIT, и мы не выдадим
   * токены или письмо пользователю, которого в этот момент заблокировали.
   *
   * Порядок блокировок во всех операциях один: сначала пользователь, потом
   * попытка. Если бы одна транзакция брала их в порядке A→B, а другая B→A,
   * они могли бы ждать друг друга вечно (deadlock).
   */
  lockForAuth(
    id: string,
  ): Promise<Pick<User, 'id' | 'status' | 'email'> | null> {
    return this.users.findOne({
      select: { id: true, status: true, email: true },
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
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
