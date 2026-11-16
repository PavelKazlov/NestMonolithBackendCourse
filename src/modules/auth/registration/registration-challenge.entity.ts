import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { User } from '@/modules/users/user.entity';
import {
  CHALLENGE_TTL_SECONDS,
  MAX_CONFIRM_ATTEMPTS,
} from './registration.constants';

/** Способ подтверждения. Выбирает сервер (флаг конфигурации), а не клиент. */
export enum ConfirmationMethod {
  Otp = 'otp',
  MagicLink = 'magic_link',
}

/**
 * Таблица `registration_challenges` — «попытка подтверждения» email.
 *
 * Одна строка на пользователя (уникальный `user_id`). Повторная отправка
 * не создаёт новую строку, а ОБНОВЛЯЕТ эту: новый секрет, новый TTL, счётчик
 * с нуля. Поэтому `attemptId`, который получил клиент, не меняется.
 */
@Entity('registration_challenges')
// Связь 1:1 с пользователем. Уникальный индекс гарантирует это на уровне БД.
@Index('UQ_registration_challenges_user_id', ['userId'], { unique: true })
// Частичный индекс: только строки magic link. По нему confirm находит попытку
// по HMAC токена за O(log n), не просматривая таблицу.
// Почему частичный: HMAC OTP-кодов в индексе не нужен (OTP ищут по id),
// и поиск по токену обязан фильтровать `method = 'magic_link'` (см. сервис).
@Index('IDX_registration_challenges_magic_link_secret', ['secretHash'], {
  where: `"method" = 'magic_link'`,
})
// Счётчик неверных вводов не выходит за лимит.
@Check(
  'CHK_registration_challenges_attempts',
  `"attempts" >= 0 AND "attempts" <= ${MAX_CONFIRM_ATTEMPTS}`,
)
// Спека, «Нормальная форма»: `expires_at` всегда равен `last_sent_at + 10 мин`.
// Это транзитивная зависимость (таблица формально во 2NF), и она грозит
// аномалией обновления: обновили `last_sent_at`, забыли `expires_at`, и TTL
// не перезапустился. Сервис меняет оба поля одним UPDATE, а CHECK делает
// такую аномалию невозможной: БД отвергнет несогласованную строку.
@Check(
  'CHK_registration_challenges_expires_at',
  `"expires_at" = "last_sent_at" + interval '${CHALLENGE_TTL_SECONDS} seconds'`,
)
export class RegistrationChallenge {
  /**
   * Идентификатор попытки (`attemptId` в API). Генерирует приложение ДО
   * вставки: он входит в данные HMAC OTP-кода (см. challenge-secrets.ts).
   */
  @PrimaryColumn('uuid', {
    primaryKeyConstraintName: 'PK_registration_challenges',
  })
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /**
   * Внешний ключ на `users.id`. `ON DELETE CASCADE`: удалили пользователя —
   * его попытка удалится автоматически, «сирот» не останется.
   * Свойство `user` в коде не используем, оно нужно для генерации FK.
   */
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_registration_challenges_user_id',
  })
  user?: User;

  @Column({
    type: 'enum',
    enum: ConfirmationMethod,
    enumName: 'confirmation_method',
  })
  method!: ConfirmationMethod;

  /**
   * HMAC-SHA256 от секрета (32 байта). Сам код или токен не хранится нигде:
   * ни в БД, ни в логах. Только в письме у владельца ящика.
   * `bytea` — двоичные данные. В TypeScript это `Buffer`, его удобно
   * сравнивать через `timingSafeEqual`.
   */
  @Column({ name: 'secret_hash', type: 'bytea' })
  secretHash!: Buffer;

  /** Конец TTL. Денормализация: `last_sent_at + 10 минут` (см. CHECK выше). */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  /** Число НЕВЕРНЫХ вводов кода. Успешный ввод счётчик не увеличивает. */
  @Column({ type: 'smallint', default: 0 })
  attempts!: number;

  /** Время последней отправки письма. Следующая — не раньше чем через 60 с. */
  @Column({ name: 'last_sent_at', type: 'timestamptz' })
  lastSentAt!: Date;

  /**
   * Момент погашения: успешное подтверждение ИЛИ пятый неверный ввод.
   * Различаем их по счётчику: `attempts >= 5` значит «исчерпан лимит» (429),
   * иначе попытка уже использована (400).
   */
  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;
}
