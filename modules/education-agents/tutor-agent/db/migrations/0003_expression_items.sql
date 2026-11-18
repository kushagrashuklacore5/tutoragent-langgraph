-- Symbolic ("expression") practice items, graded by mathematical equivalence in the maths service.
alter table education_tutor.items drop constraint if exists items_type_check;
alter table education_tutor.items add constraint items_type_check check (type in ('mcq', 'numeric', 'expression'));
