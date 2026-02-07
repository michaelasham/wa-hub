import { NextRequest, NextResponse } from 'next/server';
import { checkPassword, isAuthEnabled, createSession, setSessionCookie } from '@/lib/auth';

export async function POST(request: NextRequest) {
  if (!isAuthEnabled()) {
    return NextResponse.json({ ok: true, message: 'Auth disabled' });
  }

  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const password = body.password ?? '';
  if (!checkPassword(password)) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }

  const token = await createSession();
  await setSessionCookie(token);

  return NextResponse.json({ ok: true });
}
