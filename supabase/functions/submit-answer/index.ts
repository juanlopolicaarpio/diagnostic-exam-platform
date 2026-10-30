// ============================================================================
// EDGE FUNCTION — submit-answer/index.ts
// ============================================================================
// POST /submit-answer
//
// Saves (or updates) a student's answer for a single question.
//
// THIS IS THE HOTTEST ENDPOINT IN THE SYSTEM.
// At 10K concurrent users × ~170 answers each = 1,700,000 calls
// over ~2.5 hours = ~190/sec sustained, spikes to ~500/sec.
//
// DESIGN FOR SPEED:
//   1. Minimal validation — just enough to prevent corruption
//   2. Single UPSERT — one database operation, not read-then-write
//   3. No scoring — we never compute scores during the exam
//   4. No correct/incorrect feedback — never reveal the answer
//
// HOW UPSERT WORKS:
//   The session_responses table has a UNIQUE constraint on
//   (session_id, session_question_id). When we insert:
//   - If no response exists → INSERT (first answer)
//   - If response exists → UPDATE (changed answer)
//   This is atomic — no race condition between two clicks.
//
// SECURITY:
//   - Validates session belongs to the user
//   - Validates the question belongs to an in_progress section
//   - Validates the question isn't locked
//   - Grades the answer (compares to correct_answer) using adminClient
//   - NEVER reveals whether the answer is correct
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClients,
  authenticateUser,
  ApiError,
  jsonResponse,
  withErrorHandling,
  requireUuid,
} from "../_shared/utils.ts";
import {
  readClock,
  reanchorSection,
  touchActivity,
  LATE_ANSWER_GRACE_SECONDS,
} from "../_shared/section-clock.ts";

// Define the expected request body shape
interface SubmitAnswerBody {
  session_id: string;
  session_question_id: string;
  // null / "" means the student DESELECTED their choice (cleared the answer).
  selected_answer: string | null;
  time_spent_seconds?: number;
}

serve(
  withErrorHandling(async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      throw new ApiError(405, "Method not allowed. Use POST.");
    }

    const { userClient, adminClient } = createClients(req);
    const user = await authenticateUser(userClient);

    // ── Parse and validate request body ──
    const body: SubmitAnswerBody = await req.json();

    if (!body.session_id) throw new ApiError(400, "Missing session_id.");
    if (!body.session_question_id) throw new ApiError(400, "Missing session_question_id.");
    requireUuid(body.session_id, "session_id");
    requireUuid(body.session_question_id, "session_question_id");

    // DESELECT SUPPORT:
    //   The key must always be present — a missing key is a client bug, and we
    //   don't want a malformed request to silently wipe a saved answer.
    //   Present-but-empty (null or "") is an explicit deselect.
    if (!("selected_answer" in body)) throw new ApiError(400, "Missing selected_answer.");

    const rawAnswer = body.selected_answer;
    const isDeselect =
      rawAnswer === null || (typeof rawAnswer === "string" && rawAnswer.trim() === "");

    let selectedAnswer: string | null = null;
    if (!isDeselect) {
      if (typeof rawAnswer !== "string") {
        throw new ApiError(400, "Invalid selected_answer. Must be a, b, c, d, e, or null.");
      }
      const validAnswers = ["a", "b", "c", "d", "e"];
      selectedAnswer = rawAnswer.trim().toLowerCase();
      if (!validAnswers.includes(selectedAnswer)) {
        throw new ApiError(400, `Invalid answer: "${rawAnswer}". Must be a, b, c, d, e, or null.`);
      }
    }

    // ── STEP 1: Verify session ownership and status ──
    // Single query: get session + check ownership in one call.
    const { data: session, error: sessionError } = await adminClient
      .from("diagnostic_sessions")
      .select("id, user_id, status")
      .eq("id", body.session_id)
      .single();

    if (sessionError || !session) {
      throw new ApiError(404, "Session not found.");
    }

    if (session.user_id !== user.id) {
      throw new ApiError(403, "This session does not belong to you.");
    }

    if (session.status !== "in_progress") {
      throw new ApiError(400, `Cannot submit answers. Session status: ${session.status}`);
    }

    // ── STEP 2: Verify the question belongs to this session and is unlocked ──
    // Also fetch the question's correct_answer for grading.
    const { data: sessionQuestion, error: sqError } = await adminClient
      .from("session_questions")
      .select(`
        id,
        session_id,
        section_name,
        locked,
        question_id,
        questions!inner (
          correct_answer
        )
      `)
      .eq("id", body.session_question_id)
      .eq("session_id", body.session_id)
      .single();

    if (sqError || !sessionQuestion) {
      throw new ApiError(404, "Question not found in this session.");
    }

    if (sessionQuestion.locked) {
      throw new ApiError(400, "This question is locked. The section has been submitted.");
    }

    // ── STEP 3: Verify the section is in_progress ──
    const { data: section } = await adminClient
      .from("session_sections")
      .select("id, status, started_at, time_limit_seconds, elapsed_seconds, last_activity_at")
      .eq("session_id", body.session_id)
      .eq("section_name", sessionQuestion.section_name)
      .single();

    if (!section || section.status !== "in_progress") {
      throw new ApiError(
        400,
        `Cannot submit. Section "${sessionQuestion.section_name}" is ${section?.status || "not found"}.`
      );
    }

    // Read the clock against time actually spent rather than wall-clock since
    // started_at. A student whose connection dropped used to come back to a
    // clock that had run down while they were gone; every answer after that
    // was refused here and silently lost, and the section scored 0.
    const nowIso = new Date().toISOString();
    const clock = readClock(section, Date.parse(nowIso));

    if (clock.needsReanchor) {
      // They were away and are back. Bank what they actually used and restart
      // the sitting, so this answer is judged against an honest clock.
      await reanchorSection(adminClient, section.id, clock, nowIso);
    }

    // Only a genuinely exhausted budget blocks the save, and even then a short
    // grace covers answers chosen before the buzzer that arrived just after it.
    const overdueSeconds = clock.elapsedSeconds - section.time_limit_seconds;
    if (overdueSeconds > LATE_ANSWER_GRACE_SECONDS) {
      throw new ApiError(400, "Section time has expired. Submit the section to continue.");
    }

    // ── STEP 4: Grade the answer ──
    // Compare selected_answer to the question's correct_answer.
    // This happens server-side — the student never controls is_correct.
    // A deselect (null) is never correct — it's stored exactly like the blank
    // rows submit-section writes for questions the student never touched.
    const correctAnswer = (sessionQuestion.questions as any).correct_answer;
    const isCorrect = selectedAnswer !== null && selectedAnswer === correctAnswer;

    // ── STEP 5: UPSERT the response ──
    // The UNIQUE constraint on (session_id, session_question_id) makes
    // this an atomic insert-or-update. No race conditions.
    //
    // WHY UPSERT, NOT INSERT:
    //   Students can change their answer before the section is locked.
    //   First answer = INSERT. Changed answer = UPDATE. Deselect = UPDATE to
    //   selected_answer = null (we keep the row rather than deleting it, so
    //   submit-section doesn't have to backfill it and the timing data survives).
    //   The unique constraint handles this automatically.
    const { error: upsertError } = await adminClient
      .from("session_responses")
      .upsert(
        {
          session_id: body.session_id,
          session_question_id: body.session_question_id,
          selected_answer: selectedAnswer,
          is_correct: isCorrect,
          submitted_at: new Date().toISOString(),
          time_spent_seconds:
            typeof body.time_spent_seconds === "number" &&
            Number.isFinite(body.time_spent_seconds) &&
            body.time_spent_seconds >= 0
              ? Math.floor(body.time_spent_seconds)
              : null,
        },
        {
          onConflict: "session_id,session_question_id",
        }
      );

    if (upsertError) {
      console.error("Response upsert failed:", upsertError);
      throw new ApiError(500, "Failed to save your answer. Please try again.");
    }

    // ── STEP 6: Record that the student is here ──
    // This is the signal the clock uses to tell working from disconnected.
    // Skipped right after a re-anchor, which already stamped it.
    if (!clock.needsReanchor) {
      await touchActivity(adminClient, section.id, nowIso);
    }

    // ── STEP 7: Return success ──
    // CRITICAL: We NEVER reveal whether the answer is correct.
    // time_remaining_seconds lets the client reconcile against the server's
    // clock instead of trusting its own, which is what let a drifted timer go
    // unnoticed until the answers were already gone.
    return jsonResponse({
      success: true,
      time_remaining_seconds: clock.remainingSeconds,
    });
  })
);
