/**
 * POST /api/view-session/create
 * Founder-only: Create short-lived view session URL (testing/debugging).
 * Requires dashboard session. Calls wa-hub POST /instances/:id/view-session.
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
  const instanceId = body.instanceId;
  const dashboardBaseUrl =
    body.dashboardBaseUrl ??
    process.env.DASHBOARD_WEBHOOK_PUBLIC_URL?.replace(/\/api\/wahub\/webhook.*$/, '') ??
    request.nextUrl.origin;
  if (!instanceId || typeof instanceId !== 'string') {
    return NextResponse.json({ error: 'instanceId is required' }, { status: 400 });
  }
  try {
    const res = await fetch(`${BASE.replace(/\/$/, '')}/instances/${encodeURIComponent(instanceId)}/view-session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ dashboardBaseUrl }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (json as { error?: string }).error ?? (json as { message?: string }).message;
      return NextResponse.json({ error: err ?? 'Request failed' }, { status: res.status });
    }
    return NextResponse.json({ data: json });
  } catch (err) {
    return NextResponse.json(
      { error: 'wa-hub request failed', message: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
