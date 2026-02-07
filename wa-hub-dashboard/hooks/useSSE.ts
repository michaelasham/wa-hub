'use client';

import { useEffect, useState, useCallback } from 'react';

export interface SseEvent {
  type: string;
  data: unknown;
}

export function useSSE(instanceId?: string) {
  const [events, setEvents] = useState<SseEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const url = instanceId
      ? `/api/stream?instanceId=${encodeURIComponent(instanceId)}`
      : '/api/stream';
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
  }, [instanceId]);

  const clear = useCallback(() => setEvents([]), []);

  return { events, connected, clear };
}
