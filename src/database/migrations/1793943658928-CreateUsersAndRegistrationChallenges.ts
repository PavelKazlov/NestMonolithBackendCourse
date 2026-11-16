import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Задание 1.0. Таблицы регистрации: `users` и `registration_challenges`.
 *
 * Файл СГЕНЕРИРОВАН командой
 *   npm run migration:generate --name=CreateUsersAndRegistrationChallenges
 * TypeORM сравнил сущности (*.entity.ts) с текущей схемой БД и записал разницу
 * в виде SQL. Миграция — версия схемы в git: её применяют на каждом стенде
 * одинаково (`migration:run` или `POSTGRES_MIGRATIONS_RUN=true` при старте),
 * вместо `synchronize: true`, которое может молча удалить колонку с данными.
 *
 * up — применить изменения, down — откатить их в обратном порядке.
 *
 * Что здесь создаётся:
 * - enum-типы `user_status` и `confirmation_method`;
 * - `users` с уникальным индексом `UQ_users_email` (защита от дублей и гонок);
 * - `registration_challenges`:
 *   - CHECK на счётчик попыток (0..5);
 *   - CHECK `expires_at = last_sent_at + 600 s` (защита от аномалии обновления, 2NF);
 *   - уникальный `user_id` (одна попытка на пользователя);
 *   - частичный индекс по `secret_hash` для magic link;
 *   - внешний ключ на `users` с ON DELETE CASCADE.
 */

export class CreateUsersAndRegistrationChallenges1793943658928 implements MigrationInterface {
  name = 'CreateUsersAndRegistrationChallenges1793943658928';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."user_status" AS ENUM('pending', 'active')`,
    );
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL, "email" character varying(254) NOT NULL, "password_hash" character varying(255) NOT NULL, "status" "public"."user_status" NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_users" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_users_email" ON "users" ("email") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."confirmation_method" AS ENUM('otp', 'magic_link')`,
    );
    await queryRunner.query(
      `CREATE TABLE "registration_challenges" ("id" uuid NOT NULL, "user_id" uuid NOT NULL, "method" "public"."confirmation_method" NOT NULL, "secret_hash" bytea NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "attempts" smallint NOT NULL DEFAULT '0', "last_sent_at" TIMESTAMP WITH TIME ZONE NOT NULL, "consumed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_registration_challenges_expires_at" CHECK ("expires_at" = "last_sent_at" + interval '600 seconds'), CONSTRAINT "CHK_registration_challenges_attempts" CHECK ("attempts" >= 0 AND "attempts" <= 5), CONSTRAINT "PK_registration_challenges" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_registration_challenges_magic_link_secret" ON "registration_challenges" ("secret_hash") WHERE "method" = 'magic_link'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_registration_challenges_user_id" ON "registration_challenges" ("user_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "registration_challenges" ADD CONSTRAINT "FK_registration_challenges_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "registration_challenges" DROP CONSTRAINT "FK_registration_challenges_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_registration_challenges_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_registration_challenges_magic_link_secret"`,
    );
    await queryRunner.query(`DROP TABLE "registration_challenges"`);
    await queryRunner.query(`DROP TYPE "public"."confirmation_method"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_users_email"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "public"."user_status"`);
  }
}
