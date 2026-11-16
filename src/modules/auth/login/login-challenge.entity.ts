import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { ConfirmationMethod } from '@/modules/auth/registration/registration-challenge.entity';
import { User } from '@/modules/users/user.entity';
import {
  LOGIN_CHALLENGE_TTL_SECONDS,
  LOGIN_MAX_OTP_ATTEMPTS,
} from './login.constants';

/**
 * Почему попытка погашена (спека 1.2, «Модель»):
 * - `confirmed` — вход подтверждён, выданы cookies;
 * - `replaced` — новый login после паузы создал новую попытку;
 * - `attempts_exhausted` — пятый неверный OTP;
 * - `user_inactive` — пользователь перестал быть `active`.
 */
export enum LoginChallengeConsumedReason {
  Confirmed = 'confirmed',
  Replaced = 'replaced',
  AttemptsExhausted = 'attempts_exhausted',
  UserInactive = 'user_inactive',
}

/** Имя частичного уникального индекса «одна открытая попытка на пользователя». */
export const LOGIN_CHALLENGES_OPEN_USER_UNIQUE =
  'UQ_login_challenges_open_user';

/**
 * Таблица `login_challenges` — попытка подтверждения входа через email
 * (спека 1.2, «Модель»). Это единственная таблица, которую добавляет
 * аутентификация: таблицы refresh-сессий нет.
 *
 * Отличия от `registration_challenges` (1.0):
 * - строк на пользователя может быть много (история), но НЕпогашенная — одна.
 *   Новый login гасит прежнюю попытку (`replaced`) и создаёт новую;
 * - нет колонки `expires_at`. Срок считается как `last_sent_at + 10 минут`.
 *   Так требует раздел «Нормальная форма»: хранимое `expires_at`, всегда
 *   равное `last_sent_at + 10 мин`, — это зависимость неключевого поля от
 *   другого неключевого поля. Она нарушает 3NF/BCNF и грозит аномалией
 *   обновления (обновили одно поле, забыли другое);
 * - причина погашения хранится явно (`consumed_reason`), а не угадывается
 *   по счётчику.
 */
@Entity('login_challenges')
// Бизнес-правило «не больше одной непогашенной попытки на пользователя»
// в виде ЧАСТИЧНОГО уникального индекса: уникальность действует только среди
// строк с `consumed_at IS NULL`. Погашенных строк у пользователя может быть
// сколько угодно. Индекс же ускоряет поиск открытой попытки по `user_id`
// (спека 1.6: «индексы покрывают ... единственную непогашенную попытку»).
@Index(LOGIN_CHALLENGES_OPEN_USER_UNIQUE, ['userId'], {
  unique: true,
  where: '"consumed_at" IS NULL',
})
// Обычный индекс по `user_id` для внешнего ключа. Без него
// `DELETE FROM users` (ON DELETE CASCADE) просматривал бы всю таблицу
// попыток, чтобы найти строки этого пользователя.
@Index('IDX_login_challenges_user_id', ['userId'])
@Check(
  'CHK_login_challenges_attempts',
  `"attempts" >= 0 AND "attempts" <= ${LOGIN_MAX_OTP_ATTEMPTS}`,
)
// Время и причина погашения появляются только вместе. БД не даст записать
// «погашена, но непонятно почему» или «есть причина, но не погашена».
@Check(
  'CHK_login_challenges_consumed',
  `("consumed_at" IS NULL) = ("consumed_reason" IS NULL)`,
)
// Исчерпанная попытка — это ровно 5 неверных вводов. По этому инварианту
// confirm и resend отличают 429 (исчерпана) от 400 (погашена иначе).
@Check(
  'CHK_login_challenges_exhausted',
  `"consumed_reason" IS DISTINCT FROM 'attempts_exhausted' OR "attempts" = ${LOGIN_MAX_OTP_ATTEMPTS}`,
)
export class LoginChallenge {
  /**
   * Идентификатор попытки: `attemptId` в API и первая часть токена magic link.
   * Генерирует приложение ДО вставки, потому что id входит в данные HMAC.
   */
  @PrimaryColumn('uuid', { primaryKeyConstraintName: 'PK_login_challenges' })
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /** FK на `users.id`. Удалили пользователя — его попытки удалятся тоже. */
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_login_challenges_user_id',
  })
  user?: User;

  /**
   * Способ, выбранный СЕРВЕРОМ в момент создания. Смена настройки не меняет
   * уже созданную попытку (спека 1.2, раздел 1.1): её можно подтвердить и
   * отправить повторно тем же способом.
   */
  @Column({
    type: 'enum',
    enum: ConfirmationMethod,
    enumName: 'login_challenge_method',
  })
  method!: ConfirmationMethod;

  /** HMAC-SHA256 от кода или случайного секрета ссылки (32 байта). */
  @Column({ name: 'secret_hash', type: 'bytea' })
  secretHash!: Buffer;

  /** Время последней генерации секрета. От него считаются TTL и пауза resend. */
  @Column({ name: 'last_sent_at', type: 'timestamptz' })
  lastSentAt!: Date;

  /** Число НЕВЕРНЫХ вводов OTP. К magic link не применяется. */
  @Column({ type: 'smallint', default: 0 })
  attempts!: number;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @Column({
    name: 'consumed_reason',
    type: 'enum',
    enum: LoginChallengeConsumedReason,
    enumName: 'login_challenge_consumed_reason',
    nullable: true,
  })
  consumedReason!: LoginChallengeConsumedReason | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

/** Момент истечения: вычисляется, а не хранится (см. комментарий к классу). */
export function challengeExpiresAt(
  challenge: Pick<LoginChallenge, 'lastSentAt'>,
): Date {
  return new Date(
    challenge.lastSentAt.getTime() + LOGIN_CHALLENGE_TTL_SECONDS * 1000,
  );
}
