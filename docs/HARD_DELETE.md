# Hard Delete: DELETE /instances/:id

`DELETE /instances/:id` and `POST /instances/:id/client/action/logout` perform a **hard delete** that:

1. Stops timers (ready poll, watchdogs, send loop)
2. Destroys the whatsapp-web.js client (with timeout)
3. Removes the instance from runtime map and persisted list
4. **Purges LocalAuth session storage** from disk

Recreating an instance with the same id will require a new QR and can connect a **different** WhatsApp number.

## Purged Paths

Session data is deleted from:

- `{authBaseDir}/session-{sanitizedId}/`
- `{authBaseDir}/{sanitizedId}/` (legacy)
- `{authBaseDir}/Default-{sanitizedId}/` (legacy)

`authBaseDir` is `AUTH_BASE_DIR` or `SESSION_DATA_PATH` (default: `.wwebjs_auth`).

## Idempotent

- If the instance exists in memory: destroy client, remove from map, purge session dirs
- If the instance is not in memory but is in the persisted file: remove from file, purge session dirs
- If neither exists: purge session dirs only (in case they were left from a crash)

Returns 200 with `deleted`, `purged`, `purgedPaths`, and optional `warnings`.

## Manual Verification

1. Connect instance to number A, confirm READY
2. `DELETE /instances/:id`
3. Verify `authBaseDir` no longer contains `session-{id}` for that instance
4. Recreate instance with the same id
5. Confirm it goes to NEEDS_QR and does **not** auto-connect to A
