import { ConfigService } from '@/core/config/config.service';
import { ChallengeSecrets } from './challenge-secrets';
import { ConfirmationMethod } from './registration-challenge.entity';

describe('ChallengeSecrets', () => {
  const config = {
    get: () => 'k'.repeat(48),
  } as unknown as ConfigService;
  const secrets = new ChallengeSecrets(config);
  const attemptId = '2b3f0549-d5b1-4ec1-a3e0-ead23328718d';

  it('OTP — 6 цифр, токен — 43 символа base64url (32 байта)', () => {
    expect(secrets.generate(ConfirmationMethod.Otp)).toMatch(/^\d{6}$/);
    expect(secrets.generate(ConfirmationMethod.MagicLink)).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  });

  it('HMAC — 32 байта и не содержит секрет', () => {
    const hash = secrets.hash(ConfirmationMethod.Otp, attemptId, '123456');

    expect(hash).toHaveLength(32);
    expect(hash.toString('utf8')).not.toContain('123456');
  });

  it('одинаковый код в разных попытках даёт разные хеши', () => {
    const a = secrets.hash(ConfirmationMethod.Otp, attemptId, '123456');
    const b = secrets.hash(
      ConfirmationMethod.Otp,
      '00000000-0000-4000-8000-000000000000',
      '123456',
    );

    expect(a.equals(b)).toBe(false);
  });

  it('домены разделены: OTP и magic link с одной строкой не совпадают', () => {
    const otp = secrets.hash(ConfirmationMethod.Otp, attemptId, '123456');
    const link = secrets.hashToken('123456');

    expect(otp.equals(link)).toBe(false);
  });

  it('хеш magic link не зависит от attemptId (поиск идёт по нему)', () => {
    const token = secrets.generate(ConfirmationMethod.MagicLink);

    expect(
      secrets.hash(ConfirmationMethod.MagicLink, attemptId, token),
    ).toEqual(secrets.hashToken(token));
  });

  it('другой ключ — другой HMAC', () => {
    const other = new ChallengeSecrets({
      get: () => 'z'.repeat(48),
    } as unknown as ConfigService);

    expect(other.hash(ConfirmationMethod.Otp, attemptId, '123456')).not.toEqual(
      secrets.hash(ConfirmationMethod.Otp, attemptId, '123456'),
    );
  });

  it('matches: верный секрет — true, неверный — false', () => {
    const stored = secrets.hash(ConfirmationMethod.Otp, attemptId, '123456');

    expect(
      secrets.matches(ConfirmationMethod.Otp, attemptId, '123456', stored),
    ).toBe(true);
    expect(
      secrets.matches(ConfirmationMethod.Otp, attemptId, '654321', stored),
    ).toBe(false);
  });
});
