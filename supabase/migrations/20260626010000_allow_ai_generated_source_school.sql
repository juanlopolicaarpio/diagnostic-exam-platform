alter table public.questions
  drop constraint if exists questions_source_school_check;

alter table public.questions
  add constraint questions_source_school_check
  check (
    source_school is null
    or source_school in ('UPCAT', 'ACET', 'DCAT', 'USTET', 'AI Generated')
  );
