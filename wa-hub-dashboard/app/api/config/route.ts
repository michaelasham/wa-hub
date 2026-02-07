import { NextResponse } from 'next/server';

export async function GET() {
  const webhookUrl =
    process.env.DASHBOARD_WEBHOOK_PUBLIC_URL ??
    (typeof process.env.VERCEL_URL !== 'undefined'
      ? `https://${process.env.VERCEL_URL}/api/wahub/webhook`
      : 'http://localhost:3000/api/wahub/webhook');
  return NextResponse.json({ webhookUrl });
}
