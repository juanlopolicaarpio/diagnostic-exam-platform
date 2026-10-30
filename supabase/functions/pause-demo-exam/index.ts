// ============================================================================
// EDGE FUNCTION - pause-demo-exam/index.ts
// ============================================================================
// POST /pause-demo-exam
//
// Demo-only endpoint that pauses the authenticated user's current section.
// It is intentionally limited to the configured demo email and only edits the
// caller's active session.
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

serve(
  withErrorHandling(async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      throw new ApiError(405, "Method not allowed. Use POST.");
    }

    const { userClient, adminClient } = createClients(req);
    const user = await authenticateUser(userClient);
    const allowedEmail = (Deno.env.get("DEMO_RESET_EMAIL") || Deno.env.get("TEST_USER_EMAIL") || "").toLowerCase();

    if (!allowedEmail) {
      throw new ApiError(500, "Demo pause is not configured.");
    }

    if ((user.email || "").toLowerCase() !== allowedEmail) {
      throw new ApiError(403, "You are not allowed to pause this exam.");
    }

    const { data: session, error: sessionError } = await adminClient
      .from("diagnostic_sessions")
      .select("id, user_id, status, current_section")
      .eq("user_id", user.id)
      .eq("status", "in_progress")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sessionError || !session) {
      throw new ApiError(404, "No active exam session was found.");
    }

    if (!session.current_section) {
      throw new ApiError(400, "No active section is available to pause.");
    }

    const currentSection = requireSectionName(session.current_section, "current_section");

    const { data: section, error: sectionError } = await adminClient
      .from("session_sections")
      .select("id, status, started_at, time_limit_seconds")
      .eq("session_id", session.id)
      .eq("section_name", currentSection)
      .single();

    if (sectionError || !section) {
      throw new ApiError(404, "Current section was not found.");
    }

    if (section.status === "not_started") {
      return jsonResponse({
        success: true,
        session_id: session.id,
        current_section: currentSection,
        time_remaining_seconds: section.time_limit_seconds,
        message: "Exam is already paused.",
      });
    }

    if (section.status !== "in_progress") {
      throw new ApiError(400, `Cannot pause section while it is ${section.status}.`);
    }

    if (!section.started_at) {
      throw new ApiError(400, "Cannot pause a section that has not started.");
    }

    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.now() - new Date(section.started_at).getTime()) / 1000)
    );
    const remainingSeconds = Math.max(0, section.time_limit_seconds - elapsedSeconds);

    if (remainingSeconds <= 0) {
      throw new ApiError(400, "Section time has already expired. Submit the section to continue.");
    }

    const { error: updateError } = await adminClient
      .from("session_sections")
      .update({
        status: "not_started",
        started_at: null,
        time_limit_seconds: remainingSeconds,
      })
      .eq("id", section.id);

    if (updateError) {
      console.error("Failed to pause demo exam:", updateError);
      throw new ApiError(500, "Failed to pause exam.");
    }

    return jsonResponse({
      success: true,
      session_id: session.id,
      current_section: currentSection,
      time_remaining_seconds: remainingSeconds,
      message: "Exam paused.",
    });
  })
);
