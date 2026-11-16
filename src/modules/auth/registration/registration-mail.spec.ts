import { ConfirmationMethod } from './registration-challenge.entity';
import { buildConfirmationMail, buildMagicLink } from './registration-mail';

describe('registration-mail', () => {
  const url = 'http://localhost:5174/register/confirm';

  it('OTP-письмо содержит код и срок действия', () => {
    const mail = buildConfirmationMail(
      'user@example.com',
      ConfirmationMethod.Otp,
      '042917',
      url,
    );

    expect(mail.to).toBe('user@example.com');
    expect(mail.text).toContain('042917');
    expect(mail.text).toContain('10 минут');
    expect(mail.text).not.toContain(url);
  });

  it('magic link кладёт токен во фрагмент, а не в query', () => {
    const link = buildMagicLink(url, 'abc_DEF-123');

    expect(link).toBe(`${url}#token=abc_DEF-123`);
    expect(link).not.toContain('?');
  });

  it('письмо со ссылкой содержит ссылку с токеном', () => {
    const mail = buildConfirmationMail(
      'user@example.com',
      ConfirmationMethod.MagicLink,
      'tok',
      url,
    );

    expect(mail.text).toContain(`${url}#token=tok`);
  });
});
