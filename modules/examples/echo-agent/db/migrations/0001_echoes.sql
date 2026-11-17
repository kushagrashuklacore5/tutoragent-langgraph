create table examples_echo.echoes (
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  source_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, source_id)
);
alter table examples_echo.echoes enable row level security;
alter table examples_echo.echoes force row level security;
create policy tenant_isolation on examples_echo.echoes
  using (tenant_id = platform.current_tenant()) with check (tenant_id = platform.current_tenant());
