-- Users are global (one person may belong to several institutions); access is via memberships.
create table platform.users (
  id uuid primary key,
  email text not null unique check (email = lower(email)),
  display_name text not null default '',
  is_platform_admin boolean not null default false,
  -- PD-09: pilot is adults-only. 'minor' attestations are recorded and block sign-in.
  age_attestation text check (age_attestation in ('adult', 'minor')),
  age_attested_at timestamptz,
  created_at timestamptz not null default now()
);

create table platform.memberships (
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null references platform.users(id) on delete cascade,
  roles text[] not null check (cardinality(roles) > 0),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index memberships_user on platform.memberships(user_id);

create table platform.sessions (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null references platform.users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now()
);

create table platform.login_tokens (
  token_hash text primary key,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null references platform.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index login_tokens_user_recent on platform.login_tokens(user_id, created_at);

-- Development-only mail outbox (magic links) until a transactional email provider is chosen (O-5).
create table platform.dev_mail_outbox (
  id uuid primary key,
  to_address text not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now()
);

-- RLS
alter table platform.memberships enable row level security;
alter table platform.memberships force row level security;
create policy tenant_isolation on platform.memberships
  using (tenant_id = platform.current_tenant()) with check (tenant_id = platform.current_tenant());

alter table platform.sessions enable row level security;
alter table platform.sessions force row level security;
create policy own_sessions on platform.sessions
  using (tenant_id = platform.current_tenant() and user_id = platform.current_user_id());

alter table platform.login_tokens enable row level security;
alter table platform.login_tokens force row level security;
create policy no_app_access on platform.login_tokens using (false);

alter table platform.users enable row level security;
alter table platform.users force row level security;
create policy visible_in_tenant on platform.users using (
  id = platform.current_user_id()
  or exists (select 1 from platform.memberships m where m.user_id = users.id and m.tenant_id = platform.current_tenant())
);

alter table platform.dev_mail_outbox enable row level security;
alter table platform.dev_mail_outbox force row level security;
create policy no_app_access on platform.dev_mail_outbox using (false);
