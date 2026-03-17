# ClawSuite Chat ↔ Gateway Parity Spec

**Goal:** Make ClawSuite's chat screen match OpenClaw gateway behavior 1:1.
**Branch:** `feat/ux-polish-v3-handshake` (252 commits ahead of main)
**TSC:** Clean (0 errors)

---

## P0 — Must Fix

### 1. Chat Abort (partially implemented)

**Current state:** `handleAbort` in `chat-composer.tsx:1332` fires `POST /api/chat-abort` which calls `gatewayRpc('chat.abort', { sessionKey })`. The RPC call works, but the **UI doesn't react** — streaming state isn't cleared, the stop button doesn't revert to send, and partial assistant text isn't finalized.

**Files:**
- `src/screens/chat/components/chat-composer.tsx` — `handleAbort` (~line 1332)
- `src/stores/gateway-chat-store.ts` — `streamingState` Map
- `src/routes/api/chat-abort.ts` — API route (this part is fine)

**Fix:**
- After the abort POST succeeds, dispatch a synthetic `{ type: 'done', state: 'aborted', sessionKey }` event into the store
- The store's `done` handler should: clear streaming state for that session, finalize any partial assistant message with `[aborted]` suffix or similar
- Composer should check `streamingState` and flip back to send mode
- Test: send a long prompt, hit stop mid-stream, verify response stops and UI resets

### 2. Session Titles (implemented but may not trigger)

**Current state:** Full title generation system exists:
- `src/utils/generate-session-title.ts` — local keyword-based title generator (no LLM call)
- `src/screens/chat/session-title-store.ts` — persists titles to localStorage
- `src/screens/chat/hooks/use-auto-session-title.ts` — hook that triggers generation

**Possible issue:** The hook checks `isGenericTitle()` and various conditions before generating. Need to verify:
- Title generation fires after first assistant response
- Generated title propagates to sidebar session list
- Session rename (manual) overrides auto-generated title

**Files:**
- `src/screens/chat/hooks/use-auto-session-title.ts`
- `src/screens/chat/session-title-store.ts`
- `src/screens/chat/components/chat-sidebar.tsx` — where titles display

**Test:** Start a new session, send "explain React hooks", verify sidebar shows a meaningful title (not "New Session" or a hash).

### 3. Message Ordering (missing chronological sort)

**Current state:** `mergeHistoryMessages` in `gateway-chat-store.ts:745` does dedup but does NOT sort by timestamp. Messages appear in insertion order which can be wrong when:
- SSE events arrive out of order
- History refetch returns messages in different order than realtime
- Optimistic messages get inserted before the confirmed copy arrives

**Files:**
- `src/stores/gateway-chat-store.ts` — `mergeHistoryMessages` (~line 745)

**Fix:**
- After merging realtime + history, sort the final array by `timestamp` or `created_at` or `ts` (check which field the gateway uses)
- The existing `.sort()` calls at lines 265, 816, 823 sort session *keys*, not messages
- Add a `sortMessagesChronologically()` helper that handles multiple timestamp field names (`timestamp`, `created_at`, `ts`, `date`)
- Apply it at the end of `mergeHistoryMessages` before returning
- Also apply it in the `onMessage` handler after appending new messages

**Test:** Send 5 rapid messages, verify they appear in correct order. Refresh page, verify order is preserved.

### 4. Streaming Fidelity

**Current state:** Streaming works via SSE (`/api/chat-events`) with chunk/thinking/tool/done events. The store accumulates chunks into `streamingState`.

**Potential issues to verify:**
- Token-by-token rendering: are chunks appended immediately or batched?
- Thinking blocks: do they render in a collapsible section during streaming?
- Tool calls: do they show inline progress (spinner + tool name)?
- Done event: does the streaming message get replaced with the final gateway message?

**Files:**
- `src/stores/gateway-chat-store.ts` — event handlers (lines 340-700)
- `src/screens/chat/components/message-item.tsx` — renders individual messages
- `src/screens/chat/components/chat-message-list.tsx` — message list container

**Test:** Send "use the terminal to list files in the current directory", verify:
1. Thinking block appears (if model supports it)
2. Tool call shows with name + spinner
3. Tool result renders
4. Final response streams token by token
5. No duplicate messages after streaming completes

---

## P1 — Nice to Have

### 5. Model Switching

**Current state:** Settings dialog has model config, but switching model mid-session doesn't work. The gateway decides the model, not the frontend.

**This may not be a frontend fix** — if the gateway handles model selection, the frontend just needs to send the model preference in the session config. Check if `gatewayRpc('sessions.patch', { model })` works.

**Files:**
- `src/components/settings-dialog/settings-dialog.tsx`
- `src/routes/api/sessions/$sessionKey.status.ts`
- `src/routes/api/config-patch.ts`

---

## Key Architecture Notes

- **Gateway connection:** WebSocket to `ws://127.0.0.1:18789`
- **Chat events:** SSE stream at `/api/chat-events` (Vite proxied to gateway)
- **Message send:** `POST /api/sessions/send` → `gatewayRpc('chat.send')`
- **State store:** Zustand store at `src/stores/gateway-chat-store.ts` (881 lines)
- **Message types:** Defined in `src/screens/chat/types.ts`
- **Dedup logic:** `mergeHistoryMessages` uses ID match → nonce match → text match → signature match (4-layer)
- **Streaming:** `streamingState` Map tracks per-session partial text, thinking, tool calls

## How to Verify

```bash
cd ~/.openclaw/workspace/clawsuite
npx tsc --noEmit          # must stay clean
# Dev server already running on port 3007
# Gateway running on port 18789
```

Open `https://erics-macbook-pro.tailcfa706.ts.net/` on mobile or `http://localhost:3007` on desktop.
