'use client';

import { useEffect, useState, useCallback } from 'react';

export interface SseEvent {
  type: string;
  data: unknown;
}

export type SseScope = 'instance' | 'global';

export function useSSE(instanceId?: string, scope: SseScope = 'instance') {
  const [events, setEvents] = useState<SseEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams();
    if (instanceId) params.set('instanceId', instanceId);
    if (scope === 'global') params.set('scope', 'global');
    const url = `/api/stream${params.toString() ? '?' + params.toString() : ''}`;
    const es = new EventSource(url);

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as SseEvent;
        setEvents((prev) => [ev, ...prev].slice(0, 500));
      } catch {}
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, [instanceId, scope]);

  const clear = useCallback(() => setEvents([]), []);

  return { events, connected, clear };
}
