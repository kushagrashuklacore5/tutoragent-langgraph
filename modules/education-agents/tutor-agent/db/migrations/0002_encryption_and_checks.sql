-- Encryption at rest for tutor conversation content, and delayed-check cards.
--
-- Turns: new rows store `content_enc` / `segments_enc` (AES-256-GCM field ciphertext from
-- packages/field-crypto, bound to tenant + table + column + turn id) and leave `content` / `segments`
-- NULL. Encryption needs the application's KeyManager, so it cannot run inside SQL: rows written before
-- this migration stay readable as plaintext (readers accept either form) and are re-encrypted by the
-- daily per-student maintenance job (`education.tutor/student.maintain`), which nulls the plaintext.
-- A later migration will drop `content`/`segments` once `select count(*) ... where content is not null`
-- is 0 in every environment.
alter table education_tutor.turns alter column content drop not null;
alter table education_tutor.turns add column content_enc text;
alter table education_tutor.turns add column segments_enc text;
alter table education_tutor.turns add constraint turns_one_content_form check (num_nonnulls(content, content_enc) = 1);
alter table education_tutor.turns add constraint turns_segments_form check (segments is null or content_enc is null);
create index turns_legacy_plaintext on education_tutor.turns (user_id) where content is not null;
create index turns_session_time on education_tutor.turns (session_id, created_at);

-- Delayed checks: scheduled 14–28 days after a concept looked mastered (or went stale), so the learner
-- model gets spaced, unassisted evidence. One pending (unreviewed) check per student and concept.
alter table education_tutor.cards add column purpose text not null default 'study' check (purpose in ('study', 'delayed_check'));
create unique index cards_pending_delayed_check on education_tutor.cards (user_id, concept_id) where purpose = 'delayed_check' and reps = 0;

-- Plans: why a version was created (student request, scheduled refresh, missed-work recovery).
alter table education_tutor.plans add column trigger text not null default 'request' check (trigger in ('request', 'scheduled_refresh', 'missed_recovery'));
