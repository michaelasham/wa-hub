import { NextResponse } from 'next/server';

/**
 * Public reachability check - no auth. Use to verify dashboard is reachable from your network.
 * GET /api/ping -> 200 { ok: true }
 */
export async function GET() {
  return NextResponse.json({ ok: true }, { status: 200 });
}
