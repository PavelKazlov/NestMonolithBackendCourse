import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Задание 1.2. Таблица попыток входа `login_challenges` и новые статусы пользователя.
 *
 * Файл СГЕНЕРИРОВАН командой
 *   npm run migration:generate --name=CreateLoginChallenges
 * (TypeORM сравнил сущности со схемой БД) и только отформатирован.
 *
 * Что здесь создаётся:
 * - enum-типы `login_challenge_method` и `login_challenge_consumed_reason`;
 * - `login_challenges` без колонки `expires_at` (BCNF: срок = last_sent_at + 10 мин):
 *   - CHECK `attempts` в диапазоне 0..5;
 *   - CHECK «consumed_at и consumed_reason заданы только вместе»;
 *   - CHECK «attempts_exhausted ⇒ attempts = 5»;
 *   - частичный уникальный индекс `UQ_login_challenges_open_user`:
 *     одна НЕпогашенная попытка на пользователя (WHERE consumed_at IS NULL);
 *   - обычный индекс по `user_id` для ON DELETE CASCADE;
 *   - внешний ключ на `users` с ON DELETE CASCADE.
 * - в `user_status` добавлены `blocked`, `deleting`, `deleted` (спека 1.2,
 *   сценарий 7). PostgreSQL умеет `ALTER TYPE ... ADD VALUE`, но удалить
 *   значение из enum не умеет. Поэтому TypeORM пересоздаёт тип: переименовать
 *   старый, создать новый, перевести колонку через `text`, удалить старый.
 *   Так у миграции есть честный `down`.
 *
 * `down` откатит enum к ('pending', 'active'). Если в `users` уже есть строки
 * с новыми статусами, приведение типа упадёт, и откат остановится целиком
 * (миграция идёт в транзакции). Данные не потеряются молча.
 */
export class CreateLoginChallenges1794823342520 implements MigrationInterface {
  name = 'CreateLoginChallenges1794823342520';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."login_challenge_method" AS ENUM('otp', 'magic_link')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."login_challenge_consumed_reason" AS ENUM('confirmed', 'replaced', 'attempts_exhausted', 'user_inactive')`,
    );
    await queryRunner.query(
      `CREATE TABLE "login_challenges" ("id" uuid NOT NULL, "user_id" uuid NOT NULL, "method" "public"."login_challenge_method" NOT NULL, "secret_hash" bytea NOT NULL, "last_sent_at" TIMESTAMP WITH TIME ZONE NOT NULL, "attempts" smallint NOT NULL DEFAULT '0', "consumed_at" TIMESTAMP WITH TIME ZONE, "consumed_reason" "public"."login_challenge_consumed_reason", "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_login_challenges_exhausted" CHECK ("consumed_reason" IS DISTINCT FROM 'attempts_exhausted' OR "attempts" = 5), CONSTRAINT "CHK_login_challenges_consumed" CHECK (("consumed_at" IS NULL) = ("consumed_reason" IS NULL)), CONSTRAINT "CHK_login_challenges_attempts" CHECK ("attempts" >= 0 AND "attempts" <= 5), CONSTRAINT "PK_login_challenges" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_login_challenges_user_id" ON "login_challenges" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_login_challenges_open_user" ON "login_challenges" ("user_id") WHERE "consumed_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."user_status" RENAME TO "user_status_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."user_status" AS ENUM('pending', 'active', 'blocked', 'deleting', 'deleted')`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" TYPE "public"."user_status" USING "status"::"text"::"public"."user_status"`,
    );
    await queryRunner.query(`DROP TYPE "public"."user_status_old"`);
    await queryRunner.query(
      `ALTER TABLE "login_challenges" ADD CONSTRAINT "FK_login_challenges_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "login_challenges" DROP CONSTRAINT "FK_login_challenges_user_id"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."user_status_old" AS ENUM('pending', 'active')`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" TYPE "public"."user_status_old" USING "status"::"text"::"public"."user_status_old"`,
    );
    await queryRunner.query(`DROP TYPE "public"."user_status"`);
    await queryRunner.query(
      `ALTER TYPE "public"."user_status_old" RENAME TO "user_status"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_login_challenges_open_user"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_login_challenges_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "login_challenges"`);
    await queryRunner.query(
      `DROP TYPE "public"."login_challenge_consumed_reason"`,
    );
    await queryRunner.query(`DROP TYPE "public"."login_challenge_method"`);
  }
}
