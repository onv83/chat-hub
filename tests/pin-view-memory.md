# Pin-view memory bounds (isolated candidate)

## Implemented

`trimPinViews` now treats priority as list ordering only. It evicts the least recently used non-active pin views until the configured `maxLiveViews` budget is met. The active session chat wins over a stale caller keep-ID; the stored selection preference is not a residency entitlement. The four service collectors live in `state.svcViews`, outside the eviction candidates.

Batch eviction removes all victims from the serial load queue before destroying any view. Destroying the active loader synchronously pumps the queue; without batch cancellation, queued victims would briefly navigate before being destroyed. Existing `destroyPinView` owns interval cleanup, removal, last-used cleanup and idempotent loader completion. This candidate does not change favourites, priority flags, unread state, service sessions or polling logic.

No startup preloading or fallback chat selection was introduced. Existing selectChat/renderChatList callers enforce the budget after explicit selection and on list/settings refresh. Creating the selected view can briefly precede trimming in the same synchronous selection call; this is not a byte-level/process-memory cap.

## Offline evidence

Run `npm test` and `node --test tests/lifecycle.mjs`. Tests execute actual renderer functions in VM contexts with synthetic webviews and controlled clocks, never real accounts.

- Ten priority views with budget two retain the active oldest view and the most recently used other view; all four collector objects remain connected.
- Batch eviction never assigns src to queued victims, and stale load completion cannot advance the next load.
- One hundred priority open/close cycles retain at most two pin views after each trim, at most one loader timeout and at most one queued job. Final teardown leaves zero synthetic views, loader listeners, intervals, timeouts and queued jobs.
- Real startup/selectChat/renderChatList integration covers all four services, ten explicit selections and twenty refreshes without additional navigation or read-verification requests.

These are retained-resource counts, not measured Electron RAM savings. Existing unrelated view listeners and deferred CSS/RHS work are not comprehensively measured by the queue harness. No application launch, account navigation, restart, deployment or push is part of this validation.

## Idle eviction proposal — not enabled

Add an optional idle TTL for non-selected pin views (proposed initial trial: ten minutes, checked once per minute). Keep capacity trimming independent and immediate. The idle sweep must:

1. Iterate only `state.pinViews`; never evict or navigate `state.svcViews` (MM/TG/MAX/Telemost collectors).
2. Always retain `state.activePinId`, even when the user reads silently, the app is unfocused, or the service/settings tab is shown. Do not infer consent to discard the selected chat from host-document focus or lack of input.
3. Measure each inactive view's age from deselection, not creation or last message activity. Opening, reselecting, and returning from idle must not trigger background chat navigation or mark-read actions.
4. Use the same batch queue cancellation and lifecycle teardown as capacity eviction. Never auto-recreate an evicted priority view; only an explicit user selection may recreate it.
5. Before enabling the timer, track/cancel outstanding host CSS retries, navigation debounce and MM RHS timers by view generation; guard callbacks after every await. A pending guest evaluation is not cancelled by a Promise timeout.
6. Keep drafts/scroll restoration and cold-open latency explicit product trade-offs. Inactive view eviction may lose guest-local unsent UI state; do not imply preservation without per-service evidence.
7. Test fake-clock threshold boundaries, selected-chat retention during long silent reading, service collector identity, reselect-before-sweep races, sleep/wake, no unread mutations, repeated sweep idempotence and zero retained scheduler work after teardown.

Enable idle eviction only after offline lifecycle coverage and a separately authorised controlled measurement with synthetic accounts/pages. Do not use the user's real chats to obtain memory numbers.
