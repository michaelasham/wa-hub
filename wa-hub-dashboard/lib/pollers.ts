/**
 * Server-side polling for status and QR.
 * Stores active pollers in memory.
 */

const activePollers = new Map<string, NodeJS.Timeout>();

export function startStatusPoll(
  instanceId: string,
  onTick: () => Promise<void>,
  intervalMs: number
): void {
  stopPoll(instanceId, 'status');
  const key = `${instanceId}:status`;
  const id = setInterval(() => onTick(), intervalMs);
  activePollers.set(key, id);
}

export function startQrPoll(
  instanceId: string,
  onTick: () => Promise<boolean>,
  intervalMs: number,
  maxAttempts: number
): void {
  stopPoll(instanceId, 'qr');
  const key = `${instanceId}:qr`;
  let attempts = 0;
  const id = setInterval(async () => {
    attempts++;
    const shouldStop = await onTick();
    if (shouldStop || attempts >= maxAttempts) {
      stopPoll(instanceId, 'qr');
    }
  }, intervalMs);
  activePollers.set(key, id);
}

export function stopPoll(instanceId: string, type: 'status' | 'qr'): void {
  const key = `${instanceId}:${type}`;
  const id = activePollers.get(key);
  if (id) {
    clearInterval(id);
    activePollers.delete(key);
  }
}

export function stopAllPollsForInstance(instanceId: string): void {
  stopPoll(instanceId, 'status');
  stopPoll(instanceId, 'qr');
}

export function isPolling(instanceId: string, type: 'status' | 'qr'): boolean {
  const key = `${instanceId}:${type}`;
  return activePollers.has(key);
}
