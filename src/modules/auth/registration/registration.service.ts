import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { LessThanOrEqual, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import { AuditLogger } from '@/core/audit/audit-logger';
import { AppException } from '@/core/errors/app.exception';
import { MailDeliveryError, MailSender } from '@/core/mail/mail-sender';
import { PasswordHasher } from '@/modules/auth/password/password-hasher';
import { User, UserStatus } from '@/modules/users/user.entity';
import { emailTakenError, UsersService } from '@/modules/users/users.service';
import { ChallengeSecrets } from './challenge-secrets';
import type { ConfirmationInput } from './dto/confirm-registration.dto';
import { RegisterDto } from './dto/register.dto';
import {
  ConfirmationMethod,
  RegistrationChallenge,
} from './registration-challenge.entity';
import { buildConfirmationMail } from './registration-mail';
import {
  CHALLENGE_TTL_SECONDS,
  MAX_CONFIRM_ATTEMPTS,
  RESEND_COOLDOWN_SECONDS,
} from './registration.constants';
import { RegistrationSettings } from './registration.settings';

/** Результат регистрации: контроллер выберет по нему 201 или 202. */
export type RegisterResult =
  | { kind: 'active'; user: User }
  | { kind: 'confirmation_required'; challenge: RegistrationChallenge };

/**
 * Исход проверки внутри транзакции confirm.
 *
 * Транзакция ВОЗВРАЩАЕТ исход, а не бросает исключение. Это принципиально:
 * если бросить исключение внутри `@Transactional()`, транзакция откатится,
 * а вместе с ней и `attempts + 1` за неверный код. Тогда счётчик никогда
 * бы не рос, и лимит в 5 попыток не работал бы. Поэтому сначала фиксируем
 * транзакцию, а исключение (400/429) бросаем уже снаружи.
 */
type ConfirmOutcome =
  | { kind: 'confirmed'; user: User; challenge: RegistrationChallenge }
  | {
      kind: 'invalid';
      reason: 'not_found' | 'already_used' | 'wrong_secret';
      challenge?: RegistrationChallenge;
      attempts?: number;
    }
  | { kind: 'expired'; challenge: RegistrationChallenge }
  | { kind: 'exhausted'; challenge: RegistrationChallenge };

/**
 * 400: неверный код или токен, ненайденная или уже использованная попытка.
 * Спека: «Если попытка не найдена или уже погашена, ответ такой же, как при
 * неверном коде». Клиент не должен различать эти случаи, иначе по разнице
 * ответов можно узнать, существует ли попытка с таким id.
 */
function confirmationInvalidError(): AppException {
  return new AppException(
    HttpStatus.BAD_REQUEST,
    'confirmation_invalid',
    'Confirmation code or token is invalid',
  );
}

/**
 * Регистрация пользователя по email и паролю (задание 1.0).
 *
 * Три операции:
 * - `register` — создать аккаунт (active сразу или pending + письмо);
 * - `confirm`  — подтвердить email кодом или токеном ссылки;
 * - `resend`   — выслать новый код или ссылку.
 */
@Injectable()
export class RegistrationService {
  constructor(
    @InjectRepository(RegistrationChallenge)
    private readonly challenges: Repository<RegistrationChallenge>,
    private readonly users: UsersService,
    private readonly hasher: PasswordHasher,
    private readonly secrets: ChallengeSecrets,
    private readonly mail: MailSender,
    private readonly settings: RegistrationSettings,
    private readonly audit: AuditLogger,
  ) {}

  // ───────────────────────────── register ─────────────────────────────

  /**
   * Шаги из спеки (раздел 1.3.1):
   * 1–2. Принять и проверить вход — уже сделал ValidationPipe по RegisterDto
   *      (email нормализован, политика пароля проверена).
   * 3. Посчитать медленный хеш пароля с уникальной солью (Argon2id).
   * 4. Флаг выключен: создать `active` (+ хук роли в той же транзакции).
   * 5. Флаг включён: создать `pending` + попытку, отправить письмо.
   */
  async register(dto: RegisterDto): Promise<RegisterResult> {
    const { email, password } = dto;

    // Быстрая проверка до дорогого хеширования. Без неё повторные попытки
    // зарегистрировать занятый email тратили бы десятки миллисекунд CPU на Argon2.
    // Гонку двух параллельных регистраций она НЕ закрывает, это делает
    // уникальный индекс (см. UsersService.insert).
    const existing = await this.users.findByEmail(email);
    if (existing) {
      this.failRegistration('email_taken', existing.id);
    }

    const passwordHash = await this.hasher.hash(password);

    try {
      // Флаг читается ОДИН раз, в момент регистрации. Если его выключат
      // позже, созданный pending сам активным не станет (спека).
      if (!this.settings.confirmationEnabled) {
        const user = await this.users.createActive(email, passwordHash);
        this.audit.info('registration.succeeded', {
          userId: user.id,
          status: user.status,
        });
        return { kind: 'active', user };
      }

      const method = this.settings.confirmationMethod;
      const secret = this.secrets.generate(method);
      const { user, challenge } = await this.createPendingWithChallenge(
        email,
        passwordHash,
        method,
        secret,
      );
      this.audit.info('registration.succeeded', {
        userId: user.id,
        status: user.status,
        attemptId: challenge.id,
        method,
      });

      // Письмо отправляем ПОСЛЕ фиксации транзакции:
      // - не держим транзакцию и блокировки, пока SMTP думает секунды;
      // - если письмо не ушло, pending и попытка уже сохранены (спека: 503,
      //   «запись pending и попытка сохраняются», дальше — resend).
      await this.deliver(email, challenge, secret, 'register');
      return { kind: 'confirmation_required', challenge };
    } catch (error: unknown) {
      // Гонка: параллельный запрос занял email между проверкой и INSERT.
      if (error instanceof AppException && error.code === 'email_taken') {
        this.failRegistration('email_taken');
      }
      throw error;
    }
  }

  /** Аудит неуспешной регистрации и 409. */
  private failRegistration(reason: 'email_taken', userId?: string): never {
    this.audit.warn('registration.failed', { reason, existingUserId: userId });
    throw emailTakenError();
  }

  /**
   * Пользователь `pending` и его попытка — в ОДНОЙ транзакции.
   * Не бывает pending без попытки (некому было бы подтвердить) и попытки
   * без пользователя.
   */
  @Transactional()
  private async createPendingWithChallenge(
    email: string,
    passwordHash: string,
    method: ConfirmationMethod,
    secret: string,
  ): Promise<{ user: User; challenge: RegistrationChallenge }> {
    const user = await this.users.createPending(email, passwordHash);

    // id генерируем до INSERT: он входит в HMAC OTP-кода.
    const id = randomUUID();
    const challenge = this.challenges.create({
      id,
      userId: user.id,
      method,
      secretHash: this.secrets.hash(method, id, secret),
      attempts: 0,
      consumedAt: null,
      ...sendWindow(new Date()),
    });
    await this.challenges.insert(challenge);
    return { user, challenge };
  }

  // ───────────────────────────── confirm ──────────────────────────────

  /**
   * Подтверждение email (раздел 1.3.2, «Логика/шаги»):
   * 1. Найти попытку; не найдена или погашена — как неверный код (400).
   * 2. Просроченную отклонить, НЕ увеличивая счётчик.
   * 3. Сравнить секрет; не совпал — счётчик +1 (пятый неверный гасит попытку).
   * 4. Успех — пользователь active (+ роль через хук), попытка погашена.
   */
  async confirm(input: ConfirmationInput): Promise<User> {
    const outcome = await this.confirmInTransaction(input, new Date());
    const base = {
      method: input.kind,
      attemptId: input.kind === 'otp' ? input.attemptId : outcome.challenge?.id,
    };

    switch (outcome.kind) {
      case 'confirmed':
        this.audit.info('registration.confirmation.succeeded', {
          ...base,
          userId: outcome.user.id,
        });
        return outcome.user;

      case 'expired':
        this.audit.warn('registration.confirmation.failed', {
          ...base,
          reason: 'expired',
        });
        throw new AppException(
          HttpStatus.BAD_REQUEST,
          'confirmation_expired',
          'Confirmation code or token has expired, request a new one',
        );

      case 'exhausted':
        // Спека: «Следующий запрос, даже с верным кодом, отклоняется как
        // исчерпанный лимит» — 429. Выход один: resend (новый код, счётчик с нуля).
        this.audit.warn('registration.confirmation.failed', {
          ...base,
          reason: 'attempts_exhausted',
        });
        throw new AppException(
          HttpStatus.TOO_MANY_REQUESTS,
          'attempts_exhausted',
          'Too many invalid attempts, request a new code',
        );

      case 'invalid':
        this.audit.warn('registration.confirmation.failed', {
          ...base,
          reason: outcome.reason,
          attempts: outcome.attempts,
        });
        throw confirmationInvalidError();
    }
  }

  /**
   * Вся проверка — в одной транзакции с блокировкой строки попытки.
   *
   * `lock: pessimistic_write` превращается в `SELECT ... FOR UPDATE`. Пока
   * эта транзакция не завершилась, второй confirm той же попытки ждёт на
   * своём SELECT. Без блокировки 10 параллельных запросов с неверными кодами
   * прочитали бы `attempts = 0` и все записали бы `attempts = 1`. Лимит в 5
   * попыток можно было бы обойти параллелизмом.
   *
   * Замечание: `@Transactional()` из typeorm-transactional подменяет сам метод
   * в прототипе класса, поэтому вызов через `this.` тоже идёт в транзакции.
   * В Spring (Java) так нельзя: там транзакции работают через прокси.
   */
  @Transactional()
  private async confirmInTransaction(
    input: ConfirmationInput,
    now: Date,
  ): Promise<ConfirmOutcome> {
    const challenge = await this.findForConfirm(input);

    // Шаг 1. Не найдена.
    if (!challenge) {
      return { kind: 'invalid', reason: 'not_found' };
    }

    // Шаг 1. Уже погашена: успехом (400) или пятым неверным вводом (429).
    if (challenge.consumedAt) {
      return challenge.attempts >= MAX_CONFIRM_ATTEMPTS
        ? { kind: 'exhausted', challenge }
        : { kind: 'invalid', reason: 'already_used', challenge };
    }

    // Шаг 2. Просрочена — счётчик не трогаем.
    if (now.getTime() >= challenge.expiresAt.getTime()) {
      return { kind: 'expired', challenge };
    }

    // Шаг 3. Сравнение секрета за постоянное время.
    const secret = input.kind === 'otp' ? input.code : input.token;
    if (
      !this.secrets.matches(
        challenge.method,
        challenge.id,
        secret,
        challenge.secretHash,
      )
    ) {
      return this.recordWrongAttempt(challenge, now);
    }

    // Шаг 4. Успех: гасим попытку и активируем пользователя.
    // `users.activate` помечен `@Transactional()` и присоединяется к ЭТОЙ
    // транзакции (propagation REQUIRED по умолчанию), включая хук роли.
    await this.challenges.update({ id: challenge.id }, { consumedAt: now });
    const user = await this.users.activate(challenge.userId);
    return { kind: 'confirmed', user, challenge };
  }

  /**
   * Поиск попытки с блокировкой строки.
   *
   * - OTP: по `attemptId`. Искать по хешу кода нельзя: кодов всего миллион,
   *   перебор хешей по всей таблице дал бы совпадение с ЧЬЕЙ-ТО попыткой.
   *   Поиск по id привязывает перебор к одной попытке с лимитом в 5 вводов.
   * - Magic link: по HMAC токена. 2^256 вариантов перебрать невозможно.
   *
   * Фильтр по `method` в обоих случаях — защита в глубину. Сейчас подмену
   * отсекают и разные префиксы HMAC, и формат токена (43 символа). Но без
   * фильтра любое будущее изменение префиксов или формата позволило бы
   * прислать `{ token }` и искать по хешу среди OTP-попыток в обход лимита
   * в 5 вводов. Или прислать OTP-код к попытке magic link.
   */
  private findForConfirm(
    input: ConfirmationInput,
  ): Promise<RegistrationChallenge | null> {
    const lock = { mode: 'pessimistic_write' } as const;
    if (input.kind === 'otp') {
      return this.challenges.findOne({
        where: { id: input.attemptId, method: ConfirmationMethod.Otp },
        lock,
      });
    }
    return this.challenges.findOne({
      where: {
        secretHash: this.secrets.hashToken(input.token),
        method: ConfirmationMethod.MagicLink,
      },
      lock,
    });
  }

  /**
   * Неверный код: счётчик +1, на пятом неверном попытка гасится.
   * Строка заблокирована (`FOR UPDATE`), поэтому прочитанное `attempts`
   * актуально, и инкремент в приложении безопасен.
   */
  private async recordWrongAttempt(
    challenge: RegistrationChallenge,
    now: Date,
  ): Promise<ConfirmOutcome> {
    const attempts = challenge.attempts + 1;
    await this.challenges.update(
      { id: challenge.id },
      {
        attempts,
        // Пятый неверный ввод — это ещё «неверный код» (400), но попытка
        // уже погашена. Следующий запрос получит 429 attempts_exhausted.
        consumedAt: attempts >= MAX_CONFIRM_ATTEMPTS ? now : null,
      },
    );
    return { kind: 'invalid', reason: 'wrong_secret', challenge, attempts };
  }

  // ───────────────────────────── resend ───────────────────────────────

  /**
   * Повторная отправка (раздел 1.3.2):
   * - не чаще раза в 60 секунд;
   * - новый секрет заменяет старый (старый код или ссылка больше не подходят);
   * - TTL отсчитывается заново, счётчик попыток обнуляется;
   * - работает и для попытки, погашенной лимитом (иначе пользователь застрял бы);
   * - использует способ, сохранённый в попытке, а не текущий флаг: «уже
   *   выпущенную попытку можно ... отправить заново независимо от того,
   *   включён ли флаг сейчас».
   */
  async resend(email: string): Promise<RegistrationChallenge> {
    const user = await this.users.findByEmail(email);
    const challenge =
      user?.status === UserStatus.Pending
        ? await this.challenges.findOneBy({ userId: user.id })
        : null;

    if (!user || !challenge) {
      // Нет такого email или он уже active — подтверждать нечего.
      // Ответ как при неверном коде (шаг 1 логики confirm).
      this.audit.warn('registration.resend.failed', {
        reason: user ? 'not_pending' : 'not_found',
        userId: user?.id,
      });
      throw confirmationInvalidError();
    }

    const now = new Date();
    const secret = this.secrets.generate(challenge.method);
    const secretHash = this.secrets.hash(
      challenge.method,
      challenge.id,
      secret,
    );
    const window = sendWindow(now);

    // Условный UPDATE — атомарная проверка «прошло ли 60 секунд»:
    //   UPDATE ... SET ... WHERE id = $1 AND last_sent_at <= now - 60s
    // Если два resend пришли одновременно, PostgreSQL выполнит их по очереди
    // (UPDATE блокирует строку). Второй увидит уже новый `last_sent_at`,
    // условие не выполнится, обновлено 0 строк — ответ 429.
    // Вариант «SELECT, проверить в коде, потом UPDATE» пропустил бы оба запроса.
    //
    // Все зависимые поля меняются ОДНИМ UPDATE: `last_sent_at` и `expires_at`
    // вместе (защита от аномалии обновления из раздела «Нормальная форма»).
    const cooldownEdge = new Date(
      now.getTime() - RESEND_COOLDOWN_SECONDS * 1000,
    );
    const result = await this.challenges.update(
      { id: challenge.id, lastSentAt: LessThanOrEqual(cooldownEdge) },
      { secretHash, ...window, attempts: 0, consumedAt: null },
    );

    if (!result.affected) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(
          (challenge.lastSentAt.getTime() +
            RESEND_COOLDOWN_SECONDS * 1000 -
            now.getTime()) /
            1000,
        ),
      );
      this.audit.warn('registration.resend.failed', {
        reason: 'too_soon',
        userId: user.id,
        attemptId: challenge.id,
        retryAfterSeconds,
      });
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        'resend_too_soon',
        'Confirmation email was sent recently, try again later',
        { retryAfterSeconds },
      );
    }

    const updated: RegistrationChallenge = {
      ...challenge,
      secretHash,
      ...window,
      attempts: 0,
      consumedAt: null,
    };
    await this.deliver(email, updated, secret, 'resend');
    return updated;
  }

  // ───────────────────────────── письмо ───────────────────────────────

  /**
   * Отправка письма с кодом или ссылкой.
   *
   * `secret` живёт только в памяти этого запроса и в письме: в БД — HMAC,
   * в ответ API и в аудит он не попадает.
   *
   * Сбой SMTP → 503 `mail_delivery_failed`. В тело кладём `attemptId` и
   * `resendAfterSeconds`: попытка сохранена, и клиент знает, когда можно
   * просить новое письмо. Кулдаун 60 с считается и для неудачной отправки.
   * Иначе при «лежащем» SMTP клиент в цикле повторял бы resend, и после
   * восстановления сервера пользователю пришла бы пачка писем.
   */
  private async deliver(
    email: string,
    challenge: RegistrationChallenge,
    secret: string,
    trigger: 'register' | 'resend',
  ): Promise<void> {
    const fields = {
      userId: challenge.userId,
      attemptId: challenge.id,
      method: challenge.method,
      trigger,
    };
    try {
      await this.mail.send(
        buildConfirmationMail(
          email,
          challenge.method,
          secret,
          this.settings.confirmUrl,
        ),
      );
    } catch (error: unknown) {
      // Только «ожидаемый» сбой доставки превращаем в 503. Любая другая
      // ошибка — баг, пусть станет 500 и попадёт в лог со стеком.
      if (!(error instanceof MailDeliveryError)) throw error;
      this.audit.warn('registration.confirmation.send_failed', fields);
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'mail_delivery_failed',
        'Confirmation email could not be sent, request a new one later',
        {
          attemptId: challenge.id,
          resendAfterSeconds: RESEND_COOLDOWN_SECONDS,
        },
      );
    }
    this.audit.info('registration.confirmation.sent', fields);
  }
}

/**
 * Окно отправки: `last_sent_at = now`, `expires_at = now + 10 мин`.
 * Одна функция для обоих полей. Они всегда вычисляются и пишутся вместе.
 */
function sendWindow(
  now: Date,
): Pick<RegistrationChallenge, 'lastSentAt' | 'expiresAt'> {
  return {
    lastSentAt: now,
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1000),
  };
}
