/**
 * GET /api/system/status
 * Proxies to wa-hub GET /system/status (or /__debug/system).
 * Adds ADMIN_DEBUG_SECRET header when set (server-side only).
 */

import { NextResponse } from 'next/server';
import { validateSession, isAuthEnabled } from '@/lib/auth';

const BASE = process.env.WA_HUB_BASE_URL ?? 'http://localhost:3000';
const TOKEN = process.env.WA_HUB_TOKEN ?? '';
const ADMIN_SECRET = process.env.ADMIN_DEBUG_SECRET ?? '';

export async function GET() {
  if (isAuthEnabled() && !(await validateSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const url = `${BASE.replace(/\/$/, '')}/system/status`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
  };
  if (ADMIN_SECRET) {
    headers['X-Admin-Debug-Secret'] = ADMIN_SECRET;
  }
  try {
    const res = await fetch(url, { headers, next: { revalidate: 0 } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: 'System status unavailable', message: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
