import { isEmailInOpsAllowlist } from '../src/ops-email-allowlist';

describe('isEmailInOpsAllowlist', () => {
  it('allows any email when allowlist is empty', () => {
    expect(isEmailInOpsAllowlist('a@b.com', [])).toBe(true);
  });

  it('rejects missing email when allowlist is non-empty', () => {
    expect(isEmailInOpsAllowlist(undefined, ['a@b.com'])).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(isEmailInOpsAllowlist('User@gmail.com', ['user@gmail.com'])).toBe(true);
  });

  it('rejects when not in list', () => {
    expect(isEmailInOpsAllowlist('x@y.com', ['a@b.com'])).toBe(false);
  });
});
