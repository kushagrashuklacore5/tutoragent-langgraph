-- Per-tenant data keys for field-level encryption at rest (packages/field-crypto).
-- Keys are stored wrapped by the platform KeyManager (local master key in dev/pilot, cloud KMS later).
-- Only the system role (field-crypto service) reads them; the application role has no access at all.
create table platform.field_data_keys (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  version int not null check (version >= 1),
  wrapped_key bytea not null,
  key_manager text not null,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  unique (tenant_id, version)
);
-- at most one active key per tenant (new data is encrypted with it; retired keys still decrypt)
create unique index field_data_keys_active on platform.field_data_keys (tenant_id) where status = 'active';

alter table platform.field_data_keys enable row level security;
alter table platform.field_data_keys force row level security;
create policy no_app_access on platform.field_data_keys using (false);
revoke select, insert, update, delete on platform.field_data_keys from platform_app;
