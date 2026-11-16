import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Стадии жизни аккаунта.
 * - `pending` — зарегистрирован, но email ещё не подтверждён. Почта уже занята
 *   (повторная регистрация даст 409), а войти ещё нельзя (проверит модуль 1.2).
 * - `active` — подтверждён или зарегистрирован без подтверждения.
 *
 * В 1.6 (удаление) сюда, вероятно, добавятся новые стадии. Для PostgreSQL enum
 * это `ALTER TYPE ... ADD VALUE`, его сгенерирует миграция.
 */
export enum UserStatus {
  Pending = 'pending',
  Active = 'active',
}

/** Имя уникального индекса по email. Нужно, чтобы распознать конфликт (см. pg-errors.ts). */
export const USERS_EMAIL_UNIQUE = 'UQ_users_email';

/**
 * Таблица `users` (спека 1.0, «Модель»).
 *
 * TypeORM-сущность — это описание таблицы на TypeScript. По ней:
 * - `migration:generate` строит SQL миграции (сравнивает сущности со схемой БД);
 * - репозиторий превращает строки БД в объекты этого класса и обратно.
 *
 * Имена колонок в БД задаём явно в snake_case (`password_hash`), а в коде
 * используем camelCase (`passwordHash`). Это общепринятые соглашения обоих миров.
 */
@Entity('users')
// Уникальный индекс — единственная НАДЁЖНАЯ защита от дубликатов email.
// Проверка «SELECT ... WHERE email = ?» перед INSERT не спасает от гонки:
// два параллельных запроса оба увидят «email свободен» и оба вставят строку.
// Уникальный индекс пропустит только первую вставку, вторая получит ошибку 23505.
@Index(USERS_EMAIL_UNIQUE, ['email'], { unique: true })
export class User {
  /**
   * UUID генерирует приложение (`randomUUID()`), а не БД.
   * Так не нужно расширение `uuid-ossp`, и id известен ещё до INSERT.
   * UUID, а не автоинкремент: по `id=42` легко перебирать соседние аккаунты
   * и оценить, сколько всего пользователей. UUID не угадывается.
   */
  @PrimaryColumn('uuid', { primaryKeyConstraintName: 'PK_users' })
  id!: string;

  /**
   * Нормализованный email: без крайних пробелов, в нижнем регистре.
   * Нормализует DTO до того, как значение попадает сюда, поэтому
   * `User@Example.com` и `user@example.com` — одна запись в индексе.
   * 254 — максимальная длина адреса по RFC 5321.
   */
  @Column({ type: 'varchar', length: 254 })
  email!: string;

  /**
   * Строка Argon2id вида `$argon2id$v=19$m=19456,t=2,p=1$<соль>$<хеш>`.
   * Соль и параметры уже внутри строки, отдельная колонка для соли не нужна.
   *
   * `select: false` — колонка НЕ загружается обычными `find*()`. Хеш нужен
   * только при входе (1.2), и там его запросят явно (`addSelect`). Так хеш
   * не утечёт в ответ API или в лог, если кто-то вернёт сущность целиком.
   */
  @Column({
    name: 'password_hash',
    type: 'varchar',
    length: 255,
    select: false,
  })
  passwordHash!: string;

  /**
   * `enumName` задаёт имя типа в PostgreSQL (`CREATE TYPE user_status AS ENUM`).
   * Без него TypeORM придумает имя `users_status_enum`.
   */
  @Column({ type: 'enum', enum: UserStatus, enumName: 'user_status' })
  status!: UserStatus;

  /** timestamptz — время с часовым поясом. Хранится в UTC, сравнения корректны. */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
