-- Marking crash recovery. Submission enqueues a grading job; grading is claimed per run (grading_attempts),
-- its final write is atomic and serialized on the attempt row, and repeated/concurrent runs are no-ops once
-- the attempt has left 'grading'. After MAX AI attempts the run falls back to deterministic-only marking
-- (written answers go to educator review), so an attempt can never stay in 'grading' forever.
alter table education_tutor.assessment_attempts add column grading_attempts int not null default 0;
alter table education_tutor.assessment_attempts add column grading_started_at timestamptz;
-- last failure (generic, no student content) for students/educators; full history in grading_log
alter table education_tutor.assessment_attempts add column grading_error text;
alter table education_tutor.assessment_attempts add column grading_log jsonb not null default '[]';
create index assessment_attempts_grading on education_tutor.assessment_attempts (grading_started_at) where status = 'grading';

-- Recovery sweep: attempts are owner-only, so the tenant-level sweeper cannot see them. This read-only
-- definer function lists, for the CURRENT tenant only, attempts stuck in 'grading' (ids + owner, no content).
create or replace function education_tutor.stale_grading_attempts(older_than interval) returns table (attempt_id uuid, user_id uuid, grading_attempts int)
  language sql stable security definer set search_path = pg_catalog, platform, education_tutor as $$
  select a.id, a.user_id, a.grading_attempts from education_tutor.assessment_attempts a
   where a.tenant_id = platform.current_tenant() and a.status = 'grading'
     and coalesce(a.grading_started_at, a.submitted_at, a.started_at) < now() - older_than
   order by a.submitted_at limit 200
$$;
revoke all on function education_tutor.stale_grading_attempts(interval) from public;
grant execute on function education_tutor.stale_grading_attempts(interval) to platform_app;
