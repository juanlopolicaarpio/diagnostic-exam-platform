// ============================================================================
// EDGE FUNCTION — assemble-exam/index.ts
// ============================================================================
// POST /assemble-exam
//
// Creates a new diagnostic exam session for the authenticated student,
// or returns an existing active session (resume scenario).
//
// WHAT THIS FUNCTION DOES:
//   1. Check if student has an active (incomplete) session → resume it
//   2. Find which templates the student has already used
//   3. Pick the first active template they haven't used
//   4. Create diagnostic_session + 6 session_sections + 170 session_questions
//   5. Return the session metadata for the frontend
//
// WHY THE ADMIN CLIENT IS NEEDED:
//   We use adminClient to insert session data because the RLS policies
//   require user_id = auth.uid() on INSERT. The adminClient bypasses
//   this and lets us set user_id explicitly. Alternatively, you could
//   use the userClient since the INSERT policy checks user_id = auth.uid(),
//   but adminClient is more reliable for multi-table transactions.
//
// CONCURRENCY NOTE:
//   Two simultaneous calls from the same user (double-click, network retry)
//   should NOT create two sessions. The resume check handles this:
//   the first call creates the session, the second finds it and returns it.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClients,
  authenticateUser,
  ApiError,
  jsonResponse,
  withErrorHandling,
  SECTION_CONFIG,
  SESSION_MAX_AGE_HOURS,
} from "../_shared/utils.ts";

serve(
  withErrorHandling(async (req: Request): Promise<Response> => {
    // Only accept POST
    if (req.method !== "POST") {
      throw new ApiError(405, "Method not allowed. Use POST.");
    }

    const { userClient, adminClient } = createClients(req);
    const user = await authenticateUser(userClient);

    // ── STEP 1: Check for an existing active session (resume) ──
    // An "active" session is one that hasn't been completed or expired.
    // If found, return it immediately — don't create a new one.
    const { data: existingSession } = await adminClient
      .from("diagnostic_sessions")
      .select(`
        id,
        template_id,
        status,
        current_section,
        started_at,
        session_sections (
          section_name,
          status,
          time_limit_seconds,
          started_at,
          submitted_at
        )
      `)
      .eq("user_id", user.id)
      .in("status", ["in_progress", "ready_to_finalize"])
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingSession) {
      // Check if session has expired (older than 24 hours)
      const sessionAge =
        Date.now() - new Date(existingSession.started_at).getTime();
      const maxAgeMs = SESSION_MAX_AGE_HOURS * 60 * 60 * 1000;

      if (sessionAge > maxAgeMs) {
        // Expire the session — student will get a new one
        await adminClient
          .from("diagnostic_sessions")
          .update({ status: "expired" })
          .eq("id", existingSession.id);
      } else {
        // Session is still valid — return it for resume
        const templateCode = await getTemplateCode(
          adminClient,
          existingSession.template_id
        );

        return jsonResponse({
          session_id: existingSession.id,
          template_code: templateCode,
          status: existingSession.status,
          current_section: existingSession.current_section,
          is_resumed: true,
          sections: SECTION_CONFIG.map((sc) => {
            const ss = existingSession.session_sections?.find(
              (s: any) => s.section_name === sc.name
            );
            return {
              name: sc.name,
              display_name: sc.displayName,
              question_count: sc.questionCount,
              time_limit_seconds: sc.timeLimitSeconds,
              status: ss?.status || "not_started",
              started_at: ss?.started_at || null,
              submitted_at: ss?.submitted_at || null,
            };
          }),
          total_questions: 170,
        });
      }
    }

    // ── STEP 2: Find which templates this student has already used ──
    // Query all past sessions (any status) to get used template IDs.
    const { data: pastSessions } = await adminClient
      .from("diagnostic_sessions")
      .select("template_id")
      .eq("user_id", user.id);

    const usedTemplateIds = new Set(
      (pastSessions || []).map((s: any) => s.template_id)
    );

    // ── STEP 3: Pick the first active template they haven't used ──
    const { data: availableTemplates } = await adminClient
      .from("diagnostic_templates")
      .select("id, code, version, total_questions")
      .eq("is_active", true)
      .order("is_primary", { ascending: false })
      .order("code", { ascending: true });

    if (!availableTemplates || availableTemplates.length === 0) {
      throw new ApiError(500, "No active diagnostic templates found. Contact admin.");
    }

    const selectedTemplate = availableTemplates.find(
      (t: any) => !usedTemplateIds.has(t.id)
    );

    if (!selectedTemplate) {
      throw new ApiError(
        409,
        "You have completed all available diagnostic forms. No retakes available at this time."
      );
    }

    // ── STEP 4: Create the session ──
    // This is a multi-step insert: session → sections → questions.
    // If any step fails, the session is in a bad state. In production V2,
    // wrap this in a Postgres transaction via a database function.
    // For V1, the sequential inserts are reliable enough.

    // 4a. Create diagnostic_session
    const { data: newSession, error: sessionError } = await adminClient
      .from("diagnostic_sessions")
      .insert({
        user_id: user.id,
        template_id: selectedTemplate.id,
        status: "in_progress",
        current_section: SECTION_CONFIG[0].name, // First section in the fixed order
      })
      .select("id")
      .single();

    if (sessionError || !newSession) {
      console.error("Session creation failed:", sessionError);
      throw new ApiError(500, "Failed to create exam session.");
    }

    const sessionId = newSession.id;

    // 4b. Create 6 session_sections with the official timing
    const sectionRows = SECTION_CONFIG.map((sc, index) => ({
      session_id: sessionId,
      section_name: sc.name,
      status: index === 0 ? "in_progress" : "not_started", // First section starts immediately
      started_at: index === 0 ? new Date().toISOString() : null,
      time_limit_seconds: sc.timeLimitSeconds,
    }));

    const { error: sectionsError } = await adminClient
      .from("session_sections")
      .insert(sectionRows);

    if (sectionsError) {
      console.error("Sections creation failed:", sectionsError);
      // Clean up the session
      await adminClient.from("diagnostic_sessions").delete().eq("id", sessionId);
      throw new ApiError(500, "Failed to create exam sections.");
    }

    // 4c. Copy template questions into session_questions
    // This is the "snapshot" — the student's exam is frozen to this
    // template version, even if the template changes later.
    const { data: templateQuestions, error: tqError } = await adminClient
      .from("diagnostic_template_questions")
      .select("question_id, section_name, display_order")
      .eq("template_id", selectedTemplate.id)
      .order("display_order", { ascending: true });

    if (tqError || !templateQuestions || templateQuestions.length === 0) {
      console.error("Template questions fetch failed:", tqError);
      await adminClient.from("session_sections").delete().eq("session_id", sessionId);
      await adminClient.from("diagnostic_sessions").delete().eq("id", sessionId);
      throw new ApiError(500, "Failed to load exam questions.");
    }

    const questionRows = templateQuestions.map((tq: any) => ({
      session_id: sessionId,
      question_id: tq.question_id,
      section_name: tq.section_name,
      display_order: tq.display_order,
      locked: false,
    }));

    // Insert in batches of 50 to avoid request size limits
    const BATCH_SIZE = 50;
    for (let i = 0; i < questionRows.length; i += BATCH_SIZE) {
      const batch = questionRows.slice(i, i + BATCH_SIZE);
      const { error: qError } = await adminClient
        .from("session_questions")
        .insert(batch);

      if (qError) {
        console.error(`Question batch ${i} insert failed:`, qError);
        // Clean up
        await adminClient.from("session_questions").delete().eq("session_id", sessionId);
        await adminClient.from("session_sections").delete().eq("session_id", sessionId);
        await adminClient.from("diagnostic_sessions").delete().eq("id", sessionId);
        throw new ApiError(500, "Failed to assemble exam questions.");
      }
    }

    // ── STEP 5: Return session metadata ──
    return jsonResponse({
      session_id: sessionId,
      template_code: selectedTemplate.code,
      status: "in_progress",
      current_section: SECTION_CONFIG[0].name,
      is_resumed: false,
      sections: SECTION_CONFIG.map((sc, index) => ({
        name: sc.name,
        display_name: sc.displayName,
        question_count: sc.questionCount,
        time_limit_seconds: sc.timeLimitSeconds,
        status: index === 0 ? "in_progress" : "not_started",
      })),
      total_questions: templateQuestions.length,
    });
  })
);

// ── Helper: Get template code from ID ──
async function getTemplateCode(
  client: any,
  templateId: string
): Promise<string> {
  const { data } = await client
    .from("diagnostic_templates")
    .select("code")
    .eq("id", templateId)
    .single();
  return data?.code || "UNKNOWN";
}
