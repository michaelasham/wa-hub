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
  Navigation,
  Badge,
  EmptyState,
  Spinner,
  Text,
} from '@shopify/polaris';
import { useInstances, useWaHubReachable, useHealth } from '@/hooks/useWaHub';
import { CreateInstanceButton } from '@/components/CreateInstanceButton';
import { useState, useCallback } from 'react';
import { waHubRequest } from '@/lib/wahubClient';

export default function HomePage() {
  const router = useRouter();
  const reachable = useWaHubReachable();
  const { health } = useHealth();
  const { instances, loading, error, refresh } = useInstances();
  const [userMenuActive, setUserMenuActive] = useState(false);
  const [fixingWebhooks, setFixingWebhooks] = useState(false);
  const [fixWebhooksResult, setFixWebhooksResult] = useState<string | null>(null);

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

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'ready':
        return <Badge tone="success">Ready</Badge>;
      case 'qr':
        return <Badge tone="attention">QR Code Required</Badge>;
      case 'initializing':
        return <Badge tone="info">Initializing</Badge>;
      case 'disconnected':
        return <Badge tone="critical">Disconnected</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const rows = instances.map((inst) => {
    const statusBadge = getStatusBadge(inst.status);
    return [
      <Button
        key={`name-${inst.id}`}
        url={`/instances/${encodeURIComponent(inst.id)}`}
        variant="plain"
      >
        {inst.name || inst.id}
      </Button>,
      statusBadge,
      inst.phoneNumber || '—',
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
        <TopBar.UserMenu
          actions={userMenuActions}
          name="Admin"
          initials="A"
          open={userMenuActive}
          onToggle={toggleUserMenu}
        />
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

        {reachable !== false && health?.cpuPercent != null && (
          <div style={{ marginBottom: '1rem' }}>
            <Text as="p" tone="subdued">
              CPU usage: <strong>{health.cpuPercent}%</strong>
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
              columnContentTypes={['text', 'text', 'text', 'text']}
              headings={['Instance', 'Status', 'Phone Number', 'Actions']}
              rows={rows}
            />
          )}
        </Card>
      </Page>
    </Frame>
  );
}
