-- Institution SSO (OIDC). One identity provider per tenant, configured by issuer.
create table platform.tenant_idp_configs (
  tenant_id uuid primary key references platform.tenants(id) on delete cascade,
  issuer text not null check (issuer ~ '^https?://'),
  client_id text not null check (length(client_id) between 1 and 512),
  -- sealed by the host-provided SecretSealer; never returned by any API
  client_secret_sealed text,
  allowed_domains text[] not null default '{}',
  enabled boolean not null default false,
  email_claim text not null default 'email',
  name_claim text not null default 'name',
  -- claim that must be boolean true for the email to be trusted ('email_verified'; Entra: 'xms_edov')
  email_verified_claim text not null default 'email_verified',
  -- just-in-time provisioning of unknown users as students (default off)
  jit_student_provisioning boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references platform.users(id) on delete set null
);
alter table platform.tenant_idp_configs enable row level security;
alter table platform.tenant_idp_configs force row level security;
create policy tenant_isolation on platform.tenant_idp_configs
  using (tenant_id = platform.current_tenant()) with check (tenant_id = platform.current_tenant());

-- Pending authorization requests: state, nonce and PKCE verifier are server-side, single-use, short-lived.
create table platform.sso_login_states (
  state_hash text primary key,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  -- hash of the browser-binding cookie set at /start (prevents login CSRF / injected callbacks)
  binder_hash text not null,
  nonce text not null,
  code_verifier text not null,
  return_to text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index sso_login_states_tenant_recent on platform.sso_login_states(tenant_id, created_at);
alter table platform.sso_login_states enable row level security;
alter table platform.sso_login_states force row level security;
create policy no_app_access on platform.sso_login_states using (false);
