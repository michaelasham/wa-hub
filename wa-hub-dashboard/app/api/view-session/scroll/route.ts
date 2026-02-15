/**
 * POST /api/view-session/scroll
 * Inject scroll at viewport coordinates (interactive view).
 * Requires session. Proxies to wa-hub POST /view-session/scroll.
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
  const { token, x, y, deltaY = 0 } = body;
  if (!token || x == null || y == null) {
    return NextResponse.json({ error: 'token, x, and y are required' }, { status: 400 });
  }
  try {
    const res = await fetch(`${BASE.replace(/\/$/, '')}/view-session/scroll`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token, x: Number(x), y: Number(y), deltaY: Number(deltaY) }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (json as { error?: string }).error ?? (json as { message?: string }).message;
      return NextResponse.json({ error: err ?? 'Scroll failed' }, { status: res.status });
    }
    return NextResponse.json(json);
  } catch (err) {
    return NextResponse.json(
      { error: 'wa-hub request failed', message: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
