-- Learning Studio: interactive books (from the student's own material or generated), their pages of structured
-- blocks (encrypted), versioned notebooks (encrypted), annotations (encrypted text) and an event history.
-- All owner-only: a student's books, notes and highlights are private to them.

create table education_tutor.studio_books (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  course_id uuid not null references education_tutor.courses(id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  mode text not null check (mode in ('source', 'generated')),
  document_id uuid,
  language text not null default 'en' check (language in ('en', 'hi', 'hinglish')),
  -- [{ id, title, pageStart?, pageEnd?, conceptId?, firstPage?, pages?, status: 'pending'|'ready' }]
  outline jsonb not null,
  -- lecture / view / interruption state (positions and ids only)
  state jsonb not null,
  version int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index studio_books_user on education_tutor.studio_books (tenant_id, user_id, updated_at desc);

create table education_tutor.studio_pages (
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  book_id uuid not null references education_tutor.studio_books(id) on delete cascade,
  page_no int not null check (page_no >= 1),
  section_id text not null,
  -- block ids in order (structure only, for positions without decrypting content)
  block_ids text[] not null,
  blocks_enc text not null,
  created_at timestamptz not null default now(),
  primary key (book_id, page_no)
);

create table education_tutor.studio_notebooks (
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  book_id uuid not null references education_tutor.studio_books(id) on delete cascade,
  version int not null check (version >= 1),
  author text not null check (author in ('ai', 'student')),
  doc_enc text not null,
  created_at timestamptz not null default now(),
  primary key (book_id, version)
);

create table education_tutor.studio_annotations (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  book_id uuid not null references education_tutor.studio_books(id) on delete cascade,
  page_no int not null,
  block_id text,
  kind text not null check (kind in ('bookmark', 'highlight', 'note')),
  quote_enc text,
  note_enc text,
  color text check (color in ('yellow', 'green', 'blue', 'pink')),
  created_at timestamptz not null default now()
);
create index studio_annotations_book on education_tutor.studio_annotations (book_id, page_no);

create table education_tutor.studio_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  book_id uuid not null references education_tutor.studio_books(id) on delete cascade,
  kind text not null,
  page_no int,
  -- ids, counts and verdicts only (no student text)
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index studio_events_book on education_tutor.studio_events (book_id, created_at);

do $$
declare t text;
begin
  foreach t in array array['studio_books','studio_pages','studio_notebooks','studio_annotations','studio_events'] loop
    execute format('alter table education_tutor.%I enable row level security', t);
    execute format('alter table education_tutor.%I force row level security', t);
    execute format($p$create policy owner_only on education_tutor.%I using (tenant_id = platform.current_tenant() and user_id = platform.current_user_id()) with check (tenant_id = platform.current_tenant() and user_id = platform.current_user_id())$p$, t);
  end loop;
end $$;
