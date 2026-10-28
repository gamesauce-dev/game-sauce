import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// scrypt parameters. N=2^15 with r=8 needs 32 MB per hash — enough work to make
// offline cracking expensive, fast enough (about 50 ms) for an interactive login.
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * 1024 * 1024;

/** "scrypt$N$r$p$salt$hash" — the parameters travel with the hash, so they can be
 *  raised later without invalidating existing passwords. */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');

  let actual;
  try {
    actual = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Hash a session/reset token before storing it, so a database leak does not leak logins. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function passwordProblems(password) {
  const problems = [];
  if (typeof password !== 'string') return ['Password is required'];
  if (password.length < 10) problems.push('at least 10 characters');
  if (!/[a-zA-Z]/.test(password)) problems.push('a letter');
  if (!/[0-9]/.test(password)) problems.push('a number');
  return problems;
}
