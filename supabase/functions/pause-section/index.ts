// ============================================================================
// EDGE FUNCTION - pause-section/index.ts
// ============================================================================
// POST /pause-section
//
// Pauses the timer for the authenticated user's current in-progress section.
// Called by the frontend on logout, page unload (beforeunload), or crash
// recovery so elapsed time is saved and the remaining time is preserved for
// when the user returns.
//
// How the pause/resume cycle works:
//   PAUSE  — banks the time spent into elapsed_seconds, then sets
//             status="not_started" and started_at=null. time_limit_seconds
//             is the immutable budget and is never rewritten.
//   RESUME — get-question-bundle sees status="not_started", sets
//             started_at=NOW() and status="in_progress". The countdown is
//             time_limit_seconds - elapsed_seconds.
//
// This endpoint is only a best-effort courtesy: a crashed tab or a dead
// network never reaches it. The clock does not depend on it — see
// _shared/section-clock.ts, which recovers the same time on resume by
// noticing the student stopped interacting.
//
// Body (optional JSON): { session_id?: string }
//   If session_id is omitted the user's most-recent in_progress session is used.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClients,
  authenticateUser,
  ApiError,
  jsonResponse,
  requireSectionName,
  withErrorHandling,
} from "../_shared/utils.ts";
import { readClock } from "../_shared/section-clock.ts";

serve(
  withErrorHandling(async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      throw new ApiError(405, "Method not allowed. Use POST.");
    }

    const { userClient, adminClient } = createClients(req);
    const user = await authenticateUser(userClient);

    // ── Parse optional body ──
    let sessionId: string | null = null;
    try {
      const text = await req.text();
      if (text) {
        const body = JSON.parse(text);
        sessionId = body?.session_id ?? null;
      }
    } catch {
      // Body is optional — ignore parse failures
    }

    // ── Find the active session ──
    let sessionQuery = adminClient
      .from("diagnostic_sessions")
      .select("id, user_id, status, current_section")
      .eq("user_id", user.id)
      .eq("status", "in_progress")
      .order("started_at", { ascending: false })
      .limit(1);

    if (sessionId) {
      sessionQuery = sessionQuery.eq("id", sessionId);
    }

    const { data: session, error: sessionError } = await sessionQuery.maybeSingle();

    if (sessionError || !session) {
      // Nothing active to pause — treat as success so the frontend doesn't error
      return jsonResponse({
        success: true,
        paused: false,
        message: "No active exam session found.",
      });
    }

    if (!session.current_section) {
      return jsonResponse({
        success: true,
        paused: false,
        message: "No active section to pause.",
      });
    }

    const currentSection = requireSectionName(session.current_section, "current_section");

    // ── Fetch the current section ──
    const { data: section, error: sectionError } = await adminClient
      .from("session_sections")
      .select("id, status, started_at, time_limit_seconds, elapsed_seconds, last_activity_at")
      .eq("session_id", session.id)
      .eq("section_name", currentSection)
      .single();

    if (sectionError || !section) {
      return jsonResponse({
        success: true,
        paused: false,
        message: "Current section not found.",
      });
    }

    // Already paused — nothing to do
    if (section.status === "not_started") {
      return jsonResponse({
        success: true,
        paused: true,
        session_id: session.id,
        current_section: currentSection,
        time_remaining_seconds: readClock(section).remainingSeconds,
        message: "Section is already paused.",
      });
    }

    if (section.status !== "in_progress") {
      return jsonResponse({
        success: true,
        paused: false,
        message: `Section cannot be paused while it is ${section.status}.`,
      });
    }

    if (!section.started_at) {
      return jsonResponse({
        success: true,
        paused: false,
        message: "Section has no start time recorded.",
      });
    }

    // ── Calculate remaining time ──
    // readClock also absorbs the case where the student vanished some time
    // before the pause reached us — that gap is not charged to them.
    const clock = readClock(section);

    if (clock.remainingSeconds <= 0) {
      // Time already expired — do not pause, let the frontend submit the section
      return jsonResponse({
        success: true,
        paused: false,
        time_remaining_seconds: 0,
        message: "Section time has already expired. Submit the section to continue.",
      });
    }

    // ── Persist the pause ──
    // Bank the time spent into elapsed_seconds and release started_at.
    //
    // This used to overwrite time_limit_seconds with the remaining time. That
    // destroyed the only record of the real budget, so a section that had been
    // paused could never be audited or repaired afterwards — and any clock
    // drift got baked permanently into the student's remaining time. One
    // session came out of it with 490 seconds of a 1080-second budget left
    // with no way to tell how much was genuine.
    const { error: updateError } = await adminClient
      .from("session_sections")
      .update({
        status: "not_started",
        started_at: null,
        elapsed_seconds: clock.elapsedSeconds,
        last_activity_at: new Date().toISOString(),
      })
      .eq("id", section.id);

    if (updateError) {
      console.error("Failed to pause section:", updateError);
      throw new ApiError(500, "Failed to pause section.");
    }

    return jsonResponse({
      success: true,
      paused: true,
      session_id: session.id,
      current_section: currentSection,
      time_remaining_seconds: clock.remainingSeconds,
      message: "Section paused.",
    });
  })
);
