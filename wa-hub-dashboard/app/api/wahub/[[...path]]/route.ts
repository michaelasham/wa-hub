import { NextRequest, NextResponse } from 'next/server';
import { addApiLog, broadcastSse } from '@/lib/store';

const BASE = process.env.WA_HUB_BASE_URL ?? 'http://localhost:3000';
const TOKEN = process.env.WA_HUB_TOKEN ?? '';

function extractInstanceId(path: string): string | null {
  const match = path.match(/^\/instances\/([^/]+)/);
  return match ? match[1] : null;
}

async function proxyRequest(req: NextRequest, pathSegments: string[]) {
  const path = '/' + pathSegments.join('/');
  const instanceId = extractInstanceId(path);
  const method = req.method as 'GET' | 'POST' | 'PUT' | 'DELETE';
  const url = `${BASE.replace(/\/$/, '')}${path}`;

  const start = Date.now();
  let requestBody: unknown = undefined;
  let bodyText: string | undefined;
  if (req.body && (method === 'POST' || method === 'PUT')) {
    bodyText = await req.text();
    try {
      requestBody = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      requestBody = bodyText ?? null;
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
  };
  if (bodyText) {
    headers['Content-Type'] = 'application/json';
  }

  let statusCode: number | null = 0;
  let responseBody: unknown = null;
  let res: Response;

  try {
    res = await fetch(url, {
      method,
      headers,
      body: bodyText ?? undefined,
    });
    statusCode = res.status;
    const text = await res.text();
    try {
      responseBody = text ? JSON.parse(text) : null;
    } catch {
      responseBody = { raw: text.slice(0, 500) };
    }

    const latencyMs = Date.now() - start;
    const log = addApiLog({
      timestamp: new Date().toISOString(),
      method,
      path,
      statusCode,
      latencyMs,
      requestBody,
      responseBody,
      instanceId,
    });
    broadcastSse({ type: 'apiLog', data: log });

    return NextResponse.json(responseBody, { status: res.status });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    statusCode = null;
    const latencyMs = Date.now() - start;
    const log = addApiLog({
      timestamp: new Date().toISOString(),
      method,
      path,
      statusCode: 0,
      latencyMs,
      requestBody,
      responseBody: { error },
      instanceId,
      error,
    });
    broadcastSse({ type: 'apiLog', data: log });
    return NextResponse.json(
      { error: 'wa-hub request failed', message: error },
      { status: 502 }
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path ?? []);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path ?? []);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path ?? []);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path ?? []);
}
