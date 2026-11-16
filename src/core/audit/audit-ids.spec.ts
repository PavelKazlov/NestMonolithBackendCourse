import { ConfigService } from '@/core/config/config.service';
import { AuditIds } from './audit-ids';

describe('AuditIds', () => {
  const idsWith = (key: string) =>
    new AuditIds({ get: () => key } as unknown as ConfigService);

  it('один email — один id; разные email — разные id; адреса в id нет', () => {
    const ids = idsWith('k'.repeat(40));
    const id = ids.emailId('user@example.com');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(ids.emailId('user@example.com')).toBe(id);
    expect(ids.emailId('other@example.com')).not.toBe(id);
    expect(id).not.toContain('user');
  });

  it('id зависит от ключа: без ключа словарём не перебрать', () => {
    expect(idsWith('k'.repeat(40)).emailId('a@b.co')).not.toBe(
      idsWith('z'.repeat(40)).emailId('a@b.co'),
    );
  });
});
