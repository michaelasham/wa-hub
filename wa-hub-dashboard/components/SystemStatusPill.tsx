'use client';

import type { SystemStatusData } from '@/hooks/useSystemStatus';

export function SystemStatusPill({
  data,
  error,
}: {
  data: SystemStatusData | null;
  error: string | null;
}) {
  const label = error && !data ? 'System unavailable' : data?.mode === 'syncing' ? 'LOW POWER' : 'NORMAL';
  const isSyncing = data?.mode === 'syncing';
  return (
    <span
      style={{
        padding: '4px 10px',
        borderRadius: 9999,
        fontSize: 12,
        fontWeight: 600,
        backgroundColor: isSyncing ? 'rgba(255, 154, 0, 0.2)' : 'rgba(0, 128, 96, 0.2)',
        color: isSyncing ? '#b98900' : '#008060',
      }}
    >
      {label}
    </span>
  );
}
