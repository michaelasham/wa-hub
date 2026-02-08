/**
 * In-memory store for wa-hub dashboard.
 * Structured for easy swap to SQLite/Prisma later.
 */

export type LifecycleRank = 0 | 1 | 2 | 3;
// 0: disconnected/auth_failure
// 1: needs_qr
// 2: syncing (authenticated)
// 3: active (ready)

export interface InstanceMeta {
  id: string;
  name: string;
  createdAt: string;
  webhookUrl: string;
  events: string[];
  lifecycleRank: LifecycleRank;
  waStatus: string | null;
  lastClientStatus: Record<string, unknown> | null;
  lastMe: Record<string, unknown> | null;
  lastQrBase64: string | null;
  errorsCount: number;
  lastEventAt: string | null;
  lastQrClassification: 'WAITING_FOR_QR' | 'INSTANCE_NOT_FOUND' | 'READY' | null;
  lastQrError: string | null;
}

export interface WebhookEvent {
  id: string;
  timestamp: string;
  instanceId: string | null;
  event: string;
  payload: Record<string, unknown>;
  signatureValid: boolean | null;
  summary: string;
}

export interface ApiLogEntry {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  statusCode: number | null;
  latencyMs: number;
  requestBody: unknown;
  responseBody: unknown;
  instanceId: string | null;
  error?: string;
}

export type SseEvent =
  | { type: 'webhook'; data: WebhookEvent }
  | { type: 'apiLog'; data: ApiLogEntry }
  | { type: 'status'; data: { instanceId: string; status: unknown } }
  | { type: 'qr'; data: { instanceId: string; qr: string | null; classification: string; error?: string } }
  | { type: 'polling'; data: { instanceId: string; type: string; state: string } };

const MAX_WEBHOOK_EVENTS = 5000;
const MAX_API_LOGS = 5000;

function capArray<T>(arr: T[], max: number): T[] {
  return arr.length > max ? arr.slice(0, max) : arr;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// --- Store state ---
const instancesMeta = new Map<string, InstanceMeta>();
const webhookEvents: WebhookEvent[] = [];
const apiLogs: ApiLogEntry[] = [];

// --- SSE subscribers ---
const sseSubscribers = new Set<(event: SseEvent) => void>();

export function getInstancesMeta(): InstanceMeta[] {
  return Array.from(instancesMeta.values());
}

export function getInstanceMeta(id: string): InstanceMeta | null {
  return instancesMeta.get(id) ?? null;
}

export function setInstanceMeta(id: string, meta: Partial<InstanceMeta>): InstanceMeta {
  const existing = instancesMeta.get(id);
  const merged: InstanceMeta = {
    id,
    name: meta.name ?? existing?.name ?? id,
    createdAt: meta.createdAt ?? existing?.createdAt ?? new Date().toISOString(),
    webhookUrl: meta.webhookUrl ?? existing?.webhookUrl ?? '',
    events: meta.events ?? existing?.events ?? [],
    lifecycleRank: meta.lifecycleRank ?? existing?.lifecycleRank ?? 0,
    waStatus: meta.waStatus ?? existing?.waStatus ?? null,
    lastClientStatus: meta.lastClientStatus ?? existing?.lastClientStatus ?? null,
    lastMe: meta.lastMe ?? existing?.lastMe ?? null,
    lastQrBase64: meta.lastQrBase64 ?? existing?.lastQrBase64 ?? null,
    errorsCount: meta.errorsCount ?? existing?.errorsCount ?? 0,
    lastEventAt: meta.lastEventAt ?? existing?.lastEventAt ?? null,
    lastQrClassification: meta.lastQrClassification ?? existing?.lastQrClassification ?? null,
    lastQrError: meta.lastQrError ?? existing?.lastQrError ?? null,
  };
  instancesMeta.set(id, merged);
  return merged;
}

export function removeInstanceMeta(id: string): void {
  instancesMeta.delete(id);
}

export function addWebhookEvent(event: Omit<WebhookEvent, 'id'>): WebhookEvent {
  const e: WebhookEvent = { ...event, id: generateId() };
  webhookEvents.unshift(e);
  const capped = capArray(webhookEvents, MAX_WEBHOOK_EVENTS);
  webhookEvents.length = 0;
  webhookEvents.push(...capped);
  return e;
}

export function getWebhookEvents(instanceId?: string): WebhookEvent[] {
  if (instanceId) {
    return webhookEvents.filter((e) => e.instanceId === instanceId);
  }
  return [...webhookEvents];
}

export function addApiLog(entry: Omit<ApiLogEntry, 'id'>): ApiLogEntry {
  const e: ApiLogEntry = { ...entry, id: generateId() };
  apiLogs.unshift(e);
  const capped = capArray(apiLogs, MAX_API_LOGS);
  apiLogs.length = 0;
  apiLogs.push(...capped);
  return e;
}

export function getApiLogs(instanceId?: string): ApiLogEntry[] {
  if (instanceId) {
    return apiLogs.filter((e) => e.instanceId === instanceId);
  }
  return [...apiLogs];
}

export function subscribeSse(cb: (event: SseEvent) => void): () => void {
  sseSubscribers.add(cb);
  return () => sseSubscribers.delete(cb);
}

export function broadcastSse(event: SseEvent): void {
  sseSubscribers.forEach((cb) => {
    try {
      cb(event);
    } catch (err) {
      console.error('SSE subscriber error:', err);
    }
  });
}

export function lifecycleRankFromEvent(
  event: string,
  data?: { status?: string }
): LifecycleRank | null {
  switch (event) {
    case 'ready':
      return 3;
    case 'authenticated':
      return 2;
    case 'qr':
      return 1;
    case 'disconnected':
    case 'auth_failure':
      return 0;
    case 'change_state':
      if (data?.status === 'CONNECTED') return 3;
      return null;
    default:
      return null;
  }
}
