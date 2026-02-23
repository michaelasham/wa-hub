'use client';

import { useRouter } from 'next/navigation';
import {
  Page,
  Card,
  DataTable,
  Button,
  Banner,
  Frame,
  TopBar,
  Badge,
  EmptyState,
  Spinner,
  Text,
  Tooltip,
} from '@shopify/polaris';
import { useInstances, useWaHubReachable, useHealth } from '@/hooks/useWaHub';
import { useSystemStatus, formatSinceDuration, instanceStateLabel } from '@/hooks/useSystemStatus';
import { CreateInstanceButton } from '@/components/CreateInstanceButton';
import { SystemStatusPill } from '@/components/SystemStatusPill';
import { useState, useCallback, useEffect } from 'react';
import { waHubRequest } from '@/lib/wahubClient';

export default function HomePage() {
  const router = useRouter();
  const reachable = useWaHubReachable();
  const { health } = useHealth();
  const { instances, loading, error, refresh } = useInstances();
  const { data: systemStatus, error: systemStatusError } = useSystemStatus();
  const [userMenuActive, setUserMenuActive] = useState(false);
  const [fixingWebhooks, setFixingWebhooks] = useState(false);
  const [fixWebhooksResult, setFixWebhooksResult] = useState<string | null>(null);
  const [durationTick, setDurationTick] = useState(0);

  const isSyncing = systemStatus?.mode === 'syncing';
  useEffect(() => {
    if (!isSyncing) return;
    const id = setInterval(() => setDurationTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [isSyncing]);

  const sinceDuration = systemStatus?.since ? formatSinceDuration(systemStatus.since) : '—';
  const statusInstances = systemStatus?.instances ?? systemStatus?.perInstanceStates ?? [];
  const stateByInstanceId = new Map(statusInstances.map((i) => [i.id, i.state]));
  const detailsByInstanceId = new Map(statusInstances.map((i) => [i.id, i]));
  const queuedByInstanceId = systemStatus?.queuedOutboundByInstance ?? {};
  const syncingInstanceId = systemStatus?.syncingInstanceId ?? null;

  const handleFixWebhookUrls = useCallback(async () => {
    setFixingWebhooks(true);
    setFixWebhooksResult(null);
    try {
      const cfgRes = await fetch('/api/config');
      const cfg = await cfgRes.json();
      const webhookUrl = cfg?.webhookUrl ?? cfg?.internalUrl;
      if (!webhookUrl) {
        setFixWebhooksResult('No webhook URL in config. Set DASHBOARD_WEBHOOK_INTERNAL_URL or DASHBOARD_WEBHOOK_PUBLIC_URL.');
        return;
      }
      let ok = 0;
      let fail = 0;
      for (const inst of instances) {
        const res = await waHubRequest({
          method: 'PUT',
          path: `/instances/${encodeURIComponent(inst.id)}`,
          body: { webhook: { url: webhookUrl } },
        });
        if (res.ok) ok++;
        else fail++;
      }
      setFixWebhooksResult(`Updated ${ok} instance(s).${fail ? ` ${fail} failed.` : ''}`);
      if (ok > 0) refresh();
    } catch (e) {
      setFixWebhooksResult((e instanceof Error ? e.message : 'Failed') + '.');
    } finally {
      setFixingWebhooks(false);
    }
  }, [instances, refresh]);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    router.push('/login');
  };

  const toggleUserMenu = useCallback(() => setUserMenuActive((userMenuActive) => !userMenuActive), []);

  const userMenuActions = [
    {
      items: [{ content: 'Logout', onAction: handleLogout }],
    },
  ];

  const getStatusBadge = (backendState: string | undefined, instStatus: string, isSyncingRow: boolean) => {
    const state = backendState ?? instStatus?.toLowerCase?.() ?? '';
    if (isSyncingRow) return <Badge tone="attention">SYNCING</Badge>;
    switch (backendState ?? state) {
      case 'READY':
        return <Badge tone="success">READY</Badge>;
      case 'CONNECTING':
        return <Badge tone="attention">SYNCING</Badge>;
      case 'NEEDS_QR':
        return <Badge tone="warning">WAITING_FOR_QR</Badge>;
      case 'DISCONNECTED':
      case 'PAUSED':
        return <Badge tone="critical">DISCONNECTED</Badge>;
      case 'ERROR':
      case 'RESTRICTED':
        return <Badge tone="critical">FAILED</Badge>;
      case 'ready':
        return <Badge tone="success">Ready</Badge>;
      case 'qr':
        return <Badge tone="attention">QR Code Required</Badge>;
      case 'initializing':
        return <Badge tone="info">Initializing</Badge>;
      case 'disconnected':
        return <Badge tone="critical">Disconnected</Badge>;
      default:
        return <Badge>{instanceStateLabel(backendState ?? state) || instStatus || state}</Badge>;
    }
  };

  const rows = instances.map((inst) => {
    const backendState = stateByInstanceId.get(inst.id);
    const details = detailsByInstanceId.get(inst.id);
    const queuedCount = queuedByInstanceId[inst.id] ?? 0;
    const isSyncingRow = inst.id === syncingInstanceId;
    const statusBadge = getStatusBadge(backendState, inst.status, isSyncingRow);
    const statusCell = inst.lastError ? (
      <Tooltip content={inst.lastError}>
        <span style={{ display: 'inline-block', cursor: 'default' }}>{statusBadge}</span>
      </Tooltip>
    ) : (
      statusBadge
    );
    const hasResources = details && (details.cpuPercent != null || details.memoryMB != null);
    const resourcesCell = hasResources ? (
      <Text as="span" tone="subdued">
        {details.cpuPercent != null ? `CPU ${details.cpuPercent}%` : ''}
        {details.cpuPercent != null && details.memoryMB != null ? ' · ' : ''}
        {details.memoryMB != null ? `RAM ${details.memoryMB} MB` : ''}
      </Text>
    ) : (
      '—'
    );
    return [
      <Button
        key={`name-${inst.id}`}
        url={`/instances/${encodeURIComponent(inst.id)}`}
        variant="plain"
      >
        {inst.name || inst.id}
      </Button>,
      statusCell,
      inst.phoneNumber || '—',
      resourcesCell,
      queuedCount > 0 ? (
        <Text as="span" tone="subdued">
          {queuedCount} queued
        </Text>
      ) : (
        '—'
      ),
      <Button
        key={`action-${inst.id}`}
        url={`/instances/${encodeURIComponent(inst.id)}`}
        variant="plain"
      >
        View
      </Button>,
    ];
  });

  const topBarMarkup = (
    <TopBar
      showNavigationToggle={false}
      userMenu={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SystemStatusPill data={systemStatus} error={systemStatusError} />
          <TopBar.UserMenu
            actions={userMenuActions}
            name="Admin"
            initials="A"
            open={userMenuActive}
            onToggle={toggleUserMenu}
          />
        </div>
      }
    />
  );

  return (
    <Frame topBar={topBarMarkup}>
      <Page
        title="WhatsApp Instances"
        primaryAction={<CreateInstanceButton onCreated={refresh} />}
        secondaryActions={[
          {
            content: 'Fix webhook URLs',
            onAction: handleFixWebhookUrls,
            loading: fixingWebhooks,
            disabled: instances.length === 0 || fixingWebhooks,
          },
          {
            content: 'Refresh',
            onAction: refresh,
          },
        ]}
      >
        {systemStatusError && !systemStatus && (
          <Banner tone="warning" title="System status unavailable">
            <p>Low Power Mode status could not be loaded. The rest of the dashboard works as usual.</p>
          </Banner>
        )}

        {isSyncing && systemStatus && (
          <Banner tone="warning" title="Low Power Mode is ON">
            <p>
              Outbound actions are queued while <strong>{syncingInstanceId ?? 'an instance'}</strong> syncs.
              {' '}Since: <strong>{sinceDuration}</strong>
              {' '}· Outbound queued: <strong>{systemStatus.queuedOutboundCount}</strong>
              {' '}| Inbound buffered: <strong>{systemStatus.inboundBufferCount}</strong>
            </p>
          </Banner>
        )}

        {reachable === false && (
          <Banner tone="critical" title="Connection Error">
            <p>wa-hub service is unreachable. Check WA_HUB_BASE_URL and ensure wa-hub is running.</p>
          </Banner>
        )}

        {reachable === null && (
          <Banner tone="info" title="Checking connection">
            <p>Verifying connection to wa-hub service...</p>
          </Banner>
        )}

        {error && (
          <Banner tone="critical" title="Error">
            <p>
              {error} {reachable === false && '(401/403: check WA_HUB_TOKEN)'}
            </p>
          </Banner>
        )}

        {fixWebhooksResult && (
          <Banner tone={fixWebhooksResult.startsWith('Updated') ? 'success' : 'warning'} onDismiss={() => setFixWebhooksResult(null)}>
            <p>{fixWebhooksResult}</p>
          </Banner>
        )}

        {reachable !== false && (health?.cpuPercent != null || health?.memoryTotalMB != null) && (
          <div style={{ marginBottom: '1rem' }}>
            <Text as="p" tone="subdued">
              {health.cpuPercent != null && (
                <>CPU: <strong>{health.cpuPercent}%</strong></>
              )}
              {health.cpuPercent != null && health.memoryTotalMB != null && ' · '}
              {health.memoryTotalMB != null && (
                <>
                  RAM: <strong>
                    {health.memoryUsedMB != null ? `${health.memoryUsedMB} MB` : '—'} / {health.memoryTotalMB} MB
                    {health.memoryPercent != null ? ` (${health.memoryPercent}%)` : ''}
                  </strong>
                  {health.processRssMB != null && (
                    <span style={{ opacity: 0.85 }}> · process: {health.processRssMB} MB</span>
                  )}
                </>
              )}
              {health.instanceCount != null && (
                <> · {health.instanceCount} instance{health.instanceCount !== 1 ? 's' : ''}</>
              )}
            </Text>
          </div>
        )}

        <Card>
          {loading ? (
            <div style={{ padding: '2rem', textAlign: 'center' }}>
              <Spinner accessibilityLabel="Loading instances" size="large" />
              <div style={{ marginTop: '1rem' }}>
                <Text as="p" tone="subdued">
                  Loading instances...
                </Text>
              </div>
            </div>
          ) : instances.length === 0 ? (
            <EmptyState
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              heading="No WhatsApp instances"
              action={{
                content: 'Create instance',
                onAction: () => {
                  // Trigger CreateInstanceButton
                  const button = document.querySelector('[data-create-instance]') as HTMLElement;
                  button?.click();
                },
              }}
            >
              <p>Create your first WhatsApp instance to get started.</p>
            </EmptyState>
          ) : (
            <DataTable
              columnContentTypes={['text', 'text', 'text', 'text', 'text', 'text']}
              headings={['Instance', 'Status', 'Phone Number', 'CPU · RAM', 'Queued', 'Actions']}
              rows={rows}
            />
          )}
        </Card>
      </Page>
    </Frame>
  );
}
