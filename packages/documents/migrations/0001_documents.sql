-- Documents (platform-planning/KNOWLEDGE_AND_RAG_DESIGN § 2). Owned by the uploader; modules reference them by scope.
create table platform.documents (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  owner_user_id uuid not null,
  owner_module text not null,                 -- module that accepted the upload, e.g. education.tutor
  scope text not null check (length(scope) <= 200),  -- module-defined scope, e.g. course:<uuid>
  visibility text not null check (visibility in ('private', 'scope')),
  trust text not null check (trust in ('verified_course', 'student_upload')),
  filename text not null check (length(filename) between 1 and 255),
  mime text not null,
  kind text not null check (kind in ('pdf', 'docx', 'pptx', 'text')),
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null,
  storage_key text not null,
  version int not null default 1,
  supersedes uuid references platform.documents(id) on delete set null,
  status text not null default 'uploaded' check (status in ('uploaded', 'processing', 'ready', 'failed', 'superseded')),
  stage text,                                  -- last completed pipeline stage (resume point)
  error text,
  page_count int,
  locator_kind text check (locator_kind in ('page', 'slide', 'section')),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index documents_scope on platform.documents (tenant_id, owner_module, scope);

create table platform.document_pages (
  document_id uuid not null references platform.documents(id) on delete cascade,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  page_no int not null check (page_no >= 1),
  text text not null,
  primary key (document_id, page_no)
);

alter table platform.documents enable row level security;
alter table platform.documents force row level security;
-- private documents: only the owner; scope documents: anyone in the tenant (modules add scope checks, e.g. course enrolment)
create policy visible on platform.documents for select using (
  tenant_id = platform.current_tenant() and (visibility = 'scope' or owner_user_id = platform.current_user_id()));
create policy owner_write on platform.documents for all using (
  tenant_id = platform.current_tenant() and owner_user_id = platform.current_user_id())
  with check (tenant_id = platform.current_tenant() and owner_user_id = platform.current_user_id());

alter table platform.document_pages enable row level security;
alter table platform.document_pages force row level security;
create policy via_document on platform.document_pages using (
  tenant_id = platform.current_tenant()
  and exists (select 1 from platform.documents d where d.id = document_pages.document_id))
  with check (tenant_id = platform.current_tenant());
