# Auth session rollout and rollback

This runbook covers the retry-safe refresh release only. Auth remains the
owner of session state and replay keys; clients and deployment tooling do not
reimplement refresh decisions.

## Non-negotiable invariants

- Grace is fixed at `G = 60s`.
- Legacy and retry-safe refresh writers must never serve traffic at the same
  time. Do not use a rolling mixed-algorithm deployment.
- The replay migration is additive. Rollback never drops
  `flora_core.auth_refresh_replays`, any `__flora_migrations_*` table, or the
  replay key ring.
- Keep every decrypt-only replay key for at least replay TTL plus cleanup lag.
- After broad client rollout, a non-replay-safe backend is not a rollback
  target. Recover with a forward fix.
- Never put access tokens, refresh tokens, ciphertext, nonce, or key material
  in logs, dashboards, or release records.

## Metrics and baseline

The implementation uses log-derived counters rather than adding a metrics
runtime dependency. Events use target `flora_auth::refresh_outcome`, field
`counter_delta=1`, and one of these metric names. Field `protocol` separates
the disabled (`legacy`) baseline from enabled (`retry_safe`) traffic:

- `refresh_rotated`: a successful legacy rotation or retry-safe
  `RefreshOutcome::Rotated`.
- `refresh_replayed`: a `RefreshOutcome::Replayed` grant that was successfully
  decrypted and decoded.
- `refresh_reuse_revoked`: legacy reuse/rotation conflict or
  `RefreshOutcome::ReusedOutsideGrace`; the session was revoked.
- `refresh_error`: invalid refresh (`outcome=invalid`, `status=401`) or an
  internal refresh failure (`outcome=internal`, `status=500`).
- `refresh_draining`: a rotation/reuse request refused because the instance is
  draining (`outcome=draining`, `status=503`), with no session mutation. Zero
  in normal operation; non-zero only during a drain rollback.

Create log-pipeline counters keyed by `metric`, `outcome`, `status`, release,
and instance. Ingress refresh request/status counters remain the denominator
and cover requests rejected before the typed repository outcome.

Before enabling `Auth:RetrySafeRefresh`, capture at least one representative
peak/off-peak cycle (normally 24 hours) in the release record:

- refresh request count and 2xx/4xx/5xx rates;
- session revoke rate and unexpected-login/logout reports;
- client coordinator outcomes (`ready`, `invalid`, `transient`,
  `storage_pending`, `superseded`);
- dashboard/query links, exact time range, release, traffic cohort, and the
  upper control bound used by the canary.

The canary halts immediately when:

- refresh 5xx or reuse-revoke rate exceeds its captured upper bound in two
  consecutive five-minute windows (one confirmed event if baseline was zero);
- a server 2xx refresh corresponds to client `invalid`/logout, or server
  terminal invalid corresponds to client `ready`;
- replay decrypt/decode errors appear, outcome totals no longer reconcile with
  ingress totals, or instances disagree on active/decrypt-only key ids.

Do not widen a threshold during the canary. Disable progression, preserve
logs/key configuration, and choose the applicable rollback domain below.

## Two-phase backend activation

1. Apply the backward-compatible migration with `flora-migrate`.
2. Deploy the new binary to every instance with
   `Auth:RetrySafeRefresh=false`. Install the same active replay key and all
   decrypt-only keys on every instance.
3. Verify health, migration history in
   `flora_core.__flora_migrations_auth`, key-id parity, and legacy refresh.
4. Remove old refresh writers from load balancing and wait for their active
   refresh requests to finish. No legacy writer may remain.
5. Enable `Auth:RetrySafeRefresh=true` on the complete refresh-serving pool as
   one coordinated protocol cutover, restart, and verify all instances before
   returning traffic.
6. Canary, then soak through several real refresh cycles. Staging may use an
   expired/fake-clock access token; production JWT TTL is not changed.

The feature flag is a protocol cutover, not an ordinary per-instance rollout.
Enabling `Auth:RetrySafeRefresh` is wired end to end: the product composition
builds the replay config from `ReplayConfig::from_config` and calls
`compose_with_replay`. When enabled it also starts the Auth-owned bounded
ciphertext cleanup job (batched delete over the `valid_until` index, structured
row-count logs, no tokens); when disabled the job is never spawned and legacy
refresh is used. Misconfiguration (enabled but no/invalid `Auth:ReplayKeyRing`)
is a startup fail-fast, not a silent fall back to legacy.

## Release domains

Advance and record each domain separately:

1. additive schema;
2. feature-gated backend, initially disabled;
3. `@flora/client-core`;
4. Web storage bridge;
5. Web/backend soak;
6. Mobile canary plus Android/iOS device smoke;
7. Mobile broadcast;
8. late legacy-storage cleanup in a separate release.

A failed domain rolls back only that domain when its compatibility window
allows it. Do not combine schema removal, backend rollback, client rollback,
and legacy cleanup.

## Installer behavior

`Scripts/remote-install-flora-api.sh` creates immutable directories under
`/opt/flora-ecosystem/runtime/gateway/releases/`. It points `staged` at the new
release, runs that release's migrator, and changes `current` atomically only
after migration succeeds. A failed start, `/health`, or `/version` check
restores `current` to the previous release and restarts it. Applied additive
migrations and `/etc/flora-ecosystem/flora-api.env` are retained.

That automatic restore is safe during phase one, while replay is disabled, or
when the previous release is itself replay-safe. It is not permission to
restore a legacy algorithm after protocol activation. New release directories
carry `auth-retry-safe-capable`; when the shared environment enables retry-safe
refresh, the installer refuses to restore an unmarked previous release.

## Auth drain rollback

A safe rollback from an active retry-safe writer to a legacy writer uses the
Auth-owned drain state. Drain is implemented in `flora-auth`: the refresh
service holds a shared atomic drain flag consulted inside the refresh
transaction (`RefreshOutcome::Draining` when the decision would rotate or
reuse-revoke). The runbook procedure:

1. Keep the retry-safe binary and replay key ring running.
2. Enter drain on every refresh-serving instance. Set `Auth:RefreshDrain=true`
   (config/env) and restart the same retry-safe binary, or flip it in-process
   via `ReplayConfig::set_drain(true)` if an admin channel is wired. Drain has
   no effect unless `Auth:RetrySafeRefresh` is already enabled.
3. In drain, `Replayed` still returns the exact stored replacement within grace;
   any decision that would create a new rotation — or a reuse-outside-grace
   revoke — instead returns HTTP `503` with **no session mutation** (never a
   false revoke). Logout, revoke-others, and password-change endpoints remain
   authoritative and continue to revoke.
4. Remove any non-draining instance. Wait at least
   `60s + maximum refresh request timeout` from the last possible rotation.
5. Confirm no rotations are emitted during the full wait (watch the
   `refresh_rotated` counter go to zero and `refresh_draining` absorb retries)
   and in-flight refresh requests are zero.
6. Only then atomically restore the previous binary and verify health.
7. Leave the replay table, migration history, active/decrypt-only keys, and
   ciphertext cleanup job intact.

`Auth:RetrySafeRefresh=false` is **not** drain mode: it immediately selects the
legacy algorithm and can revoke a family whose response was lost. Always drain
first (`Auth:RefreshDrain=true` on the retry-safe binary), never flip
`Auth:RetrySafeRefresh` off directly, when rolling back an active writer.

The installer's pre-activation health rollback (phase one, replay disabled) is
independent of this drain procedure.

## Completion

- Reconcile all four refresh counters with ingress status totals.
- Finish the soak without canary halt conditions.
- Record Web mixed-version bridge results and Mobile device-smoke exit codes.
- Broadcast Mobile only after the canary and soak pass.
- Remove legacy Web/Mobile storage only in the final cleanup domain.
