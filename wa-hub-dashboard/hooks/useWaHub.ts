'use client';

import { useState, useEffect, useCallback } from 'react';
import { waHubRequest } from '@/lib/wahubClient';

export interface HealthData {
  status: string;
  service: string;
  instanceCount?: number;
  cpuPercent?: number;
  loadavg?: number[];
}

export function useHealth(refreshIntervalMs = 10000) {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/wahub/health');
      const data = await res.json();
      if (res.ok) {
        setHealth(data);
      } else {
        setHealth(null);
      }
    } catch {
      setHealth(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const id = setInterval(fetchHealth, refreshIntervalMs);
    return () => clearInterval(id);
  }, [fetchHealth, refreshIntervalMs]);

  return { health, loading };
}

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
