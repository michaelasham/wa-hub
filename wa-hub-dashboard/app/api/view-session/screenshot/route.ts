/**
 * GET /api/view-session/screenshot?token=xxx
 * Founder-only: Returns PNG screenshot for valid view session token.
 * Proxies to wa-hub. Requires dashboard session.
 */
import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/auth';
import { isAuthEnabled } from '@/lib/auth';

const BASE = process.env.WA_HUB_BASE_URL ?? 'http://localhost:3000';
const TOKEN = process.env.WA_HUB_TOKEN ?? '';

export async function GET(request: NextRequest) {
  if (isAuthEnabled() && !(await validateSession())) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    return new NextResponse('token required', { status: 400 });
  }
  try {
    const res = await fetch(`${BASE.replace(/\/$/, '')}/view-session/screenshot?token=${encodeURIComponent(token)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) {
      return new NextResponse(res.status === 404 ? 'View session expired or invalid' : 'Error', {
        status: res.status,
      });
    }
    const buffer = await res.arrayBuffer();
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return new NextResponse('Request failed', { status: 502 });
  }
}
