/**
 * Optional email allowlist for /ops (Firebase Auth). No config import — used by firebase-ops-auth
 * and unit tests without loading process.env.
 */
export function isEmailInOpsAllowlist(email: string | undefined, allowlist: string[]): boolean {
  if (!email) return false;
  if (allowlist.length === 0) return true;
  const norm = email.trim().toLowerCase();
  return allowlist.some((e) => e.trim().toLowerCase() === norm);
}
