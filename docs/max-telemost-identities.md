# MAX / Telemost identity adapters — verified subset

## Scope and evidence

Read-only CDP inspection on 2026-11-12 was limited to existing pinned work-chat metadata. No chat was opened, scrolled, marked read, or navigated; no login/config changes, messages, contact dumps, notifications, mail, or Hermes history work. Diagnostic scripts and raw scoped identity evidence remain in Hermes scratch, not the repository.

The earlier isolated `stable-identity.patch` proposed `data-chat-id` / href adapters, but explicitly did not prove those attributes existed. They do not exist on the inspected rows. That patch was not imported.

## Telemost: implemented

Current `.yamb-chat-list-item` rows are no-href DIVs. Their numeric `aria-labelledby` prefixes are presentation IDs, not route IDs. The live React host row exposes `__reactFiber$…`. Before the next DOM-host ancestor, two component owners pass the same scalar `memoizedProps.chatId`. Inspection of their loaded function sources confirmed that this ID supplies the list component and the `onSelect` route action; no handlers were invoked.

Observed route contracts:

- `/chats/<percent-encoded chatId>`: exact decoded `chatId`, including `0/0/<uuid>` and `0/22/<uuid>`.
- `/user/<uuid>`: exact UUID component of a two-UUID underscore-separated DM `chatId`. Both participant orders occur. The namespace is retained; a group UUID suffix never qualifies as a user route.

The adapter reads only the chatId scalar from the bounded owner chain, never state stores, hooks, messages, profiles, callbacks, or React children. Identity is copied before `cloneNode`, preserving no-href virtualized rows. Conflicting owners/alternate trees, malformed URLs/IDs, duplicate identities, missing fibers, and wrong origins produce `found:false` with no title fallback. Unknown identity keeps the previous unread value and observation timestamp, rank, activity time, preview, and avatar. A positively identified row without a badge can still clear unread.

The read-only production identity-prefix probe matched **9/9 pinned Telemost routes** (6 group routes and 3 user routes), including two distinct chats with identical titles. URL was unchanged. This proves the current identity contract, not host/UI deployment or unread accuracy. No application restart was performed.

## MAX: blocker, not a completed stable-ID adapter

All 8 scoped pinned MAX title candidates were present. The `aside div.item` row exposes only class and virtual `data-index`; descendant buttons have no href/chat-ID attribute or enumerable component-state handle. No immutable row identity source was verified within the bounded inspection. `data-index` is not promoted to chat identity. No guessed DOM attributes or reverse-engineered user API were added.

Only ambiguity guards are implemented: retain duplicate row titles until matching, reject multiple visible candidates and duplicate favorite titles, and apply the same duplicate-favorite guard to the single-pin priority lane. Existing unique-title no-href behavior remains to avoid silently dropping every MAX pin. **It is still a legacy title-based adapter and does not guarantee identity when another same-title chat is offscreen or a title changes.** MAX stable-ID correctness remains blocked. Resolving that requires a verified immutable state/DOM source; eliminating title fallback without one would necessarily reduce coverage. No claim of complete MAX cross-chat safety is made.

## Exact timestamp follow-up (2026-11-12)

Telemost exact timestamps are now integrated in source. Loaded 3.2.7 `web/sidebar.chunk.js` passes `rt(chatId)` metadata to the row owner. Its `date` is **not always a message date**: committed drafts substitute `1000 * draftDate`. In loaded `web/app.js`, module 1193 `EO` uses either the last message's `timestamp` or module 5799 `yf` (`conversations[chatId].last_timestamp`). Module 76330 `B_` divides by 1e6 for display seconds, confirming microseconds, not milliseconds. No store selectors or message objects are invoked/read by the adapter.

The bounded row owner adapter copies only `chatId/date/isDraft/status` scalars before cloning. It requires consistent owner and alternate dates, a safe integer microsecond timestamp between 2000 and now, no draft, and absent/sent/seen status. Accessors, pending/failed/unknown status, missing or malformed dates, conflicting owners and alternate transitions return no timestamp. Microseconds are floored to milliseconds. The scheduler accepts only found rows with this source and the exact current pin URL. The old displayed-date fallback is deliberately removed for Telemost: otherwise a rejected draft time would still become message activity. Unavailable timestamp preserves previous activity and does not suppress a valid unread observation.

Read-only production **identity+timestamp prefix** verified **9/9** pinned routes with exact metadata; URL and scroll position were unchanged. This is source coverage, **not host/UI deployment**: no restart or host function replacement was performed. The probe excludes preview extraction, message bodies, avatars and scrolling.

MAX follow-up found no own properties (including non-enumerable ones) on the 8 scoped candidate rows, cell buttons or `.meta`; no exact timestamp attributes. Loaded `10.Be8jU25f.js` component `UM` confirms `t.chat.id` feeds `Q.openChat` and `t.chat.lastMessage.time` feeds the time formatter, but both are closure-owned and no normal page-accessible row handle was verified. **A field name in source is not an accessible adapter contract.** No MAX production change or guessed timestamp was added; stable identity and exact timestamps remain blocked.

Offline verification: `node --check renderer.js`, `node --check main.js`, `npm test`: **408 passed, 0 failed**. Seventeen added scheduler-generated guest regressions include exact microsecond conversion through host activity merge, drafts, status/accessor guards, unit confusion, future/unsafe dates and owner/alternate conflicts. RED was observed before the exact adapter and again before accessor/status hardening. Prior tests remain intact. Baseline backups and scoped diagnostics live under Hermes scratch (`telemost-time-baseline`, `telemost-time-live.mjs`, `telemost-time-green.log`).

## Tests and deployment boundary

`tests/unit.mjs` executes actual scheduler-generated guest strings, not a duplicate matcher. Added cases cover identical titles with distinct IDs, duplicate ID/owner/alternate conflicts, wrong origin/namespace/malformed encoding, unknown cache preservation, exact DM participants in either order, and MAX duplicate titles in regular and selected-unread lanes. `tests/virtualized.mjs` uses the verified no-href React identity fixture and retains recycled-row, bounded chunk, cancellation, physical-avatar-limit, and real 4.5-second scheduler tests.

No old tests were deleted. Existing fixture URLs/state were updated for the stricter Telemost contract. The full offline suite and syntax checks must be rerun by the integrating parent. Existing cached metadata is not retroactively identity-verified or purged by this patch. React internal structure is version-sensitive and deliberately fails closed on drift.
