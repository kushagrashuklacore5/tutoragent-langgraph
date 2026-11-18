-- Educator question management: items are retired (hidden from practice) rather than deleted, because
-- deleting would cascade-delete students' attempt history.
alter table education_tutor.items add column retired_at timestamptz;
alter table education_tutor.items add column updated_at timestamptz;
create index items_active_by_concept on education_tutor.items (concept_id) where retired_at is null;
