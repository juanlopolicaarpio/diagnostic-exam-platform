// ============================================================================
// EDGE FUNCTION — heartbeat/index.ts
// ============================================================================
// POST /heartbeat  { session_id?: string }
//
// The client pings this every ~30 seconds while the exam tab is visible.
//
// WHY THIS EXISTS:
//   The section clock has to tell two situations apart: a student sitting on
//   a hard question for six minutes, and a student whose connection died six
//   minutes ago. Charge the second one and they come back to a drained timer
//   and rejected answers — the failure that scored a student's Language
//   section 0 with all 30 questions marked unanswered.
//
//   Without a heartbeat the only evidence of life is a saved answer, which is
//   a poor proxy: thinking looks identical to being gone. This endpoint makes
//   presence explicit, so STALE_ACTIVITY_SECONDS can be tightened to just
//   above the ping interval instead of being padded out to cover slow readers.
//
// IT IS ALSO THE TIMER'S SOURCE OF TRUTH:
//   The response carries time_remaining_seconds. The client should reconcile
//   its countdown against this rather than trusting its own tick, which is
//   how a drifted timer went unnoticed until the answers were already lost.
//
// Deliberately cheap: one section read, one narrow write. It runs once per
// student per 30s, so at 10K concurrent that is ~330/sec.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClients,
  authenticateUser,
  ApiError,
  jsonResponse,
  withErrorHandling,
  requireSectionName,
} from "../_shared/utils.ts";
import {
  readClock,
  reanchorSection,
  touchActivity,
} from "../_shared/section-clock.ts";

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

    const { data: session } = await sessionQuery.maybeSingle();

    // Nothing running is not an error — the client pings on a timer and may
    // still be beating while the student sits on a between-sections screen.
    if (!session || !session.current_section) {
      return jsonResponse({ success: true, active: false });
    }

    const currentSection = requireSectionName(session.current_section, "current_section");

    const { data: section } = await adminClient
      .from("session_sections")
      .select("id, status, started_at, time_limit_seconds, elapsed_seconds, last_activity_at")
      .eq("session_id", session.id)
      .eq("section_name", currentSection)
      .single();

    if (!section || section.status !== "in_progress") {
      return jsonResponse({
        success: true,
        active: false,
        session_id: session.id,
        current_section: currentSection,
      });
    }

    const nowIso = new Date().toISOString();
    const clock = readClock(section, Date.parse(nowIso));

    if (clock.needsReanchor) {
      // First beat back after a silence. Bank only what they actually used.
      await reanchorSection(adminClient, section.id, clock, nowIso);
    } else {
      await touchActivity(adminClient, section.id, nowIso);
    }

    return jsonResponse({
      success: true,
      active: true,
      session_id: session.id,
      current_section: currentSection,
      time_remaining_seconds: clock.remainingSeconds,
      expired: clock.expired,
    });
  })
);
