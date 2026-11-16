import { ConfigService } from '@/core/config/config.service';
import { AuthCookies } from './auth-cookies';

/** Минимальный reply: запоминает вызовы setCookie/clearCookie. */
function makeReply() {
  return { setCookie: jest.fn(), clearCookie: jest.fn() };
}

const cookiesFor = (sameSite?: 'strict' | 'none') =>
  new AuthCookies({ get: () => sameSite } as unknown as ConfigService);

describe('AuthCookies', () => {
  it('set: атрибуты из спеки 1.3.3, Max-Age = срок токена, без Domain', () => {
    const reply = makeReply();
    cookiesFor('strict').set(reply as never, {
      accessToken: 'A',
      refreshToken: 'R',
    });

    expect(reply.setCookie).toHaveBeenCalledWith('access_token', 'A', {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 900,
    });
    expect(reply.setCookie).toHaveBeenCalledWith('refresh_token', 'R', {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/auth/refresh',
      maxAge: 2592000,
    });
  });

  it('clear: те же Path, Secure, SameSite, HttpOnly, что при установке', () => {
    const reply = makeReply();
    cookiesFor('none').clear(reply as never);

    expect(reply.clearCookie).toHaveBeenCalledWith('access_token', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/',
    });
    expect(reply.clearCookie).toHaveBeenCalledWith('refresh_token', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/auth/refresh',
    });
  });

  it('SameSite по умолчанию — strict', () => {
    const reply = makeReply();
    cookiesFor(undefined).clear(reply as never);
    expect(reply.clearCookie).toHaveBeenCalledWith(
      'access_token',
      expect.objectContaining({ sameSite: 'strict' }),
    );
  });
});
