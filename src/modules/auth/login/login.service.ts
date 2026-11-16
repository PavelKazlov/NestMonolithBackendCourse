import { HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import { IsNull, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import { AuditIds } from '@/core/audit/audit-ids';
import { AuditLogger } from '@/core/audit/audit-logger';
import { AppException } from '@/core/errors/app.exception';
import { MailDeliveryError, MailSender } from '@/core/mail/mail-sender';
import { PasswordHasher } from '@/modules/auth/password/password-hasher';
import { ConfirmationMethod } from '@/modules/auth/registration/registration-challenge.entity';
import { TokenPair, TokenService } from '@/modules/auth/tokens/token.service';
import { User, UserStatus } from '@/modules/users/user.entity';
import { UsersService } from '@/modules/users/users.service';
import type { LoginConfirmationInput } from './dto/confirm-login.dto';
import { LoginDto } from './dto/login.dto';
import {
  challengeExpiresAt,
  LoginChallenge,
  LoginChallengeConsumedReason as Reason,
} from './login-challenge.entity';
import { LoginChallengeSecrets } from './login-challenge-secrets';
import { LoginFailureLimiter } from './login-failure-limiter';
import { buildLoginMail } from './login-mail';
import {
  LOGIN_MAX_OTP_ATTEMPTS,
  LOGIN_RESEND_COOLDOWN_SECONDS,
} from './login.constants';
import { LoginSettings } from './login.settings';

/** Результат login: контроллер выберет по нему 204 + cookies или 202. */
export type LoginResult =
  | { kind: 'session'; userId: string; tokens: TokenPair }
  | { kind: 'confirmation_required'; challenge: LoginChallenge };

/** Результат успешного confirm: пара токенов для cookies. */
export interface ConfirmedLogin {
  userId: string;
  tokens: TokenPair;
}

/**
 * Почему попытка «недействительна» для confirm/resend. Все эти случаи дают
 * клиенту ОДИН ответ 400 (спека 1.2: «общий ответ 400»). Различаем их только
 * в журнале.
 */
type InvalidReason =
  | 'not_found'
  | 'expired'
  | 'wrong_secret'
  | Reason.Confirmed
  | Reason.Replaced
  | Reason.UserInactive;

/**
 * Исходы транзакций (ниже). Транзакция ВОЗВРАЩАЕТ исход, а не бросает исключение
 * (тот же приём, что в 1.0). Исключение внутри `@Transactional()` откатило бы
 * транзакцию, а вместе с ней `attempts + 1` за неверный код и погашение
 * попытки. Тогда лимит в 5 вводов никогда бы не сработал. Поэтому сначала
 * COMMIT, а 400/401/429 бросаем уже снаружи.
 *
 * Исключение: сбой подписи JWT. Его откат как раз нужен (спека: «откатившуюся
 * попытку можно подтвердить повторно»), поэтому он бросается изнутри.
 */
type Invalid = {
  kind: 'invalid';
  reason: InvalidReason;
  challenge?: LoginChallenge;
  attempts?: number;
};
type Exhausted = { kind: 'exhausted'; challenge: LoginChallenge };
type UserInactive = { kind: 'user_inactive'; challenge?: LoginChallenge };
type TooSoon = {
  kind: 'too_soon';
  retryAfterSeconds: number;
  challenge?: LoginChallenge;
};

type CreateOutcome =
  | { kind: 'created'; challenge: LoginChallenge; replacedId?: string }
  | UserInactive
  | TooSoon;
type ConfirmOutcome =
  | { kind: 'confirmed'; challenge: LoginChallenge; tokens: TokenPair }
  | Invalid
  | Exhausted
  | UserInactive;
type ResendOutcome =
  | { kind: 'resent'; challenge: LoginChallenge; secret: string; email: string }
  | Invalid
  | Exhausted
  | UserInactive
  | TooSoon;

/**
 * 401 `invalid_credentials`. Одинаковые статус, код, текст и форма для
 * неизвестного email, неверного пароля и любого статуса кроме `active`
 * (спека 1.2, раздел 1.4). Иначе по разнице ответов можно было бы собрать
 * список зарегистрированных адресов (перечисление аккаунтов).
 */
export function invalidCredentialsError(): AppException {
  return new AppException(
    HttpStatus.UNAUTHORIZED,
    'invalid_credentials',
    'Invalid email or password',
  );
}

/** 400 для любой недействительной попытки и неверного секрета. */
function confirmationInvalidError(): AppException {
  return new AppException(
    HttpStatus.BAD_REQUEST,
    'confirmation_invalid',
    'Login confirmation is invalid or expired, start a new login',
  );
}

function attemptsExhaustedError(): AppException {
  return new AppException(
    HttpStatus.TOO_MANY_REQUESTS,
    'attempts_exhausted',
    'Too many invalid codes, start a new login',
  );
}

function resendTooSoonError(retryAfterSeconds: number): AppException {
  return new AppException(
    HttpStatus.TOO_MANY_REQUESTS,
    'resend_too_soon',
    'Confirmation email was sent recently, try again later',
    { retryAfterSeconds },
  );
}

/** Сколько секунд осталось до конца паузы 60 с (0 — пауза прошла). */
function cooldownLeft(challenge: LoginChallenge, now: Date): number {
  const left =
    challenge.lastSentAt.getTime() +
    LOGIN_RESEND_COOLDOWN_SECONDS * 1000 -
    now.getTime();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * Вход по email и паролю и email challenge (спека 1.2, разделы 1.3.1–1.3.2).
 *
 * Три операции:
 * - `login`   — проверить пароль; выдать пару или начать email challenge;
 * - `confirm` — подтвердить вход кодом или ссылкой, выдать пару;
 * - `resend`  — новый код или ссылка для той же попытки.
 *
 * Сервис не знает про HTTP и cookies: он возвращает пару токенов, а cookies
 * ставит контроллер (AuthCookies).
 */
@Injectable()
export class LoginService implements OnModuleInit {
  /**
   * Фиктивный хеш для отсутствующего пользователя (спека, шаг 2).
   *
   * Если бы для неизвестного email сервер сразу отвечал 401, ответ приходил бы
   * за 1–2 мс, а для существующего — за ~50 мс (Argon2). По времени ответа
   * можно было бы перебирать, какие email зарегистрированы. Поэтому для
   * неизвестного email тоже выполняем `argon2.verify` по заранее
   * подготовленному хешу с теми же параметрами. Готовим его ОДИН раз при старте,
   * а не на каждый запрос: иначе неизвестный email стоил бы два Argon2 (hash +
   * verify) и снова отличался по времени.
   */
  private dummyHash!: string;

  constructor(
    @InjectRepository(LoginChallenge)
    private readonly challenges: Repository<LoginChallenge>,
    private readonly users: UsersService,
    private readonly hasher: PasswordHasher,
    private readonly secrets: LoginChallengeSecrets,
    private readonly tokens: TokenService,
    private readonly limiter: LoginFailureLimiter,
    private readonly mail: MailSender,
    private readonly settings: LoginSettings,
    private readonly audit: AuditLogger,
    private readonly auditIds: AuditIds,
  ) {}

  async onModuleInit(): Promise<void> {
    // Случайный пароль, который никто не знает: verify с ним всегда false.
    this.dummyHash = await this.hasher.hash(
      randomBytes(32).toString('base64url'),
    );
  }

  // ───────────────────────────── login ────────────────────────────────

  /**
   * Шаги спеки (раздел 1.3.1):
   * 1. Формат тела проверил ValidationPipe, лимит 30/мин/IP — throttler.
   *    Здесь — лимит неуспехов на email + IP, тоже ДО дорогой проверки хеша.
   * 2–3. Пользователь по нормализованному email, проверка пароля argon2
   *      (по фиктивному хешу, если пользователя нет).
   * 4. Нет пользователя, неверный пароль, статус не `active` → один 401.
   * 5. Подтверждение выключено → пара токенов.
   * 6–8. Подтверждение включено → попытка и письмо, токенов нет.
   */
  async login(dto: LoginDto, clientIp: string): Promise<LoginResult> {
    const { email, password } = dto;
    // Необратимый id email для журнала и ключа лимитера (спека, раздел 1.5).
    const emailId = this.auditIds.emailId(email);
    const limiterKey = `${emailId}|${clientIp}`;

    const retryAfterSeconds = this.limiter.check(limiterKey);
    if (retryAfterSeconds !== null) {
      this.audit.warn('login.rate_limited', { emailId, retryAfterSeconds });
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        'rate_limited',
        'Too many failed login attempts, try again later',
        { retryAfterSeconds },
      );
    }

    const user = await this.users.findForLogin(email);
    // Пароль проверяем ВСЕГДА, даже если уже ясно, что статус не active:
    // иначе неактивные аккаунты отвечали бы быстрее, и статус утекал бы по времени.
    const passwordOk = await this.hasher.verify(
      user?.passwordHash ?? this.dummyHash,
      password,
    );

    if (!user || !passwordOk || user.status !== UserStatus.Active) {
      this.limiter.recordFailure(limiterKey);
      this.audit.warn('login.failed', {
        reason: !user
          ? 'unknown_email'
          : !passwordOk
            ? 'wrong_password'
            : 'user_inactive',
        // Известный пользователь — по userId, неизвестный email — по служебному id.
        userId: user?.id,
        emailId: user ? undefined : emailId,
      });
      throw invalidCredentialsError();
    }

    // Настройка читается в момент запроса: изменение действует на новые входы.
    if (!this.settings.confirmationEnabled) {
      const tokens = this.tokens.issuePair(user.id);
      this.audit.info('login.succeeded', {
        userId: user.id,
        method: 'password',
      });
      return { kind: 'session', userId: user.id, tokens };
    }

    return this.startChallenge(user.id, email, limiterKey);
  }

  /** Шаги 6–8: попытка подтверждения и письмо. */
  private async startChallenge(
    userId: string,
    email: string,
    limiterKey: string,
  ): Promise<LoginResult> {
    const now = new Date();

    // Шаг 6. Быстрая проверка паузы БЕЗ транзакции и блокировок: частые
    // повторы login отсекаются дёшево, не создавая попытку и не отправляя письмо.
    const open = await this.challenges.findOneBy({
      userId,
      consumedAt: IsNull(),
    });
    const left = open ? cooldownLeft(open, now) : 0;
    if (open && left > 0) {
      this.failTooSoon('login', userId, open.id, left);
    }

    // Шаг 7. Всё остальное — одной транзакцией с блокировками.
    const method = this.settings.confirmationMethod;
    const secret = this.secrets.generate(method);
    const outcome = await this.createChallengeInTransaction(
      userId,
      method,
      secret,
      now,
    );

    if (outcome.kind === 'too_soon') {
      // Параллельный login успел создать попытку между шагом 6 и блокировкой.
      this.failTooSoon(
        'login',
        userId,
        outcome.challenge?.id,
        outcome.retryAfterSeconds,
      );
    }
    if (outcome.kind === 'user_inactive') {
      // Статус сменился между проверкой пароля и блокировкой строки:
      // тот же нейтральный 401, письма нет (спека, шаг 7).
      this.limiter.recordFailure(limiterKey);
      this.audit.warn('login.failed', { reason: 'user_inactive', userId });
      throw invalidCredentialsError();
    }

    const { challenge, replacedId } = outcome;
    this.audit.info('login.challenge.created', {
      userId,
      attemptId: challenge.id,
      method,
      replacedAttemptId: replacedId,
    });

    // Шаг 8. Письмо — ПОСЛЕ COMMIT (транзакция уже завершилась):
    // - не держим блокировки, пока SMTP думает секунды;
    // - если SMTP упал, попытка уже сохранена, и её можно отправить через resend.
    await this.deliver(email, challenge, secret, 'login');
    return { kind: 'confirmation_required', challenge };
  }

  /**
   * Транзакция шага 7 (спека 1.2, раздел 1.3.1):
   * «заблокировать пользователя, затем прежнюю попытку, повторно проверить
   * active и 60-секундную паузу, погасить прежнюю попытку и создать новую».
   *
   * Зачем повторные проверки под блокировкой. Между шагами 2–6 и этой
   * транзакцией мог пройти параллельный запрос: второй login (уже создал
   * попытку) или блокировка пользователя. Под `FOR UPDATE` состояние больше
   * не меняется до нашего COMMIT, поэтому решение принимается по актуальным данным.
   *
   * Два параллельных login одного пользователя выстроятся в очередь на
   * блокировке пользователя. Второй увидит попытку первого с только что
   * поставленным `last_sent_at` и получит 429. Писем не будет два.
   */
  @Transactional()
  private async createChallengeInTransaction(
    userId: string,
    method: ConfirmationMethod,
    secret: string,
    now: Date,
  ): Promise<CreateOutcome> {
    const user = await this.users.lockForAuth(userId);
    if (user?.status !== UserStatus.Active) return { kind: 'user_inactive' };

    const open = await this.challenges.findOne({
      where: { userId, consumedAt: IsNull() },
      lock: { mode: 'pessimistic_write' },
    });
    if (open) {
      const left = cooldownLeft(open, now);
      if (left > 0)
        return { kind: 'too_soon', retryAfterSeconds: left, challenge: open };
      // Сначала гасим прежнюю попытку, потом вставляем новую: частичный
      // уникальный индекс (одна открытая попытка) допускает это только в таком
      // порядке. Старый код или ссылка после этого не подходят.
      await this.challenges.update(
        { id: open.id },
        { consumedAt: now, consumedReason: Reason.Replaced },
      );
    }

    // id генерируем до INSERT: он входит в данные HMAC.
    const id = randomUUID();
    const challenge = this.challenges.create({
      id,
      userId,
      method,
      secretHash: this.secrets.hash(method, id, secret),
      lastSentAt: now,
      attempts: 0,
      consumedAt: null,
      consumedReason: null,
    });
    await this.challenges.insert(challenge);
    return { kind: 'created', challenge, replacedId: open?.id };
  }

  // ───────────────────────────── confirm ──────────────────────────────

  /**
   * Подтверждение входа (спека 1.2, раздел 1.3.2). При успехе возвращает
   * пару токенов; cookies поставит контроллер.
   */
  async confirm(input: LoginConfirmationInput): Promise<ConfirmedLogin> {
    const outcome = await this.confirmInTransaction(input, new Date());
    const base = { attemptId: input.attemptId, method: input.kind };

    switch (outcome.kind) {
      case 'confirmed':
        this.audit.info('login.challenge.confirmed', {
          ...base,
          userId: outcome.challenge.userId,
        });
        this.audit.info('login.succeeded', {
          userId: outcome.challenge.userId,
          method: input.kind,
        });
        return { userId: outcome.challenge.userId, tokens: outcome.tokens };

      case 'exhausted':
        this.audit.warn('login.challenge.failed', {
          ...base,
          reason: 'attempts_exhausted',
        });
        throw attemptsExhaustedError();

      case 'user_inactive':
        this.audit.warn('login.challenge.failed', {
          ...base,
          reason: 'user_inactive',
          userId: outcome.challenge?.userId,
        });
        throw invalidCredentialsError();

      case 'invalid':
        this.audit.warn('login.challenge.failed', {
          ...base,
          reason:
            outcome.reason === 'wrong_secret' &&
            outcome.attempts === LOGIN_MAX_OTP_ATTEMPTS
              ? 'attempts_exhausted_now'
              : outcome.reason,
          userId: outcome.challenge?.userId,
          attempts: outcome.attempts,
        });
        throw confirmationInvalidError();
    }
  }

  /**
   * Вся проверка — в одной транзакции (спека, шаги 1–8).
   *
   * Шаг 1: «получить user_id без принятия решения, затем заблокировать
   * пользователя и строку попытки именно в этом порядке и перечитать их».
   * Первое чтение без блокировки нужно только чтобы узнать, КОГО блокировать.
   * Решение принимается по второму, заблокированному чтению.
   */
  @Transactional()
  private async confirmInTransaction(
    input: LoginConfirmationInput,
    now: Date,
  ): Promise<ConfirmOutcome> {
    const locked = await this.lockChallenge(input.attemptId, input.kind);
    if (!locked) return { kind: 'invalid', reason: 'not_found' };
    const { user, challenge } = locked;

    // Шаг 2. Погашенные попытки.
    const consumed = consumedOutcome(challenge);
    if (consumed) return consumed;

    // Шаг 3. Просрочка: last_sent_at + 10 минут. Счётчик не трогаем.
    if (now.getTime() >= challengeExpiresAt(challenge).getTime()) {
      return { kind: 'invalid', reason: 'expired', challenge };
    }

    // Шаг 4. Пользователь перестал быть active → гасим попытку, тот же 401.
    if (user?.status !== UserStatus.Active) {
      await this.consume(challenge, Reason.UserInactive, now);
      return { kind: 'user_inactive', challenge };
    }

    // Шаг 5. HMAC присланного секрета, сравнение за постоянное время.
    if (
      !this.secrets.matches(
        challenge.method,
        challenge.id,
        input.secret,
        challenge.secretHash,
      )
    ) {
      // Шаг 7. Неверная ссылка: 400, счётчика нет (секрет 256 бит не перебрать).
      if (challenge.method === ConfirmationMethod.MagicLink) {
        return { kind: 'invalid', reason: 'wrong_secret', challenge };
      }
      // Шаг 6. Неверный OTP: attempts + 1 в этой же транзакции. Пятый
      // неверный ввод ещё даёт 400, но гасит попытку; следующий получит 429.
      const attempts = challenge.attempts + 1;
      const exhausted = attempts >= LOGIN_MAX_OTP_ATTEMPTS;
      await this.challenges.update(
        { id: challenge.id },
        exhausted
          ? {
              attempts,
              consumedAt: now,
              consumedReason: Reason.AttemptsExhausted,
            }
          : { attempts },
      );
      return { kind: 'invalid', reason: 'wrong_secret', challenge, attempts };
    }

    // Шаг 8. Совпало: подписать оба JWT, погасить попытку, COMMIT.
    // Подпись ДО погашения: если она упадёт (503), исключение откатит
    // транзакцию, и пользователь сможет подтвердить ту же попытку ещё раз.
    const tokens = this.tokens.issuePair(challenge.userId);
    await this.consume(challenge, Reason.Confirmed, now);
    return { kind: 'confirmed', challenge, tokens };
  }

  // ───────────────────────────── resend ───────────────────────────────

  /**
   * Повторная отправка (спека 1.2, раздел 1.3.2, «Логика resend»):
   * новый секрет того же способа, новое `last_sent_at` (TTL заново), счётчик
   * с нуля. Старый код или ссылка больше не подходят.
   */
  async resend(attemptId: string): Promise<LoginChallenge> {
    const now = new Date();
    const outcome = await this.resendInTransaction(attemptId, now);
    const base = { attemptId };

    switch (outcome.kind) {
      case 'resent':
        break;
      case 'too_soon':
        return this.failTooSoon(
          'resend',
          outcome.challenge?.userId,
          attemptId,
          outcome.retryAfterSeconds,
        );
      case 'exhausted':
        this.audit.warn('login.resend.failed', {
          ...base,
          reason: 'attempts_exhausted',
        });
        throw attemptsExhaustedError();
      case 'user_inactive':
        this.audit.warn('login.resend.failed', {
          ...base,
          reason: 'user_inactive',
          userId: outcome.challenge?.userId,
        });
        throw invalidCredentialsError();
      case 'invalid':
        this.audit.warn('login.resend.failed', {
          ...base,
          reason: outcome.reason,
          userId: outcome.challenge?.userId,
        });
        throw confirmationInvalidError();
    }

    this.audit.info('login.challenge.resent', {
      attemptId,
      userId: outcome.challenge.userId,
      method: outcome.challenge.method,
    });
    // Шаг 4. Письмо после COMMIT. Если SMTP упадёт (шаг 5), новый хеш уже
    // сохранён, старый секрет не восстанавливается, следующая отправка — через 60 с.
    await this.deliver(
      outcome.email,
      outcome.challenge,
      outcome.secret,
      'resend',
    );
    return outcome.challenge;
  }

  @Transactional()
  private async resendInTransaction(
    attemptId: string,
    now: Date,
  ): Promise<ResendOutcome> {
    // Шаг 1. Тот же порядок блокировок, что у confirm: пользователь → попытка.
    const locked = await this.lockChallenge(attemptId);
    if (!locked) return { kind: 'invalid', reason: 'not_found' };
    const { user, challenge } = locked;

    // Погашенные попытки. Просрочка (TTL) resend НЕ запрещает: для того
    // resend и нужен, чтобы получить новый код взамен истёкшего.
    const consumed = consumedOutcome(challenge);
    if (consumed) return consumed;

    if (user?.status !== UserStatus.Active) {
      await this.consume(challenge, Reason.UserInactive, now);
      return { kind: 'user_inactive', challenge };
    }

    // Шаг 2. Пауза 60 с от прошлой отправки.
    const left = cooldownLeft(challenge, now);
    if (left > 0)
      return { kind: 'too_soon', retryAfterSeconds: left, challenge };

    // Шаг 3. Новый секрет ТОГО ЖЕ способа одной транзакцией.
    const secret = this.secrets.generate(challenge.method);
    const update = {
      secretHash: this.secrets.hash(challenge.method, challenge.id, secret),
      lastSentAt: now,
      attempts: 0,
    };
    await this.challenges.update({ id: challenge.id }, update);
    return {
      kind: 'resent',
      challenge: { ...challenge, ...update },
      secret,
      email: user.email,
    };
  }

  // ───────────────────────────── общее ────────────────────────────────

  /**
   * Найти попытку и заблокировать «пользователь → попытка» (шаг 1 confirm и resend).
   *
   * `method` (для confirm) — способ из запроса должен совпасть со способом
   * попытки, иначе попытка считается ненайденной (400). Это защита в глубину:
   * ветвление ниже и так идёт по `challenge.method` из БД, поэтому «токен
   * ссылки», присланный к OTP-попытке, засчитался бы как неверный OTP и
   * увеличил бы `attempts`. Фильтр делает правило явным: если код позже
   * изменят и начнут ветвиться по способу ИЗ ЗАПРОСА (у ссылки счётчика нет),
   * обхода лимита в 5 вводов всё равно не будет.
   */
  private async lockChallenge(
    attemptId: string,
    method?: ConfirmationMethod,
  ): Promise<{
    user: Pick<User, 'id' | 'status' | 'email'> | null;
    challenge: LoginChallenge;
  } | null> {
    const ref = await this.challenges.findOne({
      select: { id: true, userId: true },
      where: method ? { id: attemptId, method } : { id: attemptId },
    });
    if (!ref) return null;

    const user = await this.users.lockForAuth(ref.userId);
    const challenge = await this.challenges.findOne({
      where: { id: ref.id },
      lock: { mode: 'pessimistic_write' },
    });
    return challenge ? { user, challenge } : null;
  }

  private async consume(
    challenge: LoginChallenge,
    reason: Reason,
    now: Date,
  ): Promise<void> {
    await this.challenges.update(
      { id: challenge.id },
      { consumedAt: now, consumedReason: reason },
    );
  }

  /** 429 до конца паузы 60 с (login шаг 6 или resend шаг 2). */
  private failTooSoon(
    trigger: 'login' | 'resend',
    userId: string | undefined,
    attemptId: string | undefined,
    retryAfterSeconds: number,
  ): never {
    this.audit.warn(
      trigger === 'login' ? 'login.failed' : 'login.resend.failed',
      {
        reason: 'resend_too_soon',
        userId,
        attemptId,
        retryAfterSeconds,
      },
    );
    throw resendTooSoonError(retryAfterSeconds);
  }

  /**
   * Отправка письма с кодом или ссылкой. Секрет живёт только в памяти этого
   * запроса и в письме: в БД — HMAC, в ответ и в журнал он не попадает.
   *
   * Сбой SMTP → 503 `mail_delivery_failed`. В теле — то, что нужно клиенту для
   * продолжения, но не секрет (спека 1.2, раздел 1.3.1): `attemptId`, `method`,
   * `retryAfterSeconds` (через сколько можно resend), а для login ещё и
   * `confirmationRequired`. Повтор возможен только через 60 секунд: если SMTP
   * «лежит», клиент не засыплет его запросами.
   */
  private async deliver(
    email: string,
    challenge: Pick<LoginChallenge, 'id' | 'userId' | 'method'>,
    secret: string,
    trigger: 'login' | 'resend',
  ): Promise<void> {
    const fields = {
      userId: challenge.userId,
      attemptId: challenge.id,
      method: challenge.method,
      trigger,
    };
    try {
      await this.mail.send(
        buildLoginMail(
          email,
          challenge.method,
          challenge.id,
          secret,
          this.settings.confirmUrl,
        ),
      );
    } catch (error: unknown) {
      // Только ожидаемый сбой доставки → 503. Остальное — баг (500).
      if (!(error instanceof MailDeliveryError)) throw error;
      this.audit.warn('login.challenge.send_failed', fields);
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'mail_delivery_failed',
        'Confirmation email could not be sent, request a new one later',
        {
          ...(trigger === 'login' ? { confirmationRequired: true } : {}),
          method: challenge.method,
          attemptId: challenge.id,
          retryAfterSeconds: LOGIN_RESEND_COOLDOWN_SECONDS,
        },
      );
    }
    this.audit.info('login.challenge.sent', fields);
  }
}

/**
 * Исход для уже погашенной попытки (шаг 2 confirm, шаг 1 resend):
 * - `attempts_exhausted` → 429. CHECK в БД гарантирует, что у такой попытки
 *   `attempts = 5` (спека: «attempts уже равно 5 и consumed_reason равно
 *   attempts_exhausted»);
 * - `confirmed`, `replaced`, `user_inactive` → общий 400.
 */
function consumedOutcome(
  challenge: LoginChallenge,
): Exhausted | Invalid | null {
  switch (challenge.consumedReason) {
    case null:
      return null;
    case Reason.AttemptsExhausted:
      return { kind: 'exhausted', challenge };
    default:
      return { kind: 'invalid', reason: challenge.consumedReason, challenge };
  }
}
