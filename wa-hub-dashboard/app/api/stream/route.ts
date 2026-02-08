import { NextRequest } from 'next/server';
import { subscribeSse, getWebhookEvents, getApiLogs, getInstanceMeta } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const instanceId = request.nextUrl.searchParams.get('instanceId');
  const scope = request.nextUrl.searchParams.get('scope');
  const globalScope = scope === 'global';

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
        );
      };

      const unsub = subscribeSse((event) => {
        if (!globalScope && instanceId && 'instanceId' in event.data && event.data.instanceId !== instanceId) {
          return;
        }
        send(event);
      });

      send({ type: 'connected', data: { instanceId, scope: globalScope ? 'global' : 'instance' } });
      send({
        type: 'initial',
        data: {
          webhookEvents: getWebhookEvents(globalScope ? undefined : (instanceId ?? undefined)),
          apiLogs: getApiLogs(globalScope ? undefined : (instanceId ?? undefined)),
          instanceMeta: instanceId ? getInstanceMeta(instanceId) : null,
        },
      });

      request.signal.addEventListener('abort', () => {
        unsub();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
