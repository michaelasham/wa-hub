# Instance Lifecycle Refactor - Implementation Plan

## Overview
This document outlines the refactoring plan to replace the current polling-based `waitForReady()` with a production-grade instance lifecycle management system.

## Core Components

### 1. InstanceManager Class
- **File**: `src/instance-manager.js` (new)
- **Purpose**: Central service managing all instance lifecycle operations
- **Key Features**:
  - State machine (READY, CONNECTING, DISCONNECTED, NEEDS_QR, ERROR)
  - Per-instance message/poll queue
  - Event-driven readiness gates
  - Single-flight reconnection lock (mutex)
  - Soft/hard restart ladder
  - Terminal state detection

### 2. InstanceContext Class
- **Purpose**: Per-instance state and metadata
- **Properties**:
  - state: InstanceState enum
  - client: whatsapp-web.js Client
  - queue: Array of queued messages/polls
  - lock: Promise for reconnection mutex
  - Metrics: lastDisconnectAt, restartAttempts, etc.

### 3. Migration Strategy
- **Phase 1**: Create new InstanceManager alongside existing sessions.js
- **Phase 2**: Update router.js to use InstanceManager
- **Phase 3**: Deprecate/remove old sessions.js code
- **Phase 4**: Test and validate

## State Machine

```javascript
InstanceState = {
  READY: 'ready',
  CONNECTING: 'connecting',
  DISCONNECTED: 'disconnected',
  NEEDS_QR: 'needs_qr',
  ERROR: 'error'
}
```

## Queue System

- Max size: 200 (configurable)
- Auto-flush on READY state
- Sequential processing (preserve order)
- Queue items: {type, payload, createdAt, attemptCount, id}

## Reconnection Logic

1. Check if state is NEEDS_QR → return error
2. Check if state is READY → return immediately
3. Acquire lock (single-flight)
4. Soft restart (destroy + initialize)
5. If fails → Hard restart (new Client)
6. If QR event received → mark NEEDS_QR (terminal)
7. Release lock

## LocalAuth Isolation

Each instance gets:
- `clientId`: sanitized instance name
- `dataPath`: `${AUTH_BASE_DIR}/${sanitizedInstanceName}/`

## Environment Variables Added

- `AUTH_BASE_DIR`: Base directory for per-instance auth (default: `./.wwebjs_auth`)
- `MAX_QUEUE_SIZE`: Maximum queue size (default: 200)
- `READY_TIMEOUT_MS`: Timeout for ready state (default: 180000 = 3min)
- `RESTART_BACKOFF_MS`: Backoff between restart attempts (default: 2000)
- `MAX_RESTARTS_PER_WINDOW`: Max restarts in window (default: 5)
- `WINDOW_MINUTES`: Time window for restart limit (default: 10)

## API Changes

### Send Message/Poll Response Format
```json
{
  "status": "sent" | "queued" | "failed",
  "instanceState": "ready" | "connecting" | "disconnected" | "needs_qr" | "error",
  "queueDepth": 0,
  "messageId": "..." | null,
  "queueId": "..." | null,
  "error": "..." | null
}
```

## Implementation Status

- [x] Config updated with new environment variables
- [ ] InstanceManager class created
- [ ] InstanceContext class created
- [ ] State machine implemented
- [ ] Queue system implemented
- [ ] Event-driven readiness implemented
- [ ] Reconnection ladder implemented
- [ ] LocalAuth isolation implemented
- [ ] Router endpoints updated
- [ ] Persistence updated
- [ ] Logging enhanced
