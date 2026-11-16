import { Injectable } from '@nestjs/common';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply } from 'fastify';

import { ConfigService } from '@/core/config/config.service';
import {
  ACCESS_COOKIE,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SECONDS,
} from './token.constants';
import type { TokenPair } from './token.service';

/**
 * Установка и очистка auth-cookies (спека 1.2, разделы 1.3.3 и 1.3.5).
 *
 * Атрибуты собираются в ОДНОМ месте для установки и очистки. Это важно:
 * браузер считает cookie «той же самой», только если совпадают имя, `Domain`
 * и `Path`. Если бы logout очищал `refresh_token` с `Path=/`, а ставили бы его
 * с `Path=/auth/refresh`, браузер создал бы вторую, пустую cookie, а настоящая
 * осталась бы жить (спека: «с теми же Path, Secure, SameSite и отсутствующим
 * Domain, что использовались при установке»).
 *
 * Атрибуты и зачем они:
 * - `HttpOnly` — JavaScript страницы не может прочитать cookie
 *   (`document.cookie`). XSS не украдёт токен, хотя и сможет слать запросы
 *   от имени пользователя, пока открыта страница;
 * - `Secure` — браузер отправляет cookie только по HTTPS;
 * - `SameSite=Strict` — cookie не отправляется в запросах, начатых на другом
 *   site (защита от CSRF). Для frontend на другом site — `None` (вместе с Secure);
 * - `Path` — access нужна всему API (`/`), refresh — только `/auth/refresh`;
 * - `Max-Age` совпадает с временем жизни токена: браузер сам удалит cookie
 *   вместе с истечением `exp`;
 * - `Domain` НЕ ставим: cookie становится host-only и уходит только на
 *   тот же хост, без поддоменов. С `Domain=example.com` её получали бы и все
 *   поддомены, включая скомпрометированный.
 */
@Injectable()
export class AuthCookies {
  private readonly base: CookieSerializeOptions;

  constructor(config: ConfigService) {
    this.base = {
      httpOnly: true,
      secure: true,
      sameSite: config.get('AUTH_COOKIE_SAME_SITE') ?? 'strict',
    };
  }

  /** Обе cookies одним ответом (две строки Set-Cookie). */
  set(reply: FastifyReply, pair: TokenPair): void {
    void reply.setCookie(ACCESS_COOKIE, pair.accessToken, {
      ...this.accessOptions(),
      maxAge: ACCESS_TOKEN_TTL_SECONDS,
    });
    void reply.setCookie(REFRESH_COOKIE, pair.refreshToken, {
      ...this.refreshOptions(),
      maxAge: REFRESH_TOKEN_TTL_SECONDS,
    });
  }

  /**
   * Очистка: та же cookie с пустым значением, `Max-Age=0` и `Expires` в 1970.
   * Браузер, получив уже истёкшую cookie, удаляет свою копию.
   * `clearCookie` из @fastify/cookie сам добавляет `Expires` и `Max-Age=0`.
   */
  clear(reply: FastifyReply): void {
    void reply.clearCookie(ACCESS_COOKIE, this.accessOptions());
    void reply.clearCookie(REFRESH_COOKIE, this.refreshOptions());
  }

  private accessOptions(): CookieSerializeOptions {
    return { ...this.base, path: '/' };
  }

  private refreshOptions(): CookieSerializeOptions {
    return { ...this.base, path: REFRESH_COOKIE_PATH };
  }
}
