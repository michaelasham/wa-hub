'use client';

import { useState, useEffect, useCallback } from 'react';
import { waHubRequest } from '@/lib/wahubClient';

export interface WaHubInstance {
  id: string;
  name: string;
  status: string;
  phoneNumber?: string;
}

export function useWaHubReachable() {
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/wahub/health')
      .then((r) => r.ok)
      .then(setReachable)
      .catch(() => setReachable(false));
  }, []);

  return reachable;
}

export function useInstances() {
  const [instances, setInstances] = useState<WaHubInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await waHubRequest<WaHubInstance[]>({ method: 'GET', path: '/instances' });
    if (res.ok && Array.isArray(res.data)) {
      setInstances(res.data);
    } else {
      setError(res.error ?? 'Failed to fetch instances');
      setInstances([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { instances, loading, error, refresh };
}
