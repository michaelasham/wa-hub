'use client';

import { useState, useEffect, useCallback } from 'react';

const POLL_MS = 1000;

export interface SystemStatusInstance {
  id: string;
  state: string;
  cpuPercent?: number;
  memoryMB?: number;
}

export interface SystemStatusData {
  mode: 'normal' | 'syncing';
  since: string | null;
  syncingInstanceId: string | null;
  queuedOutboundCount: number;
  queuedOutboundByInstance: Record<string, number>;
  inboundBufferCount: number;
  instances: SystemStatusInstance[];
  perInstanceStates?: SystemStatusInstance[];
}

export function useSystemStatus() {
  const [data, setData] = useState<SystemStatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/system/status', { credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error ?? 'System status unavailable');
        setData(null);
        return;
      }
      setError(null);
      setData({
        mode: json.mode ?? 'normal',
        since: json.since ?? null,
        syncingInstanceId: json.syncingInstanceId ?? null,
        queuedOutboundCount: Number(json.queuedOutboundCount) || 0,
        queuedOutboundByInstance: json.queuedOutboundByInstance ?? {},
        inboundBufferCount: Number(json.inboundBufferCount) || 0,
        instances: json.instances ?? json.perInstanceStates ?? [],
        perInstanceStates: json.perInstanceStates ?? json.instances ?? [],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'System status unavailable');
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, POLL_MS);
    return () => clearInterval(id);
  }, [fetchStatus]);

  return { data, error, isLoading };
}

/** Format ISO since date as mm:ss duration from now. */
export function formatSinceDuration(sinceIso: string | null): string {
  if (!sinceIso) return '—';
  const since = new Date(sinceIso).getTime();
  const now = Date.now();
  const totalSeconds = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Display label for backend instance state. */
export function instanceStateLabel(state: string): string {
  switch (state) {
    case 'CONNECTING':
      return 'SYNCING';
    case 'NEEDS_QR':
      return 'WAITING_FOR_QR';
    case 'ERROR':
    case 'RESTRICTED':
      return 'FAILED';
    default:
      return state || '—';
  }
}
