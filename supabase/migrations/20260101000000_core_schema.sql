-- ============================================================================
-- CORE SCHEMA — content bank, diagnostic authoring, runtime, results, scoring
-- ============================================================================
-- The content/diagnostic tables predate this project's migration history: they
-- were created by hand early on and evolved in place. This file reconstructs
-- them as a single reproducible migration so the schema can be stood up from
-- nothing with `supabase db reset`.
--
-- Layout, in dependency order:
--   1. Content bank      — questions, stimuli, instructions, visual assets
--   2. Diagnostic authoring — templates and their ordered question lists
--   3. Diagnostic runtime   — sessions, sections, frozen question snapshots
--   4. Scoring reference    — taxonomy, importance weights, model parameters
--   5. Results              — everything finalize-exam writes, get-results reads
--
-- Later migrations in this directory build on it: practice history, quizzes,
-- the widened visual-asset types, and the activity-based section clock.
--
-- Two invariants shape most of this file:
--   * A started attempt is frozen. Responses hang off session_questions, never
--     off the template, so editing an exam cannot mutate an exam in progress.
--   * Correct answers never leave the server. questions.correct_answer is
--     readable only by trusted roles; grading happens in edge functions.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ============================================================================
-- 1. CONTENT BANK
-- ============================================================================

-- ── Shared passages (Reading) and other stimulus material ──
-- A passage is authored once and shared by every question that references it.
-- stimulus_group_key groups passage families (an original plus its variants)
-- so authoring tools and AI generation can reason about a family as a unit.
create table if not exists public.stimuli (
  id                 uuid        primary key default gen_random_uuid(),
  stimulus_group_key text        not null,
  stimulus_title     text,
  stimulus_type      text,                 -- e.g. reading_passage
  stimulus_text      text,
  created_at         timestamptz not null default now()
);

create index if not exists idx_stimuli_group
  on public.stimuli (stimulus_group_key);

-- ── Reusable instruction / rubric blocks ──
-- Entrance-exam items are often grouped under one instruction ("For items 21-25,
-- identify the error"). Storing the block once keeps it identical across every
-- question in the group and prevents it being restated per item.
create table if not exists public.instructions (
  id               uuid        primary key default gen_random_uuid(),
  instruction_text text        not null,
  instruction_type text,
  created_at       timestamptz not null default now()
);

-- ── The question bank ──
-- Every authoring surface, the exam/quiz builders, the AI generator, the
-- student runtime and every export read this one table.
create table if not exists public.questions (
  id               uuid        primary key default gen_random_uuid(),

  -- Taxonomy. subtopic is NOT NULL and stores '' rather than NULL when absent,
  -- because it is part of composite lookups and SQL NULL breaks equality joins.
  subject          text        not null,
  topic            text        not null default '',
  subtopic         text        not null default '',
  difficulty_level text        not null,

  question_text    text        not null,
  choice_a         text,
  choice_b         text,
  choice_c         text,
  choice_d         text,
  choice_e         text,                   -- legacy 5-choice rows; new content is A–D
  correct_answer   text        not null,   -- stored lowercase in current flows

  -- Provenance. Constrained so an import cannot invent a source.
  source_school    text        not null,

  -- Serving state. Only `active` is eligible for auto-pick into an exam.
  status           text        not null default 'draft',

  stimulus_id      uuid        references public.stimuli(id)      on delete set null,
  instruction_id   uuid        references public.instructions(id) on delete set null,

  -- Optional presentation payloads.
  render_markup    text,                   -- special markup, mainly error-identification items
  svg_content      text,                   -- inline SVG diagram stored on the row

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint questions_difficulty_level_check
    check (difficulty_level in ('easy', 'medium', 'hard')),

  constraint questions_source_school_check
    check (source_school in ('UPCAT', 'ACET', 'DCAT', 'USTET', 'AI Generated')),

  constraint questions_status_check
    check (status in ('active', 'draft', 'retired'))
);

-- The exam builder's hot path: "give me active items for this scope at this
-- difficulty". Ordering the index by the way the builder filters keeps
-- auto-pick a single index scan even as the bank grows.
create index if not exists idx_questions_scope
  on public.questions (subject, topic, subtopic, difficulty_level, status);

create index if not exists idx_questions_status
  on public.questions (status);

create index if not exists idx_questions_stimulus
  on public.questions (stimulus_id)
  where stimulus_id is not null;

-- ── Uploaded figures ──
-- Bytes live in the `question-visuals` storage bucket; only metadata is here.
-- Inline SVGs bypass this entirely and live in questions.svg_content.
create table if not exists public.visual_assets (
  id           uuid        primary key default gen_random_uuid(),
  storage_path text        not null,
  asset_type   text,
  alt_text     text,
  caption      text,
  created_at   timestamptz not null default now(),

  -- Widened later by 20260723000000_relax_visual_assets_asset_type.sql, once the
  -- uploader started accepting every format the renderer can display.
  constraint visual_assets_asset_type_check
    check (asset_type in ('image', 'figure', 'diagram', 'chart'))
);

-- ── Question ↔ figure join ──
-- Many-to-many on purpose: one diagram can serve a whole passage block, and one
-- question can carry several figures (a stimulus chart plus a per-item diagram).
create table if not exists public.question_visual_assets (
  id                      uuid    primary key default gen_random_uuid(),
  question_id             uuid    not null references public.questions(id)      on delete cascade,
  visual_asset_id         uuid    not null references public.visual_assets(id)  on delete cascade,
  display_order           integer not null default 0,
  marked_segment          text,             -- which part of the item the figure belongs to
  passage_question_range  text,             -- e.g. "21-25" for a shared passage figure
  created_at              timestamptz not null default now(),

  unique (question_id, visual_asset_id, display_order)
);

create index if not exists idx_qva_question
  on public.question_visual_assets (question_id, display_order);

-- ============================================================================
-- 2. DIAGNOSTIC AUTHORING
-- ============================================================================

-- ── One saved exam definition ──
-- is_active/is_primary form a two-bit state the assemble-exam picker reads:
--   (true,  true)  → the primary diagnostic new students receive
--   (true,  false) → an available retake
--   (false, false) → retired; existing attempts still resolve, no new ones start
create table if not exists public.diagnostic_templates (
  id              uuid        primary key default gen_random_uuid(),
  code            text        not null unique,
  version         integer     not null default 1,
  total_questions integer     not null default 0,
  is_active       boolean     not null default false,
  is_primary      boolean     not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- At most one primary template at a time. Enforced in the database rather than
-- in the app, because "two primaries" would silently split the student cohort
-- across two different exams.
create unique index if not exists uniq_diagnostic_templates_primary
  on public.diagnostic_templates (is_primary)
  where is_primary;

-- ── Ordered question list for one template ──
-- The exam builder deletes and re-inserts every row for a template on save.
-- Safe only because attempts snapshot into session_questions first.
create table if not exists public.diagnostic_template_questions (
  id            uuid        primary key default gen_random_uuid(),
  template_id   uuid        not null references public.diagnostic_templates(id) on delete cascade,
  question_id   uuid        not null references public.questions(id)            on delete restrict,
  section_name  text        not null,
  display_order integer     not null,
  created_at    timestamptz not null default now(),

  constraint dtq_section_name_check
    check (section_name in ('language', 'reading', 'math', 'science', 'social_studies', 'logic')),

  unique (template_id, display_order)
);

create index if not exists idx_dtq_template
  on public.diagnostic_template_questions (template_id, section_name, display_order);

-- ============================================================================
-- 3. DIAGNOSTIC RUNTIME
-- ============================================================================

-- ── One student's attempt at one template ──
create table if not exists public.diagnostic_sessions (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users(id)                  on delete cascade,
  template_id     uuid        not null references public.diagnostic_templates(id) on delete restrict,
  status          text        not null default 'in_progress',
  current_section text,
  total_questions integer     not null default 0,
  started_at      timestamptz not null default now(),
  completed_at    timestamptz,

  constraint diagnostic_sessions_status_check
    check (status in ('in_progress', 'ready_to_finalize', 'completed', 'expired'))
);

create index if not exists idx_diagnostic_sessions_user
  on public.diagnostic_sessions (user_id, status);

-- ── Per-section clock and state ──
-- As originally shaped: a budget plus a start time. The activity-based clock
-- (elapsed_seconds, last_activity_at) is added by
-- 20260803000000_section_clock_activity.sql, which documents why a wall clock
-- was the wrong model for a timed exam over an unreliable connection.
create table if not exists public.session_sections (
  id                 uuid        primary key default gen_random_uuid(),
  session_id         uuid        not null references public.diagnostic_sessions(id) on delete cascade,
  section_name       text        not null,
  status             text        not null default 'not_started',
  time_limit_seconds integer     not null,
  started_at         timestamptz,
  submitted_at       timestamptz,

  constraint session_sections_status_check
    check (status in ('not_started', 'in_progress', 'paused', 'submitted', 'expired')),

  unique (session_id, section_name)
);

-- ── Frozen snapshot of the questions assigned to an attempt ──
-- The reason the whole runtime exists as its own set of tables: an attempt is
-- immutable once started. Editing the template afterwards cannot reorder,
-- add to, or remove from an exam a student is sitting.
create table if not exists public.session_questions (
  id            uuid    primary key default gen_random_uuid(),
  session_id    uuid    not null references public.diagnostic_sessions(id) on delete cascade,
  question_id   uuid    not null references public.questions(id)           on delete restrict,
  section_name  text    not null,
  display_order integer not null,
  locked        boolean not null default false,

  unique (session_id, display_order)
);

create index if not exists idx_session_questions_session
  on public.session_questions (session_id, section_name, display_order);

-- ── Graded answers ──
-- is_correct is written by submit-answer after reading questions.correct_answer
-- server-side. The browser never sees a key and never computes correctness.
create table if not exists public.session_responses (
  id                  uuid        primary key default gen_random_uuid(),
  session_question_id uuid        not null references public.session_questions(id) on delete cascade,
  selected_answer     text,
  is_correct          boolean,
  submitted_at        timestamptz not null default now(),

  -- One response per question. Changing an answer upserts this row rather than
  -- appending, so a section's response count is always its answered count.
  unique (session_question_id)
);

-- ============================================================================
-- 4. SCORING REFERENCE
-- ============================================================================

-- Course clusters the recommendation engine ranks a student against.
create table if not exists public.course_classifications (
  code        text primary key,
  name        text not null,
  description text
);

-- The bridge between question taxonomy and course clusters, and the single most
-- important table in scoring: it says how much each subtopic matters to each
-- cluster. One row per (subtopic, cluster) pair, so it grows as the product of
-- taxonomy size and cluster count.
create table if not exists public.subtopic_classification_importance (
  id                  uuid    primary key default gen_random_uuid(),
  subject             text    not null,
  topic               text    not null default '',
  subtopic            text    not null default '',
  classification_code text    not null references public.course_classifications(code) on delete cascade,
  importance_label    text,                 -- Low | Medium | High
  importance_weight   numeric not null default 1,

  unique (subject, topic, subtopic, classification_code)
);

create index if not exists idx_sci_scope
  on public.subtopic_classification_importance (subject, topic, subtopic);

-- Per-university subject multipliers: the same answer sheet yields a different
-- predicted standing per institution, because institutions weight subjects
-- differently.
create table if not exists public.university_subject_weights (
  id                uuid    primary key default gen_random_uuid(),
  university_code   text    not null,
  subject           text    not null,
  weight_multiplier numeric not null default 1,

  unique (university_code, subject)
);

-- Scoring parameters live in the database, not in application constants, so a
-- model can be re-tuned without a redeploy.
--
-- Versioning is by `active_from` rather than an is_active flag: finalize-exam
-- selects the newest model whose active_from has passed. That makes a tuning
-- change a dated, append-only fact — the row that scored a given attempt can
-- still be identified afterwards, which an overwritten flag would destroy.
create table if not exists public.scoring_models (
  id                       uuid        primary key default gen_random_uuid(),
  name                     text        not null unique,
  active_from              timestamptz not null default now(),

  difficulty_easy_weight   numeric     not null default 1.0,
  difficulty_medium_weight numeric     not null default 1.5,
  difficulty_hard_weight   numeric     not null default 2.0,

  -- fit_score = alpha_weight * WPS + beta_weight * CTR
  alpha_weight             numeric     not null default 0.70,
  beta_weight              numeric     not null default 0.30,

  -- Share of a cluster's high-importance subtopics that must be passed for the
  -- subtopic to count towards CTR.
  critical_threshold       numeric     not null default 0.60,

  created_at               timestamptz not null default now(),

  constraint scoring_models_weights_sum
    check (alpha_weight + beta_weight = 1.0)
);

create index if not exists idx_scoring_models_active_from
  on public.scoring_models (active_from desc);

-- Convenience view over the same selection finalize-exam makes.
create or replace view public.active_scoring_model as
  select *
  from public.scoring_models
  where active_from <= now()
  order by active_from desc
  limit 1;

-- ============================================================================
-- 5. RESULTS
-- ============================================================================
-- Written once by finalize-exam, read many times by get-results. High-
-- consequence numbers are computed at finalization and stored, never
-- recalculated per page view — a student's score must not move because a
-- scoring parameter was tuned after they finished.
--
-- Both raw and weighted figures are kept. The raw counts are what a student
-- recognises ("21 of 40"); the weighted score is what the model ranks on.
-- Storing only the weighted score would make a result impossible to explain.

create table if not exists public.session_subject_scores (
  id             uuid    primary key default gen_random_uuid(),
  session_id     uuid    not null references public.diagnostic_sessions(id) on delete cascade,
  subject        text    not null,
  raw_correct    integer not null default 0,
  raw_total      integer not null default 0,
  weighted_score numeric,

  unique (session_id, subject)
);

create table if not exists public.session_topic_scores (
  id             uuid    primary key default gen_random_uuid(),
  session_id     uuid    not null references public.diagnostic_sessions(id) on delete cascade,
  subject        text    not null,
  topic          text    not null,
  raw_correct    integer not null default 0,
  raw_total      integer not null default 0,
  weighted_score numeric,

  unique (session_id, subject, topic)
);

-- perf_score is the plain correct/total ratio for the subtopic; mastery_band is
-- its label. The ratio is kept alongside the band because the recommendation
-- pass ranks gaps by magnitude, not by band.
create table if not exists public.session_subtopic_scores (
  id           uuid    primary key default gen_random_uuid(),
  session_id   uuid    not null references public.diagnostic_sessions(id) on delete cascade,
  subject      text    not null,
  topic        text    not null default '',
  subtopic     text    not null default '',
  raw_correct  integer not null default 0,
  raw_total    integer not null default 0,
  perf_score   numeric,
  mastery_band text,

  unique (session_id, subject, topic, subtopic)
);

-- Course-cluster fit, with its two inputs preserved rather than collapsed:
--   wps_score  weighted performance on the subtopics this cluster cares about
--   ctr_score  coverage — how much of the cluster's critical material was tested
--   fit_score  alpha * wps + beta * ctr, scaled to 0..100
--   fit_rank   1 = best fit
-- Keeping wps and ctr is what makes a fit score auditable after the fact: a low
-- score caused by weak performance and one caused by thin coverage need
-- different advice, and the composite alone cannot tell them apart.
create table if not exists public.session_classification_scores (
  id                  uuid    primary key default gen_random_uuid(),
  session_id          uuid    not null references public.diagnostic_sessions(id) on delete cascade,
  classification_code text    not null references public.course_classifications(code) on delete restrict,
  wps_score           numeric,
  ctr_score           numeric,
  fit_score           numeric,
  fit_rank            integer,

  unique (session_id, classification_code)
);

create index if not exists idx_scs_session_rank
  on public.session_classification_scores (session_id, fit_rank);

-- One row per session: the headline readiness number and its tier label.
create table if not exists public.session_readiness_tiers (
  id             uuid    primary key default gen_random_uuid(),
  session_id     uuid    not null references public.diagnostic_sessions(id) on delete cascade,
  overall_score  numeric,
  readiness_tier text,

  constraint session_readiness_tiers_tier_check
    check (readiness_tier in ('Highly Ready', 'Ready', 'Conditionally Ready', 'Not Yet Ready')),

  unique (session_id)
);

-- One row per session. Arrays rather than child tables because these are a
-- rendered report, not a queryable relation — nothing joins to a strength.
create table if not exists public.session_recommendations (
  id                               uuid   primary key default gen_random_uuid(),
  session_id                       uuid   not null references public.diagnostic_sessions(id) on delete cascade,
  primary_classification_code      text   references public.course_classifications(code) on delete set null,
  alternative_classification_codes text[] not null default '{}',
  strengths                        text[] not null default '{}',
  weaknesses                       text[] not null default '{}',
  study_focus                      text,

  unique (session_id)
);

create table if not exists public.session_university_predictions (
  id               uuid    primary key default gen_random_uuid(),
  session_id       uuid    not null references public.diagnostic_sessions(id) on delete cascade,
  university_code  text    not null,
  predictive_index numeric,
  profile_label    text,

  constraint session_university_predictions_label_check
    check (profile_label in ('High Probability', 'Good Probability', 'Borderline', 'Low Probability')),

  unique (session_id, university_code)
);

-- Percentiles are the one result that depends on the whole cohort, so they are
-- computed last and kept in their own table: a single generic shape covering
-- overall, per-subject and per-cluster standing.
--
-- They are also the one result that is honestly unreliable at low cohort sizes.
-- finalize-exam computes them regardless and says so in a comment rather than
-- silently presenting a percentile derived from a handful of sessions.
create table if not exists public.session_percentiles (
  id              uuid        primary key default gen_random_uuid(),
  session_id      uuid        not null references public.diagnostic_sessions(id) on delete cascade,
  target_type     text        not null,   -- overall | subject | classification
  target_code     text        not null,   -- 'overall', a subject name, or a cluster code
  percentile_rank integer,
  created_at      timestamptz not null default now(),

  constraint session_percentiles_target_type_check
    check (target_type in ('overall', 'subject', 'classification')),

  constraint session_percentiles_rank_range
    check (percentile_rank between 1 and 99),

  unique (session_id, target_type, target_code)
);

-- ============================================================================
-- ADMIN SUPPORT
-- ============================================================================

-- Allow-list of accounts permitted to use the admin application. Membership is
-- a row here, not a flag on auth.users, so it can be revoked without touching
-- the auth schema.
create table if not exists public.admin_users (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  email      text,
  role       text        not null default 'admin',
  created_at timestamptz not null default now(),

  constraint admin_users_role_check check (role in ('admin', 'editor', 'viewer'))
);

-- ============================================================================
-- TOUCH TRIGGERS
-- ============================================================================

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_questions_touch on public.questions;
create trigger trg_questions_touch
  before update on public.questions
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_diagnostic_templates_touch on public.diagnostic_templates;
create trigger trg_diagnostic_templates_touch
  before update on public.diagnostic_templates
  for each row execute function public.touch_updated_at();
