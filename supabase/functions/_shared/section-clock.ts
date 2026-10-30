// ============================================================================
// EDGE FUNCTIONS — _shared/section-clock.ts
// ============================================================================
// One clock model, shared by every endpoint that reads or writes section time.
//
// THE BUG THIS REPLACES:
//   Remaining time used to be time_limit_seconds - (now - started_at).
//   started_at was set once and never moved while the section was
//   in_progress, so the countdown ran on wall-clock time whether or not the
//   student was actually there. A student who lost connection for half an
//   hour came back to a timer that had burned half an hour, and every answer
//   they saved after that point was rejected as expired — silently, because
//   the client never surfaced the 400. Sections were scored 0 with the
//   student certain they had answered.
//
//   pause-section was supposed to protect against this by banking the
//   remaining time on logout, but it only runs if the browser successfully
//   calls it. Crashes, killed tabs, and dead networks — exactly the cases
//   that need it — are the cases where it never fires.
//
// THE MODEL:
//   elapsed_seconds  is the time genuinely spent, banked across sittings.
//   started_at       marks the beginning of the CURRENT sitting (null when
//                    paused). It is re-anchored on every resume.
//   last_activity_at is the last time we saw the student.
//
//   remaining = time_limit_seconds - (elapsed_seconds + current sitting)
//
//   If the gap since last_activity_at exceeds STALE_ACTIVITY_SECONDS we treat
//   the student as having been away: only the time up to their last known
//   activity is charged, and the section is re-anchored to now. This makes
//   crash recovery behave the same as the explicit pause that pause-section
//   already performed on logout — the product always intended a closed tab to
//   stop the clock, it just could not do it reliably.
// ============================================================================

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// How long without any sign of the student before we conclude they were gone
// rather than thinking. The cost of guessing "away" too eagerly is a little
// free exam time; the cost of guessing it too late is charging a student for a
// disconnection and rejecting their answers. The second is far worse, so this
// errs long.
//
// 300s is sized for the weakest signal — a saved answer — because thinking and
// disconnection look the same through that lens, and a student can legitimately
// spend five minutes on one hard math problem.
//
// Once the frontend pings the heartbeat endpoint every ~30s, presence is
// explicit and this should drop to roughly 3 missed beats (~90s), which
// recovers a disconnected student far faster. Do not lower it before the
// client actually sends heartbeats: without them, a quiet stretch is
// indistinguishable from a student reading a long passage.
export const STALE_ACTIVITY_SECONDS = 300;

// An answer that arrives just past the deadline is almost always one the
// student selected before time ran out, delayed by a slow network or a client
// clock a few seconds ahead of ours. Losing it is far worse than accepting it.
export const LATE_ANSWER_GRACE_SECONDS = 120;

export interface SectionClockRow {
  status: string;
  started_at: string | null;
  time_limit_seconds: number;
  elapsed_seconds?: number | null;
  last_activity_at?: string | null;
}

export interface ClockState {
  /** Seconds genuinely spent in this section, including the current sitting. */
  elapsedSeconds: number;
  /** Seconds left on the budget. Never negative. */
  remainingSeconds: number;
  /** True once the budget is exhausted. */
  expired: boolean;
  /** Seconds the student appears to have been away and is not charged for. */
  awaySeconds: number;
  /**
   * True when the section is running but the student was absent, so
   * started_at must be moved to now and elapsed_seconds banked before any
   * further time is charged.
   */
  needsReanchor: boolean;
}

/**
 * Read the clock for a section. Pure — takes the row and the current time,
 * returns what the student's timer should say. No I/O, so it can be tested
 * exhaustively against the scenarios that produced the incident.
 */
export function readClock(
  section: SectionClockRow,
  nowMs: number = Date.now()
): ClockState {
  const banked = Math.max(0, section.elapsed_seconds ?? 0);
  const limit = section.time_limit_seconds;

  // Paused, not yet started, or finished: nothing is accruing right now.
  if (section.status !== "in_progress" || !section.started_at) {
    return {
      elapsedSeconds: banked,
      remainingSeconds: Math.max(0, limit - banked),
      expired: banked >= limit,
      awaySeconds: 0,
      needsReanchor: false,
    };
  }

  const startedMs = new Date(section.started_at).getTime();

  // A student who has done nothing since the section opened still has the
  // section-open itself as their last known activity.
  const lastActivityMs = section.last_activity_at
    ? Math.max(new Date(section.last_activity_at).getTime(), startedMs)
    : startedMs;

  const sinceActivitySeconds = Math.floor((nowMs - lastActivityMs) / 1000);

  if (sinceActivitySeconds > STALE_ACTIVITY_SECONDS) {
    // They were away. Charge only up to the last time we actually saw them.
    const sittingSeconds = Math.max(0, Math.floor((lastActivityMs - startedMs) / 1000));
    const elapsed = banked + sittingSeconds;
    return {
      elapsedSeconds: elapsed,
      remainingSeconds: Math.max(0, limit - elapsed),
      expired: elapsed >= limit,
      awaySeconds: sinceActivitySeconds,
      needsReanchor: true,
    };
  }

  // Present and working: charge the full current sitting.
  const sittingSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const elapsed = banked + sittingSeconds;
  return {
    elapsedSeconds: elapsed,
    remainingSeconds: Math.max(0, limit - elapsed),
    expired: elapsed >= limit,
    awaySeconds: 0,
    needsReanchor: false,
  };
}

/**
 * Bank the time spent so far and restart the current sitting from now.
 * Called when a student returns to a section that kept running while they
 * were gone, so the gap is not charged against their budget.
 */
export async function reanchorSection(
  adminClient: SupabaseClient,
  sectionId: string,
  clock: ClockState,
  nowIso: string = new Date().toISOString()
): Promise<void> {
  const { error } = await adminClient
    .from("session_sections")
    .update({
      elapsed_seconds: clock.elapsedSeconds,
      started_at: nowIso,
      last_activity_at: nowIso,
    })
    .eq("id", sectionId);

  if (error) {
    console.error("Failed to re-anchor section clock:", error);
  }
}

/**
 * Record that we just saw the student. Best-effort: a failed touch must never
 * cost the student their answer, so this never throws — the worst case is
 * that the next read treats them as idle slightly sooner than it should.
 */
export async function touchActivity(
  adminClient: SupabaseClient,
  sectionId: string,
  nowIso: string = new Date().toISOString()
): Promise<void> {
  const { error } = await adminClient
    .from("session_sections")
    .update({ last_activity_at: nowIso })
    .eq("id", sectionId);

  if (error) {
    console.error("Failed to update section activity:", error);
  }
}
