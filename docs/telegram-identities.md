# Telegram username identity adapter

## Pinned latest-preview projection (source patch, not deployed)

The regular service-view poll explicitly grants `needMessagePreview` for current pinned URLs only. The selected-unread lane does not grant it. It reuses the validated account/peer/top-message timestamp path, then confirms `top_message` again **after** row/avatar awaits. Bodies are projected synchronously only after all confirmations, with final account, alias, generation and cache-entry checks. No history fetch, chat opening, navigation, read receipt, search, profile lookup or message RPC is added.

The running client's code-only probe reconfirmed loaded `index-Dthh6gB6.js` and `apiManagerProxy-xL1OSBOW.js`, `${peerId}_history`, and the local `getMessageFromStorage` global-history redirect. No live message entries or bodies were inspected by the probe. The matching previously retrieved worker source map's `appMessagesManager.saveMessage` establishes `pFlags`, normalized `fromId`, `message`, and `media`; its `isOwnMessage` helper establishes outgoing/self semantics. The sender is the exact `fromId` peer in the same account mirror, not the pin/chat title. Only that peer's first/last name, username or channel title is projected; phone, credentials, access hashes, entities and media payloads are untouched.

- Preserve actual `pFlags.out` in the evidence. Outgoing displays `Вы`; Saved Messages sent by self also displays `Вы` without fabricating an outgoing flag.
- Text is normalized and capped at 240 UTF-16 units; sender at 128; combined preview at 370. Only an initial 4096-unit string slice is processed. No additional persistent guest preview cache is created; results are bounded by the existing 64-peer batch and current pins.
- Empty photo/document/poll/location/contact/link messages get type-specific placeholders; other media get a generic media placeholder. Service messages remain distinct. Captions retain their text. Draft contents and dates are never used. `messageEmpty`, missing/deleted cache entries and unsupported types are unknown, **not** fabricated deletion messages; unverified old preview/author text is cleared.
- Cache-mode service polls do not consume sidebar preview/draft text. Unrelated rows are never cloned for previews. A limited legacy DOM-only path remains for callers without metadata capability; it reads only exact requested pin rows.
- Structured author evidence bypasses legacy `msgAuth` enrichment. Row rendering uses explicit sender boundaries for long names, and does not bold numeric/URL body prefixes as invented authors. Same-ID edits refresh on subsequent polls.
- The final local confirmation shares the two physical dialog slots and has one 800 ms deadline for the batch. Timeout does not release an unresolved physical slot. No body/error payload is logged; diagnostic probes must emit only aggregate presence/type/count information.

Regressions in `tests/telegram-aliases.mjs` and `tests/author-freshness.mjs` execute the actual serialized guest and scheduler with synthetic data: unknown sender, outgoing, numeric/URL/long text, signed peers/channel sender, service/media/empty, draft/private-field traps, deleted/mutated entries, late account/top-message changes, bounded timeout, selected-lane zero body reads and stale author rejection. The earlier DOM-zero fixture now supplies a proven cached latest message for preview publication; unread and timestamp preservation assertions remain separate.

Offline verification: `node --check renderer.js`, `node --check main.js`, and full `npm test`: **473 passed, 0 failed, 0 skipped**. Backups and the preview-only baseline diff are in Hermes scratch `tg-preview-baseline`; the full synthetic test log is `tg-preview-full.log`.

Live UI preview coverage is **not verified** in this task: the app was not restarted or hot-replaced, and no live bodies were exported. A missing cache remains unknown; completeness cannot be promised for uncached messages.


## Numeric user unread metadata

Canonical positive numeric user links now use the same verified `dialogsStorage.getDialogOnly(Number(peerId))` contract as username links. The previous timestamp path already requested their dialogs, but the final unread merge admitted only username identity; the selected-unread lane also excluded numeric metadata reads.

- Only a safe positive integer ID with an exact current-account `user` mirror record is admitted. No username, DOM row, title, cached `tgPeerOf`, or hardcoded pin is needed.
- The numeric `dialogIdentity` is separate from alias/avatar identity and the signed-peer timestamp proof. Negative group/channel/forum peers do **not** inherit user unread semantics; their existing timestamp path is unchanged.
- Both polling and selected refresh use the service view. Unknown/error cannot downgrade to stale pin-view/DOM counts; it preserves the prior count and observation time. Verified zero clears it. Numeric metadata grants no scrolling.
- Requests share the existing deduplicated two-slot physical pool, generation and deadline. Account, mirror, peer, manager and generation are rechecked after awaits and again before publication. A verified account/peer rebind invalidates old host metadata even if the new dialog is unloaded; an unknown identity is not fabricated into a new binding.
- The host keeps only a session-local account/peer invalidation key, never a persistent numeric resolution cache. No body, history RPC, navigation, read receipt or account write is added.

Offline gate: `node --check renderer.js`, `node --check main.js`, and `npm test` **434/434 passed**. The 408-test baseline remains present, with 26 added regressions. One legacy numeric DOM-zero fixture now supplies the required verified account/dialog metadata; its original mismatch/cache/zero/preview assertions remain unchanged. Tests cover no-DOM users, IDs beyond 32 bits, alias/numeric deduplication in either order, invalid signed IDs, missing peer/dialog, errors, manual marks, stale account/mirror/generation, and serialized scheduler publication. Deployment and metadata-only live coverage verification remain the parent's responsibility; this task did not restart or inspect live chats.

## Source and safety boundary

The identity adapter lives inside the serialized `__chatHubTgUnread` collector. It projects the already-loaded **current-account** webk `apiManagerProxy.mirrors.peers` identity map. Before using it, it requires `rootScope.myId === mirrors.state.userId`, `authStateSignedIn`, and the current account's own peer entry. Identity resolution does not call manager methods, RPCs, IndexedDB, user resolution APIs or profile fetches. The separately bounded small-photo adapter described below uses the verified `loadAvatar` method only after this identity check.

Live source inspection established that `getPeer(id)` is a direct `mirrors.peers[id]` read, while `resetAccountMirrors()` replaces that object and `switchAccount()` resets it. This is an internal webk surface, not a guaranteed public API. Missing or changed structures fail closed for alias resolution.

Only the username field is examined while filtering the existing identity map. For exact requested canonical `https://web.telegram.org/k/#@username` pins, the projected fields are numeric user ID, username, type validation and photo **presence**, never photo payloads, names, phone numbers, access hashes, messages, credentials or unrelated profiles. Current primary usernames are supported; secondary collectible aliases and channel peer-sign conventions remain unknown until separately verified.

## Identity rules

- Username comparison is exact, ASCII case-insensitive; title is not evidence.
- A canonical numeric URL still outranks legacy cached `tgPeerOf`.
- Numeric aliases require a valid positive user ID equal to its mirror key.
- Multiple records claiming one username, invalid records, or a direct DOM link contradicting the mirror yield unknown. Duplicate links/pins to the same peer are not a conflict.
- Alias snapshots are invocation-local, never written to config or used as future evidence. Account object/peer-map identity and current username ownership are rechecked after asynchronous row/avatar work.
- Every alias-derived result includes provenance `{source, accountId, username, peerId, photoPresent}`. Rows and avatar capture use that peer's exact numeric ID.
- The host retains only a session-local binding key for **invalidation**, never resolution. A changed/lost binding clears prior avatars, unread, activity and author metadata. Missing DOM rows under the same verified binding preserve previous observations; absence remains unknown, not zero.
- Scoped results cannot escalate to the old pin-view avatar/message fallback. No new view, navigation, scrolling, search, read receipt or message operation is introduced by the adapter.

## Verification

`npm test` includes `tests/telegram-aliases.mjs`: same-name rows, poisoned numeric cache, username reassignment, account change/logout, reset during awaits, conflicting aliases/links, duplicate pins, untrusted origins, private-field access guards, host invalidation, and the actual serialized guest through the real unread scheduler.

A read-only live probe of the production adapter prefix (not the preview collector) verified **30/30** canonical pinned usernames in the signed-in account; **26** had photo metadata. The existing DOM had **0** direct username links and **6** numeric rows for those aliases. Location was unchanged. Only aggregate counts were retained in the final probe output.

This verifies the identity source and explains the strict-link coverage gap; it does **not** prove full unread/avatar coverage. Offscreen rows remain virtualized, photo presence does not guarantee a downloaded image, and this batch did not restart or hot-replace the running renderer. Deployment and subsequent metadata-only coverage checks remain outstanding. No main-process or permission changes, commit, push, chat opening or chat scrolling were performed.

## Bounded offscreen small-photo adapter

Contract inspected from the running client's `loadAvatar.toString()` and the matching public webk build's source maps, not guessed from parameter names:

- Loaded entry: `index-Dthh6gB6.js`; proxy: `apiManagerProxy-xL1OSBOW.js` / `.js.map`, source `src/lib/apiManagerProxy.ts`.
- Worker selected by that proxy: `index.worker-CAQPBjMz.js` / `.js.map`, source `src/lib/appManagers/appAvatarsManager.ts`.
- Call: `apiManagerProxy.loadAvatar(Number(peerId), photo, 'photo_small')`, where `photo` is the exact matched peer's `userProfilePhoto`. Its small-photo path builds `inputPeerPhotoFileLocation` and calls `apiFileManager.download`, not dialog navigation or history/read operations. Video/full-profile paths are not used. The numeric type matters: worker peer helpers use number prototype methods.
- Successful results are local `blob:https://web.telegram.org/...` URLs. Only those URLs are fetched; only JPEG/PNG/WebP blobs of 1–65536 bytes are encoded. No access hashes, phones, message text or unrelated profiles are returned/logged.

The scheduler explicitly grants metadata-photo work only to the service view. Pin-view fallbacks and selected-unread refreshes cannot start it. Each invocation starts at most two tasks; the guest retains at most two physically unresolved tasks across timeouts and account resets. Optional photo work is never awaited by the collector, so unread publication does not wait for downloads. Completed bytes become available on a later normal poll. A hung manager promise retains its slot rather than permitting retries; the blob-fetch stage has a 1500 ms abort request without prematurely releasing a still-unsettled physical slot.

The session-only cache is capped at 32 entries and 65536 raw bytes per image, with a 60-second reuse/retry window (expired entries remain bounded until replaced or evicted). Pending entries cannot be evicted to launch duplicates. Account/mirror resets or logout clear retained bytes without clearing physical slots. Identity ownership, account generation and photo identity are checked after awaits and again before publishing cached bytes. The host's existing canonical-pin/job checks remain in force. No new title matching, persistent avatar storage, navigation, view creation, search or scrolling was added. Photo success does not set `found:true` or refresh an unknown unread timestamp.

### Read-only verification and remaining scope

A production-prefix probe (identity + this photo helper only, no preview collector) completed in 14 bounded rounds. Of **39 TG pins**, **30/30 username pins** resolved: **26/26 photo-bearing peers** produced valid photo bytes, including **21** without a current numeric DOM row. **4/30** were full, non-minimal user records with no photo; these are confirmed no-photo records, not failed downloads. The other **9/39 non-username pins** are outside this adapter's scope and remain unknown here. The final pending count was zero; URL and account checks remained unchanged. This is source-adapter coverage, **not** a deployed host/UI avatar count. The renderer was not restarted or hot-replaced.

The matching worker's `src/lib/storages/dialogs.ts` also proves `getDialogOnly(peerId)` is a direct `this.dialogs[peerId]` read. A separate two-pin read-only probe via `rootScope.managers.dialogsStorage.getDialogOnly(Number(peerId))` returned **2/2** identity-matching dialog records with valid `unread_count` and `unread_mentions_count`; account and URL remained unchanged. This establishes an available metadata accessor, not comprehensive freshness/semantics coverage. No dialog-unread adapter is enabled in this patch; missing/offscreen unread remains unknown.

Regression coverage includes serialized scheduler publication without unread zeroing, 100 polls with an unresolved request, 100 account-generation resets, late photo/account/username changes, cache-cap/pending-eviction behavior, invalid MIME/URL/size, failures, minimal users, logout cleanup, and service-view-only permission. No live message content, chat opening/selection/scrolling, reload or notifications were used.

## Exact latest-message timestamps (metadata only)

The loaded `index-Dthh6gB6.js` build and matching proxy/worker source maps were inspected again. The live proxy methods match these contracts:

- `getHistoryMessagesStorage(peerId)` returns `${peerId}_history`.
- `getMessageFromStorage(key, mid)` redirects global-history message IDs to `0_history`, then returns `mirrors.messages[key]?.[mid]`. It does not fetch a message. Do **not** substitute `getMessageByPeer`: that method also falls back to logs.
- `resetAccountMirrors()` replaces the message and peer maps. The worker's `dialogsStorage.getDialogOnly(peerId)` remains a local dialog lookup.
- Worker `appMessagesManager.saveMessage` sets `message.mid` using the message-ID manager and `message.peerId` from the message peer. `dialogs.ts` looks up `dialog.top_message` through that same ID space. `getPeerId.ts` maps users to positive IDs and chats/channels to negative IDs. The adapter checks the exact dialog peer type and ID, cached `mid`, and cached `peerId`; a matching message ID alone is insufficient.

The service collector now explicitly requests `needMessageMetadata`. It reads the validated dialog's `top_message`, references that one cached message **inside the guest**, and projects only type/peer/message ID/date. The message object and its body, media, entities, sender and other contents are never returned, enumerated or logged. Only `message` and `messageService` with a positive integer Unix-second `date` are accepted; `date * 1000` becomes the UTC millisecond sort key. Draft dates, edit dates, dialog indexes, unread changes and observation time are not sort keys.

The account, peer map, message map, manager, generation and username ownership are checked across awaits. A second local dialog lookup checks that `top_message` still identifies the projected message; the cache entry/peer/date is rechecked before publication. Calls share the existing physical two-slot dialog pool and 800 ms batch budget. No additional history/message RPC, navigation, selection, scrolling, search or read receipt is used. Unknown/error preserves the previous timestamp under the same verified binding. Numeric user/group/channel pins are supported through exact canonical URLs and matching current-account peer records; this does not extend the user-only unread-count semantics to forums/groups.

`messageTime` is separate from unread `found`: an offscreen cached timestamp remains usable even when unread is unknown. The common merge preserves precise clocks under date-only observations, allows an exact time earlier than the synthetic noon of the same day, and persists `lastMsgSource` with the timestamp and precision. On cold start, matching source account/peer/canonical URL evidence protects an already verified timestamp during the first alias binding. Changed account/peer bindings still invalidate old activity. The persisted evidence is not used to resolve usernames.

### Why many Telegram fields disappeared

The previous identity migration deliberately cleared account-less time, preview and author caches on the **first** username binding. `tgIdentityKeys` is session-only, so the same clearing happened again after a cold restart. A stable binding does **not** clear those maps on every poll. However, the old timestamp/preview replenishment depended on visible DOM rows, while the new offscreen dialog adapter replenished only unread. A metadata-only live snapshot found 30 established username bindings, but only 10/39 TG pins with time and 10/39 with preview. This explains the broad missing-field region rather than a special-case sort comparator bug.

The new timestamp path repairs the time side without reading bodies. Restoring missing previews is a separate capability and remains pending; old unbound previews must not be revived as if their account/peer were verified. Same-binding missing-row observations still preserve existing previews.

### Verification and limits

- The metadata-only production-prefix probe recovered valid timestamps for **39/39 current TG pins**, including username and numeric peers, with the service URL unchanged. It did not run the DOM preview collector or deploy the host renderer.
- `tests/telegram-aliases.mjs` exercises the actual serialized collector/scheduler, cold restart, unknown cache, account/mirror/top-message changes, repeated message IDs across peers, metadata errors, body-access guards, and numeric user/chat/channel identities.
- `tests/message-order.mjs` covers MM/TG/MAX/Telemost ordering, midnight, date-only precision, missing observations, restart, and manual priority. These are shared-contract regression tests, not proof of each live service's source coverage.
- MM retains its existing `last_post_at` source. MAX and Telemost still use compact list times: exact offscreen timestamp recovery is **not implemented** for those services. No arbitrary hour is invented from “yesterday”.
- The source patch and offline tests are separate from deployment. No restart, hot replacement, commit or push was performed by this timestamp task; the parent must verify the live host list after applying it.
