import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isAuthEnabled } from './lib/auth-edge';

const COOKIE_NAME = 'wa-hub-dashboard-session';

const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/auth/check', '/api/wahub/webhook'];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

/**
 * Middleware only checks cookie existence. Session verification runs in Node (layout)
 * so DASHBOARD_SESSION_SECRET is available at runtime (Edge gets env at build time).
 */
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

  return NextResponse.next();
}

export const config = {
  // Exclude webhook - must be fully public for wa-hub server-to-server POSTs (no cookies)
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/wahub/webhook|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
