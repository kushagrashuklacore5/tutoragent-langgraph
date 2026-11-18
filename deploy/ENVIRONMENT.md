# Environment reference

Every environment variable read by the API (`apps/api/src/main.ts`), the worker (`apps/worker/src/main.ts`),
the operations CLI (`apps/api/src/cli.ts`) and the ops tooling. **Prod** = required (or constrained) when
`PLATFORM_ENV=production`; the hosts refuse to start otherwise and `node tooling/preflight.ts` reports it.
Secrets (marked 🔒) come from the cloud secret manager at deploy time — never from images, files in the
repository or command lines.

## Core
| Variable | Prod | Default | Notes |
|---|---|---|---|
| `PLATFORM_ENV` | yes = `production` | `development` | `development` \| `test` \| `production`. Production enables every fail-closed rule below. |
| `DATABASE_URL` 🔒 | required | — | **Owner** role: migrations, module purge, backups. Not used for request handling. Must include `sslmode=verify-full` (or `require`) in production. |
| `APP_DATABASE_URL` 🔒 | required | — | **App** role (`platform_app`): not superuser, `NOBYPASSRLS`, owns no tables — checked at startup. |
| `SYSTEM_DATABASE_URL` 🔒 | required, explicit | `DATABASE_URL` (dev only) | **System** role (`platform_system`, `BYPASSRLS`, not superuser). Must be a different role from owner and app. |
| `PORT` | – | `8080` | API listen port. |
| `PUBLIC_BASE_URL` | https, not localhost | `http://localhost:8080` | Session cookies get `Secure` exactly when this is https. |
| `ALLOWED_ORIGINS` | each https | empty | Comma-separated CORS/CSRF origins (web app). |
| `LOG_LEVEL` | – | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `METRICS_TOKEN` 🔒 | required, ≥ 24 chars | — | Bearer token for `GET /metrics` (Prometheus scrape). |
| `SHUTDOWN_GRACE_MS` | – | `10000` | API: time for in-flight requests after SIGTERM before connections are cut. |
| `WORKER_HEALTH_PORT` | – (set in image) | unset | Worker serves `GET /health` on this port when set. |

## Key management (AI_GATEWAY § 11.1)
| Variable | Prod | Default | Notes |
|---|---|---|---|
| `KMS_PROVIDER` | `aws` or `gcp` | `local` | `local` wraps data keys with `PLATFORM_MASTER_KEY`; refused in production. |
| `PLATFORM_MASTER_KEY` 🔒 | not used | — | 32 random bytes, base64. Required only with `KMS_PROVIDER=local`. |
| `KMS_AWS_KEY_ID` | aws: required | — | Key id, key ARN, alias name or alias ARN of a symmetric KMS key. |
| `KMS_AWS_REGION` / `AWS_REGION` | aws | `ap-south-1` | India: `ap-south-1` (Mumbai) or `ap-south-2` (Hyderabad). |
| `KMS_AWS_ENDPOINT` | – | `https://kms.<region>.amazonaws.com` | VPC interface endpoint override. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` 🔒, `AWS_SESSION_TOKEN` 🔒 | – | – | Static credentials. Prefer a task/pod role (below). |
| `AWS_CONTAINER_CREDENTIALS_FULL_URI` / `_RELATIVE_URI`, `AWS_CONTAINER_AUTHORIZATION_TOKEN(_FILE)` | – | set by ECS / EKS Pod Identity | Container credentials provider. |
| `AWS_EC2_METADATA_SERVICE_ENDPOINT` | – | `http://169.254.169.254` | IMDSv2 fallback (EC2). IRSA web-identity is **not** implemented — use EKS Pod Identity. |
| `KMS_GCP_KEY_NAME` | gcp: required | — | `projects/<p>/locations/asia-south1/keyRings/<r>/cryptoKeys/<k>` (Mumbai; `asia-south2` = Delhi). |
| `KMS_GCP_ENDPOINT` | – | `https://cloudkms.googleapis.com` | Private Service Connect override. |
| `GOOGLE_APPLICATION_CREDENTIALS` 🔒 | – | unset → metadata server | Path to a service-account key file. Prefer the attached service account (GKE Workload Identity / Cloud Run). |
| `GCE_METADATA_HOST` | – | `metadata.google.internal` | Metadata server override. |

## Mail (packages/identity, decision O-5)
| Variable | Prod | Default | Notes |
|---|---|---|---|
| `MAIL_TRANSPORT` | `smtp` or `http_json` | `dev_outbox` (dev) | The dev outbox is refused in production. |
| `MAIL_FROM` | required | — | `"Ek Bharat.AI <no-reply@example.org>"` |
| `SMTP_HOST`, `SMTP_PORT` (587/465), `SMTP_SECURITY` (`starttls`\|`implicit`; `none` refused in prod) | smtp | | |
| `SMTP_USER`, `SMTP_PASSWORD` 🔒 | smtp: required | | `SMTP_AUTH_METHOD` (`PLAIN`\|`LOGIN`), `SMTP_HELO_NAME`, `SMTP_TIMEOUT_MS` optional. |
| `MAIL_API_URL` (https), `MAIL_API_AUTH_HEADER`, `MAIL_API_AUTH_VALUE` 🔒, `MAIL_API_TIMEOUT_MS` | http_json | | Provider-neutral JSON mail API. |

## Documents (packages/documents)
| Variable | Prod | Default | Notes |
|---|---|---|---|
| `DOCUMENTS_ENABLED` | **must be `false` today** | `true` | No production object store exists yet (F12: S3-compatible store in India). Production refuses the local store. |
| `DOCUMENT_STORE` | – | `local` | Only `local` exists. |
| `DOCUMENT_STORE_DIR` | – | `.data/documents` (`/data/documents` in images) | AES-256-GCM encrypted at rest. |
| `DOCUMENT_STORE_KEY` 🔒 | – | derived from `PLATFORM_MASTER_KEY` (HKDF) | 32 bytes base64; required when no local master key exists. |
| `DOCUMENT_SCANNER` | `clamd` | `dev-noop` | The no-op scanner is refused in production. |
| `CLAMD_HOST`, `CLAMD_PORT` (3310), `CLAMD_TIMEOUT_MS` (30000) | clamd | | ClamAV daemon (INSTREAM). |

## Telemetry (OpenTelemetry, off by default)
| Variable | Prod | Default | Notes |
|---|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | recommended (preflight warns) | unset = off | OTLP/HTTP JSON base URL; `/v1/metrics` and `/v1/traces` are appended. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | – | | Full per-signal URLs (override the base). |
| `OTEL_EXPORTER_OTLP_HEADERS` 🔒 | – | | `k=v,k2=v2` (URL-encoded values), e.g. a collector API key. Never logged. |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | – | `10000` | ms per request. |
| `OTEL_METRIC_EXPORT_INTERVAL` | – | `15000` | ms between pushes. |
| `OTEL_SERVICE_NAME` | – | `ekbharat-api` / `ekbharat-worker` | |
| `OTEL_SDK_DISABLED` | – | | `true` turns the exporter off. |

## Maths solver
| Variable | Prod | Default | Notes |
|---|---|---|---|
| `MATH_SOLVER_URL` | when wired | — | e.g. `http://math-solver:8765` (internal network only). Read by `@platform/math-client` once the hosts wire it. |
| `MATH_SOLVER_DIR` | – | `services/math-solver` | Local child-process mode (dev). |

## Tooling, tests and development only
| Variable | Used by | Notes |
|---|---|---|
| `PG_BIN` | `tooling/dev-db.ts`, `tooling/backup/*` | PostgreSQL 17 binaries (pg_dump/pg_restore must be ≥ the server major version). |
| `PGPORT` | `tooling/dev-db.ts` | Local dev cluster port (54329). |
| `RESTORE_APP_PASSWORD` 🔒 | `tooling/backup/restore-verify.ts` | Password of `platform_app` on the scratch restore cluster. |
| `TEST_DATABASE_URL`, `TEST_VERBOSE` | tests | |
| `API_URL` | `apps/web` (Vite dev proxy) | |
| `OLLAMA_HOST`, `OLLAMA_CHAT_MODEL`, `OLLAMA_EMBED_MODEL`, `CONFORMANCE_*` | live conformance | Never set on production hosts. |
