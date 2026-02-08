# Incoming Message Fallback

## Problem

whatsapp-web.js v1.34.x (notably 1.34.4) has reported reliability issues with incoming message events. The `message` event can fail to fire, and `message_create` may fire for both incoming and outgoing messages. See [whatsapp-web.js #5765](https://github.com/pedroslopez/whatsapp-web.js/issues/5765).

## Mitigation

wa-hub implements a multi-layer approach:

### 1. Dual event listeners

- **`message`** – treated as incoming only
- **`message_create`** – fires for both incoming and outgoing; we ignore `fromMe` messages

Both listeners are attached regardless of `webhook.events`. Do NOT gate listener attachment by webhook config.

### 2. Deduplication

Per instance, we maintain an LRU cache (max 2000 entries) of seen message IDs. Unique key: `message.id._serialized` if present; else fallback to `(from + to + timestamp + body hash)`. Duplicates from both events or from event + poller are skipped.

### 3. Fallback unread poller

When the instance is READY, a poller runs every `MESSAGE_FALLBACK_POLL_INTERVAL_MS` (default 15s):

- Fetches chats with `unreadCount > 0`
- For each chat, fetches recent messages
- Filters to incoming only (`!fromMe`)
- Processes through the same dedupe + webhook pipeline

This ensures messages are delivered even when events never fire.

### 4. Diagnostics

`GET /instances/:id/diagnostics` includes:

- `listenersAttached` – whether message/message_create listeners were attached
- `fallbackPollEnabled`, `fallbackPollIntervalMs`
- `lastFallbackPollAt`, `fallbackPollRuns`, `fallbackPollLastError`
- `lastIncomingMessageAt` – when we last processed an incoming message
- `dedupeCacheSize` – current size of the dedupe cache

## Config

| Env | Default | Description |
|-----|---------|-------------|
| `MESSAGE_FALLBACK_POLL_INTERVAL_MS` | 15000 | Poll interval (ms) |
| `MESSAGE_FALLBACK_POLL_ENABLED` | true | Set to `false` to disable poller |

## Version note

whatsapp-web.js v1.34.4 has reports of missing incoming message events. The fallback poller mitigates this. Implement the poller regardless of library version.
