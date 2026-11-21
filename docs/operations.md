# Operations and security boundaries

Checked implementation: 2026-11-13. See PROGRESS.md for executed tests.

## Runtime

The web process handles authentication/review; the independent worker renders and dispatches. PostgreSQL stores transactional jobs, immutable revisions, approval snapshots, attempts, receipts, conversations and append-only application audit events. Jobs use SKIP LOCKED, expiring leases and fencing tokens. Unknown external outcomes stop for reconciliation; they are never automatically replayed as new posts. Demo receipts are explicitly simulated. S3Mock is local test infrastructure only.

Health: `/api/health` checks database and storage. Owner Settings displays worker heartbeat and queue errors. `docker compose logs -f worker web` provides local diagnosis. Dead jobs can be retried from Settings. Unknown deliveries need reconciliation; an ambiguous real post must be inspected using authoritative provider evidence before any retry. Cancel guarantees apply before dispatch only.

## Deployment

Use the Dockerfile for both web and worker, with distinct commands `npm start` and `npm run worker`. Run `npm run migrate` once before starting a new release. Do not seed a live database. The included Compose file is strictly demo configuration; create a separate production deployment and secrets. Terminate TLS at a reverse proxy, set NEXTAUTH_URL to its public HTTPS origin, and preserve secure cookies. Use a least-privilege database role and private object bucket. Database and storage ports must remain private. The worker must remain running after your laptop closes; local Docker alone cannot achieve that while the laptop sleeps.

Before live enablement: verify actual OAuth grants, subscriptions, public media URLs, selected account identity and the implemented dispatch/reconciliation paths; perform credentialed read-only checks; then obtain owner approval of one test post on each explicitly selected test account. Check actual remote visibility, media processing and receipt. No credentials or verified accounts were available during this build.

## Backup/restore procedure

Pause all organizations, stop web and worker for a consistent database/object snapshot, then back up PostgreSQL and the asset volume together. Examples from this directory:

```sh
mkdir -p backups
docker compose stop web worker
docker compose exec -T db pg_dump -U socialagent -d socialagent_demo -Fc > backups/demo.dump
docker run --rm -v socialagent_asset-data:/data:ro -v "$PWD/backups:/backup" alpine:3.22 tar czf /backup/assets.tar.gz -C /data .
docker compose start web worker
```

Back up production encryption key material separately in your secret manager; encrypted tokens cannot be restored without the key. Never include secrets in source or database exports. Test restore in an isolated database/bucket, set outbound disabled, keep worker stopped until all organization/account pauses are checked, restore with pg_restore and extract assets, then verify counts/checksums. A demo rehearsal restored the database to socialagent_restore_check (2 organizations, 5 asset records) and copied the asset volume to socialagent_restore-assets with a recursive byte comparison. No worker was connected to the restored database. Production key-material disaster recovery remains unverified.

Rollback: preserve the matching image tag, lockfile, database backup and assets. Current migrations are additive and version-tracked. Do not attempt a destructive down-migration against changed production data; restore to an isolated stack first.

## Known limits

Login throttling is process-local (use shared edge throttling for production). Initial owners are provisioned by scripts/provision-owner.ts; Settings creates single-use new-member invitations. Existing-account invitation acceptance is still unsupported. Audit append-only semantics are application-level, not a separately administered immutable log. Manual receipt APIs are distinct from API verification. Per-provider concurrency, token refresh locking, production spend metering, retention/deletion and external alert delivery need further implementation. File downloads require tenant membership and return private/no-store headers. Live media-ingestion URLs need bounded public access; authenticated preview URLs are intentionally not suitable for provider ingestion.
