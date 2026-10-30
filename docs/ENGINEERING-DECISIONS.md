# Engineering decisions

## Immutable attempt snapshots

An assessment template can evolve, but an attempt must remain stable from start to finish. When a student begins, the ordered question set is copied into attempt-owned records. Later template edits cannot change an active or completed attempt.

## Server-side grading

Correct answers never need to reach the browser. The student submits a choice; trusted code verifies ownership, reads the answer key, grades, and persists the result. This limits answer leakage and keeps grading behavior consistent across clients.

## Disconnect-aware timing

A high-stakes timed flow needs a server-owned clock that tolerates refreshes and short network interruptions. Section state records elapsed activity and heartbeats, allowing the server to decide whether time is active, paused, resumed, or expired.

## Pure scoring core

The scoring engine accepts graded responses and reference weights, then returns result projections without database or network calls. Pure functions support:

- Boundary tests for thresholds.
- Regression tests for previously observed scoring defects.
- Worked examples that double as documentation.
- Safe refactoring of persistence code around a stable domain core.

## Compute once, read many

High-consequence result calculations run at finalization and are stored as projections. The results screen assembles persisted outputs rather than rerunning the model on every read. This improves consistency, auditability, and response time.

## Blueprint-based authoring

Educators describe coverage as required slots across subject, topic, subtopic, and difficulty. The builder fills those slots from eligible reviewed content while preserving special structures such as passage groups. Teachers can inspect and replace selections before saving.

## Rendering as a subsystem

Assessment content includes plain text, mathematical notation, diagrams, passages, and uploaded media. Rendering has dedicated normalization, validation, and build-time guards because a small parser change can alter many existing questions at once.

## Two-client serverless security pattern

Trusted functions separate identity verification from privileged work:

1. A user-scoped client validates the caller and ownership.
2. A server-scoped client performs the narrowly authorized action.

The privileged client is never exposed to the browser, and the function does not trust an ID merely because the caller supplied it.

## Human-centered AI

The useful unit is not “a generated question”; it is “a reviewed candidate with provenance, validation results, and a clear publication state.” The workflow is designed around educator accountability rather than automatic volume.
