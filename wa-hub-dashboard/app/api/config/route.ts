import { NextResponse } from 'next/server';

export async function GET() {
  // Same-server: use localhost to avoid 401 (wa-hub -> dashboard on same VM)
  const internalUrl = process.env.DASHBOARD_WEBHOOK_INTERNAL_URL;
  const publicUrl =
    process.env.DASHBOARD_WEBHOOK_PUBLIC_URL ??
    (typeof process.env.VERCEL_URL !== 'undefined'
      ? `https://${process.env.VERCEL_URL}/api/wahub/webhook`
      : 'http://localhost:3000/api/wahub/webhook');
  const webhookUrl = internalUrl ?? publicUrl;
  return NextResponse.json({ webhookUrl, internalUrl: internalUrl ?? null });
}
