import { Injectable } from '@nestjs/common';

/**
 * Порт «что ещё сделать, когда пользователь стал active».
 *
 * Спека 1.0 (раздел 1.1): «Роль `user` назначает RBAC в той же транзакции,
 * где пользователь становится `active`». RBAC появится только в задании 1.1,
 * поэтому сейчас здесь ТОЧКА РАСШИРЕНИЯ:
 *
 * 1. `UsersService` вызывает `onActivated(userId)` ВНУТРИ своей транзакции
 *    в обоих местах, где пользователь становится active:
 *    - регистрация без подтверждения (`createActive`);
 *    - успешное подтверждение (`activate`).
 * 2. Пока подключён `NoopUserActivationHook`, который ничего не делает.
 *    Спека разрешает: «Пока модуль RBAC не подключён, регистрация роль не
 *    создаёт: уже активные пользователи получат её при первой загрузке пустой
 *    конфигурации RBAC».
 * 3. В 1.1 модуль RBAC даст свою реализацию (`INSERT INTO user_roles ...`),
 *    и в `UsersModule` поменяется только привязка провайдера:
 *      { provide: UserActivationHook, useExisting: RbacUserActivationHook }
 *
 * Почему запись роли попадёт в ту же транзакцию без передачи `EntityManager`:
 * `typeorm-transactional` хранит текущую транзакцию в AsyncLocalStorage
 * (контексте асинхронного вызова). Любой репозиторий, вызванный внутри
 * `@Transactional()`-метода, автоматически работает в этой транзакции.
 * Если вставка роли упадёт, откатится и смена статуса. Пользователь не
 * останется «active без роли».
 *
 * Это пример принципа инверсии зависимостей (DIP): модуль users объявляет,
 * ЧТО ему нужно, а модуль RBAC решает, КАК это сделать. Users не зависит от RBAC.
 */
export abstract class UserActivationHook {
  /** Вызывается в транзакции активации. Ошибка внутри откатывает активацию. */
  abstract onActivated(userId: string): Promise<void>;
}

/** Реализация по умолчанию, пока нет RBAC: ничего не делает. */
@Injectable()
export class NoopUserActivationHook extends UserActivationHook {
  onActivated(): Promise<void> {
    return Promise.resolve();
  }
}
