create table examples_hello.greetings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  text text not null,
  processed boolean not null default false,
  created_at timestamptz not null default now()
);
alter table examples_hello.greetings enable row level security;
alter table examples_hello.greetings force row level security;
create policy tenant_isolation on examples_hello.greetings
  using (tenant_id = platform.current_tenant()) with check (tenant_id = platform.current_tenant());
