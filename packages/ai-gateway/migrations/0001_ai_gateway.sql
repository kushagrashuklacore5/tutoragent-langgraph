-- Universal AI Gateway (platform-planning/AI_GATEWAY.md § 14).
-- Platform-scope rows have tenant_id NULL and are invisible to the app role (gateway reads them via
-- the system role). Tenant-scope rows (BYOK) are isolated by RLS.

create table platform.ai_data_keys (
  id uuid primary key,
  tenant_id uuid references platform.tenants(id) on delete cascade,  -- null = platform scope
  wrapped_key bytea not null,
  key_manager text not null,
  created_at timestamptz not null default now()
);
create unique index ai_data_keys_scope on platform.ai_data_keys (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table platform.ai_secrets (
  id uuid primary key,
  tenant_id uuid references platform.tenants(id) on delete cascade,
  data_key_id uuid not null references platform.ai_data_keys(id),
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  fingerprint text not null,
  last4 text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table platform.ai_connections (
  id uuid primary key,
  tenant_id uuid references platform.tenants(id) on delete cascade,
  scope text not null check (scope in ('platform', 'tenant')),
  adapter text not null,
  name text not null,
  base_url text,
  allow_private_network boolean not null default false,
  data_policy jsonb not null,
  enabled_capabilities jsonb,           -- optional allowlist that narrows model capabilities
  enabled_models text[],                -- null = every approved deployment on this connection
  secret_id uuid references platform.ai_secrets(id),
  timeout_ms int not null default 60000 check (timeout_ms between 1000 and 600000),
  infra_cost jsonb,                     -- local models: { currency, inputPerMTok, outputPerMTok }
  enabled boolean not null default true,
  status text not null default 'untested' check (status in ('untested', 'ok', 'failing')),
  last_test jsonb,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope = 'platform') = (tenant_id is null)),
  check (not (scope = 'tenant' and allow_private_network))
);

create table platform.ai_models (
  adapter text not null,
  model_id text not null,
  display_name text,
  origin text not null check (origin in ('curated', 'discovered', 'admin')),
  approved boolean not null default false,
  lifecycle text not null default 'ga' check (lifecycle in ('preview', 'ga', 'deprecated', 'retired')),
  retires_at date,
  declared jsonb not null,              -- Capabilities as declared (docs or hints)
  source_url text,
  source_date date,
  created_at timestamptz not null default now(),
  primary key (adapter, model_id)
);

create table platform.ai_deployments (
  id uuid primary key,
  tenant_id uuid references platform.tenants(id) on delete cascade,
  connection_id uuid not null references platform.ai_connections(id) on delete cascade,
  model_id text not null,
  declared jsonb not null,
  verified jsonb,                       -- Capabilities proven by probes on this connection
  verified_at timestamptz,
  probe_report jsonb,
  pricing jsonb,                        -- { currency, inputPerMTok, outputPerMTok, cachedInputPerMTok?, source, effectiveFrom }
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (connection_id, model_id)
);

create table platform.ai_routes (
  id uuid primary key,
  tenant_id uuid references platform.tenants(id) on delete cascade,
  scope text not null check (scope in ('platform', 'tenant')),
  target text not null check (target ~ '^(task|category):[a-z0-9_.-]+$'),
  environment text not null,
  candidates jsonb not null,            -- [{ deploymentId, params? }]
  version int not null default 1,
  active boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  check ((scope = 'platform') = (tenant_id is null))
);
create unique index ai_routes_active on platform.ai_routes (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), target, environment) where active;

create table platform.ai_eval_standings (
  task_id text not null,
  deployment_id uuid not null references platform.ai_deployments(id) on delete cascade,
  eval_run_id text not null,
  passed boolean not null,
  recorded_at timestamptz not null default now(),
  primary key (task_id, deployment_id)
);

create table platform.ai_operations (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  module_id text not null,
  task_id text not null,
  route_id uuid,
  route_version int,
  deployment_id uuid,
  connection_id uuid,
  adapter text,
  model_id text,
  attempt int not null,
  fallback boolean not null default false,
  byok boolean not null default false,
  status text not null check (status in ('ok', 'error')),
  error_kind text,
  input_tokens int,
  output_tokens int,
  cached_tokens int,
  reasoning_tokens int,
  ttft_ms int,
  latency_ms int not null,
  cost_micros bigint,
  currency text,
  prompt_version text,
  trace_id text,
  created_at timestamptz not null default now()
);
create index ai_operations_tenant_time on platform.ai_operations (tenant_id, created_at desc);

create table platform.ai_budgets (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  module_id text,
  currency text not null,
  monthly_hard_limit_micros bigint not null check (monthly_hard_limit_micros >= 0),
  monthly_soft_limit_micros bigint,
  unique (tenant_id, module_id)
);

-- RLS: tenants see only their own tenant-scope rows; platform rows are invisible to the app role.
do $$
declare t text;
begin
  foreach t in array array['ai_data_keys','ai_connections','ai_deployments','ai_routes','ai_operations','ai_budgets'] loop
    execute format('alter table platform.%I enable row level security', t);
    execute format('alter table platform.%I force row level security', t);
    execute format('create policy tenant_isolation on platform.%I using (tenant_id = platform.current_tenant()) with check (tenant_id = platform.current_tenant())', t);
  end loop;
end $$;

-- secrets are never readable by the app role, in any tenant
alter table platform.ai_secrets enable row level security;
alter table platform.ai_secrets force row level security;
create policy no_app_access on platform.ai_secrets using (false);
revoke select, insert, update, delete on platform.ai_secrets from platform_app;
revoke select, insert, update, delete on platform.ai_data_keys from platform_app;
