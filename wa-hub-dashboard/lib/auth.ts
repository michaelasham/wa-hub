import { cookies } from 'next/headers';
import crypto from 'crypto';

const COOKIE_NAME = 'wa-hub-dashboard-session';
const SESSION_MAX_AGE = 24 * 60 * 60; // 24 hours

function getSecret(): string {
  const s = process.env.DASHBOARD_SESSION_SECRET;
  if (!s) {
    throw new Error('DASHBOARD_SESSION_SECRET is required for auth. Set it in .env');
  }
  return s;
}

function sign(value: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  return `${value}.${hmac.update(value).digest('hex')}`;
}

export function isAuthEnabled(): boolean {
  return !!(process.env.DASHBOARD_PASSWORD && process.env.DASHBOARD_PASSWORD.length > 0);
}

export function checkPassword(password: string): boolean {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) return true; // auth disabled
  if (password.length !== expected.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(password, 'utf8'),
    Buffer.from(expected, 'utf8')
  );
}

export async function createSession(): Promise<string> {
  const secret = getSecret();
  const value = `${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
  return sign(value, secret);
}

export async function validateSession(): Promise<boolean> {
  if (!isAuthEnabled()) return true;
  const cookieStore = await cookies();
  const cookie = cookieStore.get(COOKIE_NAME);
  if (!cookie?.value) return false;
  try {
    const secret = getSecret();
    const i = cookie.value.lastIndexOf('.');
    if (i === -1) return false;
    const value = cookie.value.slice(0, i);
    const expected = sign(value, secret);
    if (!crypto.timingSafeEqual(Buffer.from(cookie.value), Buffer.from(expected)))
      return false;
    const ts = parseInt(value.split('-')[0], 10);
    if (isNaN(ts) || Date.now() - ts > SESSION_MAX_AGE * 1000) return false;
    return true;
  } catch {
    return false;
  }
}

export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}
