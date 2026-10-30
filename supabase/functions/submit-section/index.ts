// ============================================================================
// EDGE FUNCTION — submit-section/index.ts
// ============================================================================
// POST /submit-section
//
// Locks a completed section and advances the student to the next one.
// This is called when:
//   1. The student clicks "Submit Section" manually
//   2. The frontend timer expires and auto-calls this endpoint
//
// WHAT THIS FUNCTION DOES:
//   1. Verify session ownership and section is in_progress
//   2. Fill in unanswered questions as incorrect (timer expiry scenario)
//   3. Lock all questions in this section (locked = true)
//   4. Mark section as completed
//   5. Start the next section (or mark session as ready_to_finalize)
//
// WHY WE FILL UNANSWERED QUESTIONS:
//   When a timer expires, the student may not have answered every question.
//   We insert responses with selected_answer = null, is_correct = false
//   for every unanswered question. This ensures:
//   - The scoring engine has a response for every question
//   - Unanswered = wrong (no partial credit, no ambiguity)
//   - perf(S) calculations are accurate (total always matches question count)
//
// CONCURRENCY SAFETY:
//   If a submit-answer call races with submit-section, the sequence is:
//   1. submit-answer UPSERTs the response (fast, ~10ms)
//   2. submit-section fills remaining blanks (only where no response exists)
//   The "fill blanks" step uses a NOT EXISTS check, so it won't overwrite
//   an answer that was submitted at the last moment.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClients,
  authenticateUser,
  ApiError,
  jsonResponse,
  withErrorHandling,
  SECTION_ORDER,
  SECTION_CONFIG,
  requireSectionName,
  requireUuid,
} from "../_shared/utils.ts";

interface SubmitSectionBody {
  session_id: string;
  section_name: string;
}

serve(
  withErrorHandling(async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      throw new ApiError(405, "Method not allowed. Use POST.");
    }

    const { userClient, adminClient } = createClients(req);
    const user = await authenticateUser(userClient);

    const body: SubmitSectionBody = await req.json();
    if (!body.session_id) throw new ApiError(400, "Missing session_id.");
    if (!body.section_name) throw new ApiError(400, "Missing section_name.");
    requireUuid(body.session_id, "session_id");
    const sectionName = requireSectionName(body.section_name, "section_name");

    // ── STEP 1: Verify session ownership and status ──
    const { data: session, error: sessionError } = await adminClient
      .from("diagnostic_sessions")
      .select("id, user_id, status, current_section")
      .eq("id", body.session_id)
      .single();

    if (sessionError || !session) {
      throw new ApiError(404, "Session not found.");
    }

    if (session.user_id !== user.id) {
      throw new ApiError(403, "This session does not belong to you.");
    }

    if (session.status !== "in_progress") {
      throw new ApiError(400, `Cannot submit section. Session status: ${session.status}`);
    }

    if (session.current_section !== sectionName) {
      throw new ApiError(
        400,
        `Cannot submit section "${sectionName}". Current section: ${session.current_section}.`
      );
    }

    // ── STEP 2: Verify section is in_progress ──
    const { data: sectionData, error: sectionError } = await adminClient
      .from("session_sections")
      .select("id, status, started_at, time_limit_seconds")
      .eq("session_id", body.session_id)
      .eq("section_name", sectionName)
      .single();

    if (sectionError || !sectionData) {
      throw new ApiError(404, `Section "${sectionName}" not found.`);
    }

    if (sectionData.status === "completed") {
      throw new ApiError(400, `Section "${sectionName}" has already been submitted.`);
    }

    if (sectionData.status === "not_started") {
      throw new ApiError(400, `Section "${sectionName}" hasn't been started yet.`);
    }

    // ── STEP 3: Fill unanswered questions as incorrect ──
    // Find all session_questions in this section that DON'T have a response yet.
    // Insert a "blank" response for each: selected_answer = null, is_correct = false.
    //
    // WHY NOT JUST SKIP THEM:
    //   The scoring engine computes perf(S) = correct / total.
    //   If we skip unanswered questions, the "total" would be wrong.
    //   By recording them as incorrect, every question is accounted for.
    // Fetch all questions in section, fetch all responses, compute the difference
    const { data: allSectionQuestions } = await adminClient
      .from("session_questions")
      .select("id")
      .eq("session_id", body.session_id)
      .eq("section_name", sectionName);

    const { data: existingResponses } = await adminClient
      .from("session_responses")
      .select("session_question_id, selected_answer")
      .eq("session_id", body.session_id)
      .in(
        "session_question_id",
        (allSectionQuestions || []).map((q: any) => q.id)
      );

    // Any existing row counts as "has a response" for backfill purposes — a
    // deselect is a row with a null answer and must not be overwritten.
    const answeredIds = new Set(
      (existingResponses || []).map((r: any) => r.session_question_id)
    );

    // ...but only rows carrying a real choice count as an answer the student
    // actually gave. Deselects and previously backfilled blanks are not.
    const realAnswerCount = (existingResponses || []).filter(
      (r: any) => r.selected_answer !== null
    ).length;

    const blankResponses = (allSectionQuestions || [])
      .filter((q: any) => !answeredIds.has(q.id))
      .map((q: any) => ({
        session_id: body.session_id,
        session_question_id: q.id,
        selected_answer: null,
        is_correct: false,
        submitted_at: new Date().toISOString(),
        time_spent_seconds: null,
      }));

    if (blankResponses.length > 0) {
      const { error: blankError } = await adminClient
        .from("session_responses")
        .insert(blankResponses);

      if (blankError) {
        console.error("Failed to fill blank responses:", blankError);
        // Non-fatal: continue with section submission
        // The scoring engine will handle missing responses
      }
    }

    // ── STEP 3b: Flag a section that is being sealed with nothing in it ──
    // A student who answers normally and loses their answers to a failed save
    // looks identical, at this point, to a student who answered nothing: both
    // arrive here with every question blank. The difference only becomes
    // visible weeks later as a zero on a results page, which is how the
    // Language-scored-0 report reached us in the first place.
    //
    // We cannot refuse the submit — a student really may have skipped a
    // section, and blocking them would strand the exam. What we can do is
    // stop it being silent: emit a structured alert for the function logs and
    // tell the client, so it can warn the student before they move on rather
    // than sealing a zero without anyone noticing.
    const totalQuestions = (allSectionQuestions || []).length;
    const savedAnswerRatio = totalQuestions > 0 ? realAnswerCount / totalQuestions : 1;
    const suspiciouslyEmpty = totalQuestions > 0 && savedAnswerRatio < 0.25;

    if (suspiciouslyEmpty) {
      console.error(
        "ALERT alert.section_submitted_near_empty " +
          JSON.stringify({
            session_id: body.session_id,
            user_id: user.id,
            section: sectionName,
            answered: realAnswerCount,
            total: totalQuestions,
            blank_filled: blankResponses.length,
            section_started_at: sectionData.started_at,
            time_limit_seconds: sectionData.time_limit_seconds,
          })
      );
    }

    // ── STEP 4: Lock all questions in this section ──
    const { error: lockError } = await adminClient
      .from("session_questions")
      .update({ locked: true })
      .eq("session_id", body.session_id)
      .eq("section_name", sectionName);

    if (lockError) {
      console.error("Failed to lock questions:", lockError);
      throw new ApiError(500, "Failed to lock section.");
    }

    // ── STEP 5: Mark section as completed ──
    const { error: completeError } = await adminClient
      .from("session_sections")
      .update({
        status: "completed",
        submitted_at: new Date().toISOString(),
      })
      .eq("id", sectionData.id);

    if (completeError) {
      console.error("Failed to complete section:", completeError);
      throw new ApiError(500, "Failed to complete section.");
    }

    // ── STEP 6: Determine next section and advance ──
    const currentIndex = (SECTION_ORDER as readonly string[]).indexOf(sectionName);
    const nextSectionName =
      currentIndex < SECTION_ORDER.length - 1
        ? SECTION_ORDER[currentIndex + 1]
        : null;

    let examComplete = false;

    if (nextSectionName) {
      // Make the next section available but do NOT start its clock here.
      //
      // This used to set status="in_progress" and started_at=NOW, so the next
      // section began counting down the instant the previous one was
      // submitted — while the student was still on the transition screen, or
      // had stepped away, or had already lost connection. One student had
      // Social Studies opened and submitted 14 seconds apart with nothing
      // saved, because its 9-minute budget had been running unattended.
      //
      // get-question-bundle starts the clock when the student actually opens
      // the section, which is the only moment we know they are looking at it.
      await adminClient
        .from("session_sections")
        .update({
          status: "not_started",
          started_at: null,
        })
        .eq("session_id", body.session_id)
        .eq("section_name", nextSectionName);

      // Update session's current_section
      await adminClient
        .from("diagnostic_sessions")
        .update({ current_section: nextSectionName })
        .eq("id", body.session_id);
    } else {
      // All sections done — mark session as ready to finalize
      await adminClient
        .from("diagnostic_sessions")
        .update({
          current_section: null,
          status: "ready_to_finalize",
        })
        .eq("id", body.session_id);

      examComplete = true;
    }

    // ── STEP 7: Return result ──
    const nextConfig = nextSectionName
      ? SECTION_CONFIG.find((s) => s.name === nextSectionName)
      : null;

    return jsonResponse({
      success: true,
      section_completed: sectionName,
      // Counts what the student actually chose, so the client can compare it
      // against what it believes it sent and surface a mismatch instead of
      // letting lost answers pass as a legitimate zero.
      questions_answered: realAnswerCount,
      questions_blank: totalQuestions - realAnswerCount,
      near_empty: suspiciouslyEmpty,
      next_section: nextSectionName
        ? {
            name: nextSectionName,
            display_name: nextConfig!.displayName,
            question_count: nextConfig!.questionCount,
            time_limit_seconds: nextConfig!.timeLimitSeconds,
          }
        : null,
      exam_complete: examComplete,
    });
  })
);

// Helper function placeholder — not actually used since we use the set-based approach above
