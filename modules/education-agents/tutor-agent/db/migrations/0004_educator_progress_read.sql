-- Educators may READ the learning records (evidence, practice attempts, revision cards) of courses
-- they teach, for the learner-progress dashboard. Course-scoped: being an educator in one course gives
-- no access to another course's records. Write access stays owner-only, and conversations
-- (sessions/turns) remain private to the student.
create or replace function education_tutor.teaches(course uuid) returns boolean
  language sql stable security invoker set search_path = pg_catalog, platform as $$
  select exists (
    select 1 from education_tutor.enrolments e
    where e.course_id = course and e.user_id = platform.current_user_id() and e.role = 'educator'
      and e.tenant_id = platform.current_tenant()
  )
$$;

create policy course_educator_read on education_tutor.evidence for select using (
  tenant_id = platform.current_tenant()
  and education_tutor.teaches((select c.course_id from education_tutor.concepts c where c.id = evidence.concept_id))
);
create policy course_educator_read on education_tutor.attempts for select using (
  tenant_id = platform.current_tenant()
  and education_tutor.teaches((select i.course_id from education_tutor.items i where i.id = attempts.item_id))
);
create policy course_educator_read on education_tutor.cards for select using (
  tenant_id = platform.current_tenant() and education_tutor.teaches(cards.course_id)
);
