-- An educator override of an already-settled AI mark must correct the learner evidence that mark created,
-- not leave a contradictory record. Same guards as 0007 (caller teaches the course, response settled);
-- evidence is still one row per response (inserted the first time, corrected afterwards).
create or replace function education_tutor.record_reviewed_evidence(response_id uuid) returns boolean
  language plpgsql security definer set search_path = pg_catalog, platform, education_tutor as $$
declare r record; v_ref text; v_outcome numeric;
begin
  select ar.id, ar.tenant_id, ar.user_id, ar.concept_id, ar.points, ar.max_points, ar.attempt_id, ar.item_id, ar.needs_review, ar.evidence_recorded, c.course_id
    into r from education_tutor.assessment_responses ar join education_tutor.concepts c on c.id = ar.concept_id
   where ar.id = response_id and ar.tenant_id = platform.current_tenant();
  if not found then return false; end if;
  if not education_tutor.teaches(r.course_id) then raise exception 'not an educator of this course' using errcode = '42501'; end if;
  if r.needs_review or r.max_points <= 0 then return false; end if;
  v_ref := 'assessment:' || r.attempt_id || ':' || r.item_id;
  v_outcome := least(1, greatest(0, r.points / r.max_points));
  if r.evidence_recorded then
    update education_tutor.evidence set outcome = v_outcome
     where tenant_id = r.tenant_id and user_id = r.user_id and source_ref = v_ref;
    if not found then
      insert into education_tutor.evidence (tenant_id, user_id, concept_id, kind, outcome, hints_used, source_ref) values (r.tenant_id, r.user_id, r.concept_id, 'diagnostic', v_outcome, 0, v_ref);
    end if;
  else
    insert into education_tutor.evidence (tenant_id, user_id, concept_id, kind, outcome, hints_used, source_ref) values (r.tenant_id, r.user_id, r.concept_id, 'diagnostic', v_outcome, 0, v_ref);
    update education_tutor.assessment_responses set evidence_recorded = true where id = r.id;
  end if;
  -- keep the per-item attempt history consistent with the final mark too
  update education_tutor.attempts a set outcome = v_outcome
    from education_tutor.assessment_responses ar where ar.id = r.id and a.id = ar.item_attempt_id;
  return true;
end $$;
revoke all on function education_tutor.record_reviewed_evidence(uuid) from public;
grant execute on function education_tutor.record_reviewed_evidence(uuid) to platform_app;
