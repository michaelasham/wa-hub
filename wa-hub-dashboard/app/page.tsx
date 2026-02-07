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
import { useInstances, useWaHubReachable } from '@/hooks/useWaHub';
import { CreateInstanceButton } from '@/components/CreateInstanceButton';
import { useState, useCallback } from 'react';

export default function HomePage() {
  const router = useRouter();
  const reachable = useWaHubReachable();
  const { instances, loading, error, refresh } = useInstances();
  const [userMenuActive, setUserMenuActive] = useState(false);

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
        return <Badge status="success">Ready</Badge>;
      case 'qr':
        return <Badge status="attention">QR Code Required</Badge>;
      case 'initializing':
        return <Badge status="info">Initializing</Badge>;
      case 'disconnected':
        return <Badge status="critical">Disconnected</Badge>;
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
        plain
      >
        {inst.name || inst.id}
      </Button>,
      statusBadge,
      inst.phoneNumber || '—',
      <Button
        key={`action-${inst.id}`}
        url={`/instances/${encodeURIComponent(inst.id)}`}
        plain
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
            content: 'Refresh',
            onAction: refresh,
          },
        ]}
      >
        {reachable === false && (
          <Banner status="critical" title="Connection Error">
            <p>wa-hub service is unreachable. Check WA_HUB_BASE_URL and ensure wa-hub is running.</p>
          </Banner>
        )}

        {reachable === null && (
          <Banner status="info" title="Checking connection">
            <p>Verifying connection to wa-hub service...</p>
          </Banner>
        )}

        {error && (
          <Banner status="critical" title="Error">
            <p>
              {error} {reachable === false && '(401/403: check WA_HUB_TOKEN)'}
            </p>
          </Banner>
        )}

        <Card>
          {loading ? (
            <div style={{ padding: '2rem', textAlign: 'center' }}>
              <Spinner accessibilityLabel="Loading instances" size="large" />
              <div style={{ marginTop: '1rem' }}>
                <Text as="p" color="subdued">
                  Loading instances...
                </Text>
              </div>
            </div>
          ) : instances.length === 0 ? (
            <EmptyState
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
