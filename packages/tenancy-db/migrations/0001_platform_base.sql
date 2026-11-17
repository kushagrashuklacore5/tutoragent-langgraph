-- Platform base: tenant context helpers used by every RLS policy in every schema.
create or replace function platform.current_tenant() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create or replace function platform.current_user_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function platform.has_role(r text) returns boolean
  language sql stable
  as $$ select r = any(string_to_array(coalesce(current_setting('app.roles', true), ''), ',')) $$;

create table platform.tenants (
  id uuid primary key,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null,
  type text not null check (type in ('institution', 'individual')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  -- policy: { ai: { allowedLocations, requireZeroRetention, forbidTraining, requireDpa, byok }, minAge }
  policy jsonb not null default '{}'::jsonb,
  enabled_modules text[] not null default '{}',
  created_at timestamptz not null default now()
);
-- tenants are visible to a request only for its own tenant (system role bypasses for sign-in lookup)
alter table platform.tenants enable row level security;
alter table platform.tenants force row level security;
create policy tenant_self on platform.tenants using (id = platform.current_tenant());
