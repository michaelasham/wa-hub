import { NextResponse } from 'next/server';
import { validateSession, isAuthEnabled } from '@/lib/auth';

export async function GET() {
  if (!isAuthEnabled()) {
    return NextResponse.json({ ok: true, authenticated: false });
  }
  const valid = await validateSession();
  return NextResponse.json({ ok: true, authenticated: valid });
}
