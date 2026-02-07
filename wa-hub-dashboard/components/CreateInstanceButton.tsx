'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Modal, TextField, Banner, Text } from '@shopify/polaris';
import { waHubRequest } from '@/lib/wahubClient';

function shopDomainToInstanceName(domain: string): string {
  const s = domain.trim().toLowerCase().replace(/\./g, '_');
  return s ? `WASP-${s}` : '';
}

export function CreateInstanceButton({ onCreated }: { onCreated?: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [shopDomain, setShopDomain] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const instanceName = shopDomain ? shopDomainToInstanceName(shopDomain) : '';

  const handleSubmit = async () => {
    if (!instanceName) {
      setError('Enter a shop domain (e.g. blesscurls.myshopify.com)');
      return;
    }
    setLoading(true);
    setError(null);
    let webhookUrl = typeof window !== 'undefined' ? `${window.location.origin}/api/wahub/webhook` : '';
    try {
      const r = await fetch('/api/config');
      const c = await r.json();
      if (c.webhookUrl) webhookUrl = c.webhookUrl;
    } catch {}
    const res = await waHubRequest<{ instance?: { id: string } }>({
      method: 'POST',
      path: '/instances',
      body: {
        name: instanceName,
        webhook: {
          url: webhookUrl,
          events: [
            'vote_update',
            'qr',
            'ready',
            'authenticated',
            'disconnected',
            'change_state',
            'auth_failure',
            'message',
          ],
        },
      },
    });
    setLoading(false);
    if (res.ok && res.data?.instance?.id) {
      setOpen(false);
      setShopDomain('');
      onCreated?.();
      router.push(`/instances/${encodeURIComponent(res.data.instance.id)}`);
    } else {
      setError(
        (res.data as { error?: string })?.error ?? res.error ?? 'Failed to create instance'
      );
    }
  };

  return (
    <>
      <Button
        primary
        onClick={() => setOpen(true)}
        data-create-instance
      >
        Create Instance
      </Button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          setError(null);
        }}
        title="Create WhatsApp Instance"
        primaryAction={{
          content: 'Create',
          onAction: handleSubmit,
          loading,
          disabled: !instanceName,
        }}
        secondaryActions={[
          {
            content: 'Cancel',
            onAction: () => {
              setOpen(false);
              setError(null);
            },
          },
        ]}
      >
        <Modal.Section>
          <TextField
            label="Shop domain or instance name"
            value={shopDomain}
            onChange={setShopDomain}
            placeholder="blesscurls.myshopify.com"
            helpText={instanceName ? `Instance name: ${instanceName}` : undefined}
            autoComplete="off"
          />
          {error && (
            <div style={{ marginTop: '1rem' }}>
              <Banner status="critical">
                <p>{error}</p>
              </Banner>
            </div>
          )}
        </Modal.Section>
      </Modal>
    </>
  );
}
