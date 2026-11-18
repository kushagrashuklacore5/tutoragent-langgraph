-- Misconception intelligence: one diagnosis per wrong answer. The AI proposes the error type and the
-- follow-up problems; deterministic rules decide "careless" vs "recurring"; generated problems are kept
-- only when the maths service confirmed their answers, and only answers to those can become evidence.
create table education_tutor.error_diagnoses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  concept_id uuid not null references education_tutor.concepts(id) on delete cascade,
  attempt_id uuid references education_tutor.attempts(id) on delete cascade,
  error_type text not null check (error_type in ('conceptual', 'procedural', 'calculation', 'interpretation', 'prerequisite', 'careless', 'unknown')),
  ai_error_type text not null,
  misconception text not null default '',
  misconception_id uuid references education_tutor.misconceptions(id) on delete set null,
  recurring boolean not null default false,
  feedback jsonb not null,
  -- generated follow-ups: { similar: {stem, answer, verified}, transfer: {...} }; answers never sent to the client
  followups jsonb not null default '{}',
  followup_results jsonb not null default '{}',
  operation_id text,
  created_at timestamptz not null default now()
);
create index error_diagnoses_user_concept on education_tutor.error_diagnoses (user_id, concept_id, created_at desc);
create unique index error_diagnoses_attempt on education_tutor.error_diagnoses (attempt_id) where attempt_id is not null;

alter table education_tutor.error_diagnoses enable row level security;
alter table education_tutor.error_diagnoses force row level security;
create policy owner_only on education_tutor.error_diagnoses
  using (tenant_id = platform.current_tenant() and user_id = platform.current_user_id())
  with check (tenant_id = platform.current_tenant() and user_id = platform.current_user_id());
-- educators of the course see diagnoses (error types / misconceptions), never conversations
create policy course_educator_read on education_tutor.error_diagnoses for select using (
  tenant_id = platform.current_tenant()
  and education_tutor.teaches((select c.course_id from education_tutor.concepts c where c.id = error_diagnoses.concept_id))
);
