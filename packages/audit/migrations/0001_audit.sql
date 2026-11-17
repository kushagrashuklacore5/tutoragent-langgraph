-- Append-only audit log. Holds ids and small metadata only, never message or document content.
create table platform.audit_events (
  id uuid primary key,
  tenant_id uuid references platform.tenants(id) on delete restrict,
  actor_user_id uuid,
  action text not null,
  target_type text not null,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  trace_id text,
  created_at timestamptz not null default now()
);
create index audit_events_tenant_time on platform.audit_events(tenant_id, created_at desc);

alter table platform.audit_events enable row level security;
alter table platform.audit_events force row level security;
create policy tenant_read on platform.audit_events for select using (tenant_id = platform.current_tenant());
create policy tenant_insert on platform.audit_events for insert with check (tenant_id = platform.current_tenant());

-- No runtime role may change or delete audit rows.
revoke update, delete, truncate on platform.audit_events from platform_app, platform_system;

create function platform.audit_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end $$;
create trigger audit_no_update before update or delete on platform.audit_events
  for each row execute function platform.audit_immutable();
