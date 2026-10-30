# Public / private boundary

This repository is a public copy of a system I built and shipped. It exists so
the engineering can be read and assessed. It is not the production deployment,
and it does not carry the production data.

## What is public here

- **The application source.** The admin and authoring app, the student exam and
  results experience, the rendering subsystem, import and export.
- **The entire backend.** All 14 edge functions, the pure scoring engine, the
  section clock, the prompt rules, and their test suites.
- **The schema.** Tables, constraints, indexes, triggers, row-level security
  policies, and the reference data the scoring engine needs to run.
- **The operational toolchain.** The maintenance, audit and export scripts that
  keep a question bank of this size consistent.
- **The documentation.** Architecture, schema reference, edge-function
  contracts, the AI generation internals, the roadmap, and the testing notes —
  including the sections that describe what is still wrong with the system.
- **A synthetic question bank.** 58 fabricated items across all seven subjects,
  written for this repository, in the exact shape the importer and runtime
  expect: a shared reading passage, LaTeX mathematics, inline SVG figures, and
  error-identification markup.

## What is not here

- **The real question bank.** Several thousand curated and generated exam items,
  their passages, and their figures. This is the commercial asset the platform
  is built around, and publishing it would both expose live exam content and
  give away work that is not mine alone to give.
- **Any student, educator, or user record.** No accounts, no attempts, no
  responses, no results, no exports.
- **Scoring parameters tuned against real cohorts.** The schema, the formulae,
  and a working default model are all here. The weights, thresholds, importance
  matrix and university multipliers that were calibrated against actual student
  performance are not — those are the part with commercial value, and the part
  that would be meaningless out of context anyway.
- **Credentials and deployed identifiers.** No keys, no project reference, no
  URLs, no secrets. `.env.example` lists what the system needs; nothing more.
- **Internal operating material.** Row counts, cohort sizes, deployment status,
  incident history, partner and institution names, commercial plans, and the
  internal handover and readiness documents.

## On the synthetic data

Everything in `sample-data/` and `supabase/seed.sql` was written for this
repository. The questions are fabricated, the reading passage is original, the
taxonomy is a representative slice rather than the real one, and the university
names are placeholders. They are shaped to exercise the system — every code path
from CSV import through blueprint assembly, a timed attempt, grading, and a
scored result — not to be a usable study resource.

## On naming

The product's name, branding, and the institutions it works with are not in this
repository. The entrance-exam names that appear in a database constraint are
public standardized exams, not clients.
