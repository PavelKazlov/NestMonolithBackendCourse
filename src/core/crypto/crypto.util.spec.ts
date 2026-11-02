import {
  generateHex,
  generateOtp,
  generateToken,
  hmacSha256,
  safeEqual,
} from './crypto.util';

describe('crypto.util', () => {
  it('hmacSha256 детерминирован и зависит от ключа', () => {
    const a = hmacSha256('key-1', '123456');

    expect(a).toHaveLength(32);
    expect(hmacSha256('key-1', '123456').equals(a)).toBe(true);
    expect(hmacSha256('key-2', '123456').equals(a)).toBe(false);
  });

  it('safeEqual сравнивает содержимое и не падает на разной длине', () => {
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false);
  });

  it('generateOtp: ровно 6 цифр с ведущими нулями', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateOtp()).toMatch(/^\d{6}$/);
    }
  });

  it('generateToken: 32 байта в base64url (43 символа без padding)', () => {
    expect(generateToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('generateHex: 16 байт = 32 hex-символа', () => {
    expect(generateHex()).toMatch(/^[0-9a-f]{32}$/);
  });
});
