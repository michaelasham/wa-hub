/**
 * POST /api/system/force-normal
 * Proxies to wa-hub POST /system/force-normal to cancel low power mode.
 * Same auth as GET /api/system/status.
 */

import { NextResponse } from 'next/server';
import { validateSession, isAuthEnabled } from '@/lib/auth';

const BASE = process.env.WA_HUB_BASE_URL ?? 'http://localhost:3000';
const TOKEN = process.env.WA_HUB_TOKEN ?? '';
const ADMIN_SECRET = process.env.ADMIN_DEBUG_SECRET ?? '';

export async function POST() {
  if (isAuthEnabled() && !(await validateSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const url = `${BASE.replace(/\/$/, '')}/system/force-normal`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };
  if (ADMIN_SECRET) {
    headers['X-Admin-Debug-Secret'] = ADMIN_SECRET;
  }
  try {
    const res = await fetch(url, { method: 'POST', headers, body: '{}' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to cancel low power mode', message: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
