// ============================================================================
// Tests for the section clock.
//
// Every scenario here is taken from the incident that motivated the model:
// a student whose Language section scored 0 with 30 unanswered questions
// after being disconnected, and a student whose Math timer fell from 36
// minutes to 2 minutes across a logout/login.
//
// Run: deno test supabase/functions/_shared/section-clock.test.ts
// ============================================================================

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  readClock,
  STALE_ACTIVITY_SECONDS,
  type SectionClockRow,
} from "./section-clock.ts";

const T0 = Date.parse("2026-07-28T15:00:00.000Z");
const seconds = (n: number) => n * 1000;
const minutes = (n: number) => n * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const MATH_BUDGET = 3000; // 50 minutes
const LANGUAGE_BUDGET = 1080; // 18 minutes

function section(overrides: Partial<SectionClockRow> = {}): SectionClockRow {
  return {
    status: "in_progress",
    started_at: iso(T0),
    time_limit_seconds: MATH_BUDGET,
    elapsed_seconds: 0,
    last_activity_at: iso(T0),
    ...overrides,
  };
}

Deno.test("student working normally is charged for the time they spend", () => {
  const clock = readClock(
    section({ last_activity_at: iso(T0 + minutes(10)) }),
    T0 + minutes(10)
  );

  assertEquals(clock.elapsedSeconds, 600);
  assertEquals(clock.remainingSeconds, 2400);
  assertEquals(clock.expired, false);
  assertEquals(clock.needsReanchor, false);
});

Deno.test("thinking hard on one question is not mistaken for being away", () => {
  const pause = STALE_ACTIVITY_SECONDS - 30;
  const clock = readClock(
    section({ last_activity_at: iso(T0 + minutes(5)) }),
    T0 + minutes(5) + seconds(pause)
  );

  assertEquals(clock.needsReanchor, false);
  assertEquals(clock.awaySeconds, 0);
  // Charged for the whole sitting, thinking time included.
  assertEquals(clock.elapsedSeconds, 300 + pause);
});

Deno.test("THE REPORTED BUG: timer must not drain while the student is disconnected", () => {
  // Math, 50 minutes. The student works 14 minutes — 36 left — then their
  // connection dies. They log out, log back in, and hit Continue 34 minutes
  // later. The old clock said 2 minutes remained.
  const workedFor = minutes(14);
  const goneFor = minutes(34);

  const clock = readClock(
    section({
      time_limit_seconds: MATH_BUDGET,
      started_at: iso(T0),
      last_activity_at: iso(T0 + workedFor),
    }),
    T0 + workedFor + goneFor
  );

  assertEquals(clock.needsReanchor, true);
  assertEquals(clock.elapsedSeconds, 840); // only the 14 minutes worked
  assertEquals(clock.remainingSeconds, 2160); // 36 minutes, not 2
  assertEquals(clock.expired, false);
  assertEquals(clock.awaySeconds, 2040);
});

Deno.test("THE REPORTED BUG: a section is not expired after a long disconnect", () => {
  // Language, 18 minutes. Student worked 3 minutes, was gone 23 hours, came
  // back. The old clock had expired 23 hours earlier, so submit-answer
  // refused all 30 answers and the section scored 0.
  const clock = readClock(
    section({
      time_limit_seconds: LANGUAGE_BUDGET,
      started_at: iso(T0),
      last_activity_at: iso(T0 + minutes(3)),
    }),
    T0 + minutes(3) + minutes(23 * 60)
  );

  assertEquals(clock.expired, false);
  assertEquals(clock.elapsedSeconds, 180);
  assertEquals(clock.remainingSeconds, 900); // 15 minutes still owed
  assertEquals(clock.needsReanchor, true);
});

Deno.test("time genuinely spent still expires the section", () => {
  // Present the whole time, interacting throughout, past the budget.
  const clock = readClock(
    section({
      time_limit_seconds: LANGUAGE_BUDGET,
      started_at: iso(T0),
      last_activity_at: iso(T0 + seconds(LANGUAGE_BUDGET + 10)),
    }),
    T0 + seconds(LANGUAGE_BUDGET + 30)
  );

  assertEquals(clock.expired, true);
  assertEquals(clock.remainingSeconds, 0);
  assertEquals(clock.needsReanchor, false);
});

Deno.test("time banked across sittings accumulates", () => {
  // 10 minutes banked from an earlier sitting, 5 more in this one.
  const clock = readClock(
    section({
      elapsed_seconds: 600,
      started_at: iso(T0),
      last_activity_at: iso(T0 + minutes(5)),
    }),
    T0 + minutes(5)
  );

  assertEquals(clock.elapsedSeconds, 900);
  assertEquals(clock.remainingSeconds, MATH_BUDGET - 900);
});

Deno.test("a paused section holds its remaining time still", () => {
  const paused = section({
    status: "not_started",
    started_at: null,
    elapsed_seconds: 1200,
    last_activity_at: iso(T0),
  });

  // Days later it must read exactly the same.
  assertEquals(readClock(paused, T0 + minutes(5)).remainingSeconds, 1800);
  assertEquals(readClock(paused, T0 + minutes(60 * 24 * 3)).remainingSeconds, 1800);
  assertEquals(readClock(paused, T0 + minutes(60 * 24 * 3)).needsReanchor, false);
});

Deno.test("a section that has not started yet has its full budget", () => {
  const clock = readClock(
    section({ status: "not_started", started_at: null, elapsed_seconds: 0, last_activity_at: null }),
    T0 + minutes(60)
  );

  assertEquals(clock.remainingSeconds, MATH_BUDGET);
  assertEquals(clock.expired, false);
});

Deno.test("a section running with no activity ever recorded falls back to started_at", () => {
  // Pre-migration rows can have a null last_activity_at. Opening the section
  // counts as the activity of record, so time is charged from started_at for
  // as long as the fallback is still fresh.
  const clock = readClock(
    section({ started_at: iso(T0), last_activity_at: null }),
    T0 + seconds(STALE_ACTIVITY_SECONDS - 30)
  );

  assertEquals(clock.elapsedSeconds, STALE_ACTIVITY_SECONDS - 30);
  assertEquals(clock.needsReanchor, false);
});

Deno.test("a stale pre-migration row is re-anchored rather than declared expired", () => {
  // One of the sessions stuck in production: in_progress, started days ago,
  // no activity column. It must recover, not stay unusable.
  const clock = readClock(
    section({ started_at: iso(T0), last_activity_at: null }),
    T0 + minutes(8974)
  );

  assertEquals(clock.needsReanchor, true);
  assertEquals(clock.elapsedSeconds, 0);
  assertEquals(clock.remainingSeconds, MATH_BUDGET);
  assertEquals(clock.expired, false);
});

Deno.test("clock never reports negative or over-budget time", () => {
  const clock = readClock(
    section({
      elapsed_seconds: 99999,
      started_at: iso(T0),
      last_activity_at: iso(T0 + minutes(1)),
    }),
    T0 + minutes(1)
  );

  assertEquals(clock.remainingSeconds, 0);
  assertEquals(clock.expired, true);
});

Deno.test("activity recorded before started_at cannot rewind the clock", () => {
  // A stale last_activity_at from a previous sitting must not make the
  // current sitting look like it began earlier than it did.
  const clock = readClock(
    section({
      started_at: iso(T0),
      last_activity_at: iso(T0 - minutes(30)),
    }),
    T0 + minutes(5)
  );

  assertEquals(clock.elapsedSeconds, 300);
  assertEquals(clock.needsReanchor, false);
});
