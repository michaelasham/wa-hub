/**
 * POST /api/view-session/revoke
 * Founder-only: Revoke view session token (stops server from accepting further screenshot requests).
 */
import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/auth';
import { isAuthEnabled } from '@/lib/auth';

const BASE = process.env.WA_HUB_BASE_URL ?? 'http://localhost:3000';
const TOKEN = process.env.WA_HUB_TOKEN ?? '';

export async function POST(request: NextRequest) {
  if (isAuthEnabled() && !(await validateSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const token = (body as { token?: string }).token ?? request.nextUrl.searchParams.get('token');
  if (!token) {
    return NextResponse.json({ error: 'token required' }, { status: 400 });
  }
  try {
    const res = await fetch(`${BASE.replace(/\/$/, '')}/view-session/revoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });
    const json = await res.json().catch(() => ({}));
    return NextResponse.json(json, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: 'wa-hub request failed', message: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
