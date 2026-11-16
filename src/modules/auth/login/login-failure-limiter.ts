import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import {
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_SECONDS,
} from './login.constants';

interface FailureWindow {
  count: number;
  /** Когда окно закрывается (мс с эпохи). */
  resetAt: number;
}

/**
 * Лимит неуспешных входов: «не более 5 неуспешных проверок на пару email и IP
 * за 15 минут» (спека 1.2, раздел 1.6).
 *
 * Почему не @nestjs/throttler. Throttler считает КАЖДЫЙ запрос ещё в guard,
 * до проверки пароля. Здесь же считаются только НЕУСПЕШНЫЕ проверки, а
 * узнать результат можно только после сравнения хеша. Поэтому свой счётчик:
 * - `check` вызывается ДО дорогой проверки хеша: заблокированная пара не
 *   тратит CPU на Argon2;
 * - `recordFailure` — после 401.
 *
 * Почему пара «email + IP», а не только email. Лимит только по email позволил
 * бы любому заблокировать вход чужому аккаунту, просто вводя неверный пароль
 * (спека: «постоянная блокировка аккаунта ... не используется»). Владелец
 * с другого IP войдёт спокойно. От перебора с одного IP по многим адресам
 * защищает второй лимит: 30 запросов login с IP в минуту (throttler).
 *
 * Фиксированное окно: первая ошибка открывает окно на 15 минут, пятая
 * ошибка в нём блокирует пару до конца окна. Успешный вход счётчик НЕ
 * сбрасывает: спека ограничивает число неуспешных проверок за окно, и
 * успешный вход между ними этого числа не меняет.
 *
 * Ключ — служебный HMAC email, а не сам адрес (см. AuditIds): email в
 * открытом виде не хранится даже в памяти процесса дольше запроса.
 *
 * Хранилище — память процесса, как и у throttler. При нескольких экземплярах
 * приложения счётчики нужно вынести в общее хранилище (Redis), иначе
 * фактический лимит умножится на число экземпляров.
 */
@Injectable()
export class LoginFailureLimiter {
  private readonly windows = new Map<string, FailureWindow>();

  /** Сколько секунд ждать, если пара уже заблокирована; иначе `null`. */
  check(key: string, now = Date.now()): number | null {
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) return null;
    if (window.count < LOGIN_FAILURE_LIMIT) return null;
    return Math.max(1, Math.ceil((window.resetAt - now) / 1000));
  }

  recordFailure(key: string, now = Date.now()): void {
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      this.windows.set(key, {
        count: 1,
        resetAt: now + LOGIN_FAILURE_WINDOW_SECONDS * 1000,
      });
      return;
    }
    window.count += 1;
  }

  /**
   * Раз в минуту удаляем закрытые окна. Без этого атака по миллиону разных
   * email наполнила бы Map записями, которые уже ничего не значат, и память
   * росла бы без предела.
   */
  @Interval(60_000)
  prune(now = Date.now()): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }

  /** Для тестов: сколько ключей сейчас хранится. */
  get size(): number {
    return this.windows.size;
  }
}
