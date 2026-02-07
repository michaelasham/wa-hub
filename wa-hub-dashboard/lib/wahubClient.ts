/**
 * Proxy client for wa-hub API.
 * All requests go through Next.js API routes to keep token secret.
 */

export interface WaHubRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
}

export interface WaHubResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
  error?: string;
}

/**
 * Call wa-hub via our proxy (keeps token server-side)
 */
export async function waHubRequest<T = unknown>(
  options: WaHubRequestOptions
): Promise<WaHubResponse<T>> {
  const { method, path, body } = options;
  const url = `/api/wahub${path}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: T;
  try {
    data = text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    data = { raw: text } as unknown as T;
  }
  return {
    ok: res.ok,
    status: res.status,
    data,
    error: res.ok ? undefined : (data as { error?: string }).error ?? res.statusText,
  };
}

/**
 * QR 404 classification
 */
export type QrClassification = 'WAITING_FOR_QR' | 'INSTANCE_NOT_FOUND' | 'READY';

export interface QrResult {
  qr: string | null;
  classification: QrClassification;
  error?: string;
  rawResponse?: unknown;
}
