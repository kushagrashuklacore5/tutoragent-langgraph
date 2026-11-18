-- Agentic learning companion: durable learner profile, conversations (session state), messages (encrypted),
-- tool-call traces, and workflow tasks (milestones / checkpoints). All owner-only: educators never read them.

create table education_tutor.agent_profiles (
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  -- the structured profile (goals, preferences, open doubts) encrypted at rest (deps.crypto)
  profile_enc text not null,
  nudges_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table education_tutor.agent_conversations (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  -- structural session state only (phase, asked slots, proposal, workflow steps): no free text
  state jsonb not null,
  version int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index agent_conversations_user on education_tutor.agent_conversations (tenant_id, user_id, updated_at desc);

create table education_tutor.agent_messages (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  conversation_id uuid not null references education_tutor.agent_conversations(id) on delete cascade,
  role text not null check (role in ('student', 'agent')),
  kind text not null default 'text' check (kind in ('text', 'nudge')),
  content_enc text not null,
  -- structured cards (plan proposal, links): course structure only, no student free text
  cards jsonb not null default '[]',
  usage jsonb,
  dedupe_key text,
  seen_at timestamptz,
  created_at timestamptz not null default now()
);
create index agent_messages_conv on education_tutor.agent_messages (conversation_id, created_at);
create unique index agent_messages_dedupe on education_tutor.agent_messages (tenant_id, user_id, dedupe_key) where dedupe_key is not null;

create table education_tutor.agent_tool_calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  conversation_id uuid references education_tutor.agent_conversations(id) on delete cascade,
  tool text not null,
  status text not null check (status in ('ok', 'error', 'rejected', 'timeout', 'needs_approval')),
  -- ids/numbers only; free-text arguments are represented by a digest
  args jsonb not null default '{}',
  args_digest text,
  error_code text,
  duration_ms int,
  attempts int not null default 1,
  idempotency_key text,
  result jsonb,
  created_at timestamptz not null default now()
);
create unique index agent_tool_calls_idem on education_tutor.agent_tool_calls (tenant_id, user_id, idempotency_key) where idempotency_key is not null and status = 'ok';
create index agent_tool_calls_conv on education_tutor.agent_tool_calls (conversation_id, created_at);

create table education_tutor.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  course_id uuid not null references education_tutor.courses(id) on delete cascade,
  plan_version int not null,
  kind text not null check (kind in ('milestone', 'checkpoint')),
  seq int not null,
  title text not null,
  concept_ids uuid[] not null default '{}',
  due_on date not null,
  status text not null default 'pending' check (status in ('pending', 'done', 'missed', 'cancelled')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id, course_id, plan_version, kind, seq)
);
create index agent_tasks_open on education_tutor.agent_tasks (tenant_id, user_id, status, due_on);

do $$
declare t text;
begin
  foreach t in array array['agent_profiles','agent_conversations','agent_messages','agent_tool_calls','agent_tasks'] loop
    execute format('alter table education_tutor.%I enable row level security', t);
    execute format('alter table education_tutor.%I force row level security', t);
    execute format($p$create policy owner_only on education_tutor.%I using (tenant_id = platform.current_tenant() and user_id = platform.current_user_id()) with check (tenant_id = platform.current_tenant() and user_id = platform.current_user_id())$p$, t);
  end loop;
end $$;

-- plans re-built by the agent after an assessment result
alter table education_tutor.plans drop constraint if exists plans_trigger_check;
alter table education_tutor.plans add constraint plans_trigger_check check (trigger in ('request', 'scheduled_refresh', 'missed_recovery', 'assessment_update', 'agent'));
