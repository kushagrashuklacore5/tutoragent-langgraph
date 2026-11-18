# Operations runbook

Status: the images (`deploy/Dockerfile`) and the local stack (`deploy/docker-compose.yml`) have **not been
built or run** — Docker was not available where they were written. The cloud KMS clients were tested only
against in-process mock servers, never against real AWS/GCP accounts. Cloud infrastructure (F12: managed
Postgres, object store, secret manager, IaC, staging) depends on decision O-3 and does not exist yet.
Everything in this runbook that names a cloud console is therefore a plan, not a rehearsed procedure.

All commands run from the repository root (or the image's `/app`) with the production environment of
[ENVIRONMENT.md](ENVIRONMENT.md) loaded from the secret manager.

## 1. Deploy
1. CI green on the commit (`npm run check`, preflight in test mode, backup/restore drill).
2. Build and push both targets, tagged with the commit SHA (pin the base image digest):
   `docker build -f deploy/Dockerfile --target api -t <registry>/ekbharat-api:<sha> .` (same for `worker`).
3. **Back up** (§ 4) if the release contains migrations.
4. **Migrate** (§ 2) — migrations are forward-only and must be backward compatible with the running version.
5. **Preflight** against production: `node tooling/preflight.ts --json` → must exit 0. It verifies migrations
   are current, RLS has zero violations, the app role is not superuser/BYPASSRLS/table owner, the audit table is
   append-only, env vars, TLS, KMS round trip, mail config and module manifests.
6. Roll out the API, then the worker (rolling, health-checked). Both hosts refuse to start in production when
   any fail-closed rule is violated; the log line names every problem (never secret values).
7. Watch `http_requests_total{status=~"5.."}`, `errors_total`, `otlp_exporter_failed_total` and job backlog for 30 min.
   Roll back by redeploying the previous image tag (the schema stays; migrations are additive).

Container settings: `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges`, run as the image's
non-root `node` user, SIGTERM for shutdown (API drains for `SHUTDOWN_GRACE_MS`, worker stops claiming jobs —
leases of in-flight jobs expire and are retried — both flush telemetry).

## 2. Migrate
`node apps/api/src/cli.ts migrate` with `DATABASE_URL` = owner role. Takes an advisory lock (safe if two run),
applies each file in its own transaction and refuses if an applied file changed. Roles: in production create
`platform_app` (`LOGIN NOSUPERUSER NOBYPASSRLS`) and `platform_system` (`LOGIN NOSUPERUSER BYPASSRLS`) with
passwords from the secret manager *before* the first migrate (see `deploy/compose/initdb/01-roles.sh`).

## 3. Rotate keys
- **KMS key (AWS/GCP):** enable automatic rotation on the key (yearly). Wrapped data keys name the key version,
  so old wraps keep working; nothing to do in the platform. To move to a *different* key: deploy with the new
  `KMS_*` settings **and** keep IAM decrypt permission on the old key until every row of `platform.ai_data_keys`
  is re-wrapped (re-wrap tool: not yet written — open item).
- **Local master key (dev/pilot only):** not rotatable in place; re-create secrets.
- **Provider API keys:** `POST /api/admin/ai/connections/:id/rotate-key` (write-only; cache invalidated).
- **DB role passwords / METRICS_TOKEN / SMTP / OTLP headers:** rotate in the secret manager, `ALTER ROLE ... PASSWORD`
  for DB roles, then rolling restart. Two-phase for METRICS_TOKEN (update the scraper first).

## 4. Backup and restore
Assumptions (to confirm when F12 is built):
- **RPO ≤ 5 min / RTO ≤ 4 h** target, provided by the cloud-managed Postgres (continuous WAL archiving / PITR,
  7–35 day retention, in the India region). **Not configured yet (F12).**
- Logical backups (this tooling) are the portable, provider-independent copy and the input to the restore drill:
  daily, kept 30 days in a separate account/project with object lock. RPO for logical-only recovery = 24 h.

Backup: `node tooling/backup/backup.ts --out /backups` (owner role with BYPASSRLS — tenant tables force RLS).
Produces `<db>-<time>.dump` (pg_dump custom format, consistent snapshot) and `.manifest.json`
(sha256, size, per-table row counts, migration ledger). Ship both to the backup bucket.

Restore drill (monthly, and after every restore tooling change):
`node tooling/backup/restore-verify.ts --backup <file.dump> --target-url <admin URL of a scratch cluster>`
Creates a new `restore_verify_*` database, restores it in a single transaction and verifies checksum, row counts,
migration ledger, RLS policies and — as `platform_app` — that no tenant row is visible without a tenant context
and that sampled tenants see only their own rows; then drops it. Record duration as the measured RTO component.

Real restore: restore into a new database the same way (`--keep`), run preflight against it, then switch
`DATABASE_URL`/`APP_DATABASE_URL`/`SYSTEM_DATABASE_URL` and restart. Never restore over the live database.

## 5. Purge a module
1. Remove it from `modules.config.json`, `node tooling/gen-registries.ts`, deploy (module disabled; data kept).
2. Export per tenant if required: `node apps/api/src/cli.ts module:export <id> --slug <tenant> > export.json`.
3. Back up (§ 4).
4. `node apps/api/src/cli.ts module:purge <id> --confirm <id>` (refused under legal hold; audited).
5. `node apps/api/src/cli.ts module:verify-absent <id>` must print `absent`; preflight must stay green.

## 6. Incident quick reference
- Startup refused in production → read the `Refusing to start in production` list; fix config; rerun preflight.
- `kms_unavailable` / `kms_access_denied` → check IAM/permissions and VPC endpoint; secrets cannot be decrypted
  while KMS is down (fail closed) — AI calls with tenant/platform keys fail, the rest of the platform works.
- Telemetry backlog → `otlp_exporter_dropped_total` rises when the collector is down; the app is unaffected
  (bounded queue, oldest data dropped).
