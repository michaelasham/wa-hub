import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isAuthEnabled, verifySessionCookie } from './lib/auth-edge';

const COOKIE_NAME = 'wa-hub-dashboard-session';

const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/auth/check', '/api/wahub/webhook'];
const API_AUTH_PATHS = ['/api/auth/login', '/api/auth/logout', '/api/wahub/webhook'];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!isAuthEnabled()) {
    return NextResponse.next();
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(COOKIE_NAME)?.value;
  if (!cookie) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(loginUrl);
  }

  const valid = await verifySessionCookie(cookie);
  if (!valid) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('from', pathname);
    const res = NextResponse.redirect(loginUrl);
    res.cookies.delete(COOKIE_NAME);
    return res;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
