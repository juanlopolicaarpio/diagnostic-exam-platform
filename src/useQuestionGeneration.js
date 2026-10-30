import { useCallback, useRef, useState } from "react";
import { validateMathItem } from "./mathValidation";
import { svgLooksSafe } from "./svgSafety";

// ═══════════════════════════════════════════════════════════════
// QUESTION GENERATION — state + workflow
// ═══════════════════════════════════════════════════════════════
//
// This hook deliberately lives in App, not in QuestionGenerator.
//
// The Generator is a *tab*: switching to the Question Bank unmounts it. When
// the generation state lived inside the component, that unmount threw away the
// in-flight request's results — the fetch kept running, resolved into a dead
// component, and the teacher came back to an empty panel. Hoisting the state to
// App means the work survives any in-app navigation.
//
// What this does NOT survive: closing or reloading the browser tab. The request
// is still a plain fetch from the page. Making it survive that needs a job row
// in Postgres that the function writes into and the UI polls — see
// docs/AI-ROADMAP.md. This hook is shaped so that change is a swap of
// `runWave`, not a rewrite.

// Items requested per edge-function call. The function enforces its own
// MAX_BATCH (15); staying under it keeps each invocation to ~2 Anthropic round
// trips, well inside the edge timeout. Large batches are many waves, not one
// big call — which also means questions stream into the UI as they land
// instead of appearing all at once at the end.
const WAVE_SIZE = 10;

// Total items one "Generate" press may ask for. Not a technical limit — a guard
// against a mistyped 500 costing real money. Raise freely.
export const MAX_TOTAL = 60;

// Re-exported so existing importers of this module keep working; the check
// itself lives in svgSafety.js so the CSV importer can share it.
export { svgLooksSafe };

export function editableQuestion(row) {
  return {
    question_text: row.question_text || "",
    choice_a: row.choice_a || "",
    choice_b: row.choice_b || "",
    choice_c: row.choice_c || "",
    choice_d: row.choice_d || "",
    correct_answer: String(row.correct_answer || "a").toLowerCase(),
    difficulty_level: String(row.difficulty_level || "medium").toLowerCase(),
    svg_content: row.svg_content || "",
    stimulus_id: row.stimulus_id || "",
    stimulus_title: row.stimulus_title || "",
    stimulus_type: row.stimulus_type || "",
    stimulus_text: row.stimulus_text || "",
  };
}

// Round-robins easy/medium/hard so every wave gets a representative mix rather
// than "wave 1 is all the easy ones". Returns one {easy,medium,hard} split per
// wave, each summing to at most WAVE_SIZE.
export function planWaves(split, waveSize = WAVE_SIZE) {
  const buckets = [
    Array(Math.max(0, Number(split.easy) || 0)).fill("easy"),
    Array(Math.max(0, Number(split.medium) || 0)).fill("medium"),
    Array(Math.max(0, Number(split.hard) || 0)).fill("hard"),
  ];

  const ordered = [];
  let addedSomething = true;
  while (addedSomething) {
    addedSomething = false;
    for (const bucket of buckets) {
      if (bucket.length) { ordered.push(bucket.shift()); addedSomething = true; }
    }
  }

  const waves = [];
  for (let i = 0; i < ordered.length; i += waveSize) {
    const slice = ordered.slice(i, i + waveSize);
    waves.push({
      easy: slice.filter(d => d === "easy").length,
      medium: slice.filter(d => d === "medium").length,
      hard: slice.filter(d => d === "hard").length,
    });
  }
  return waves;
}

async function parseResponse(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { error: text }; }
}

function fetchErrorMessage(error, functionsBase) {
  if (String(error?.message || "").includes("Failed to fetch")) {
    return `Could not reach the AI generation function. Check VITE_SUPABASE_URL, deploy generate-question-batch, and confirm Supabase function CORS/env secrets. Target: ${functionsBase || "missing VITE_SUPABASE_URL"}`;
  }
  return error?.message || "Request failed";
}

export function useQuestionGeneration({ session, rest, functionsBase, headers }) {
  const [questions, setQuestions] = useState([]);
  const [scope, setScope] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // {done, total, wave, waves}
  const [msg, setMsg] = useState("");
  const [improving, setImproving] = useState(null);
  const [uploading, setUploading] = useState(false);
  const abortRef = useRef(null);

  const updateQuestion = useCallback((index, key, value) => {
    setQuestions(prev => prev.map((q, i) => (i === index ? { ...q, [key]: value } : q)));
  }, []);

  const removeQuestion = useCallback((index) => {
    setQuestions(prev => prev.filter((_, i) => i !== index));
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setProgress(null);
    setMsg("Generation cancelled. Anything already generated is kept below.");
  }, []);

  const generate = useCallback(async ({ selected, split, standards }) => {
    if (!selected) { setMsg("Choose a topic or subtopic first."); return; }
    if (!functionsBase || functionsBase.includes("undefined")) {
      setMsg("Error: VITE_SUPABASE_URL is not configured, so the AI function URL cannot be built.");
      return;
    }

    const waves = planWaves(split);
    const total = waves.reduce((n, w) => n + w.easy + w.medium + w.hard, 0);
    if (!total) { setMsg("Ask for at least one question."); return; }
    if (total > MAX_TOTAL) { setMsg(`Ask for at most ${MAX_TOTAL} questions per run.`); return; }

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setMsg("");
    setQuestions([]);
    setScope(selected);
    setProgress({ done: 0, total, wave: 0, waves: waves.length });

    // Stems produced so far in THIS run. Sent with each wave so the function's
    // duplicate check spans the whole batch, not just one call.
    const priorTexts = [];
    let accepted = 0;
    let failedWaves = 0;

    try {
      for (let w = 0; w < waves.length; w += 1) {
        if (controller.signal.aborted) return;
        setProgress({ done: accepted, total, wave: w + 1, waves: waves.length });

        const res = await fetch(`${functionsBase}/generate-question-batch`, {
          method: "POST",
          headers: headers(session.access_token),
          signal: controller.signal,
          body: JSON.stringify({
            mode: "generate",
            ...selected,
            difficultySplit: waves[w],
            standards,
            priorTexts,
          }),
        });
        const data = await parseResponse(res);

        if (!res.ok) {
          // One bad wave shouldn't discard the waves that already succeeded.
          failedWaves += 1;
          setMsg(`Wave ${w + 1} failed: ${data?.error || res.status}. Continuing.`);
          continue;
        }

        const batch = (data.questions || []).map(q => ({
          ...editableQuestion(q),
          subject: selected.subject,
          topic: selected.topic,
          subtopic: selected.subtopic || null,
          source_school: "AI Generated",
          status: "draft",
        }));

        batch.forEach(q => priorTexts.push(q.question_text));
        accepted += batch.length;
        setQuestions(prev => [...prev, ...batch]);
        setProgress({ done: accepted, total, wave: w + 1, waves: waves.length });
      }

      if (!accepted) {
        setMsg("No generated items passed verification. Try an easier split, a subtopic with more examples, or narrower standards.");
      } else if (accepted < total) {
        setMsg(`Generated ${accepted} of ${total} verified drafts${failedWaves ? ` (${failedWaves} wave(s) errored)` : ""}. Items that failed the blind-solve check were dropped — run again to top up.`);
      } else {
        setMsg(`Generated ${accepted} verified drafts.`);
      }
    } catch (e) {
      if (e?.name === "AbortError") return;
      setMsg(`Error: ${fetchErrorMessage(e, functionsBase)}`);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
      setProgress(null);
    }
  }, [functionsBase, headers, session]);

  const improve = useCallback(async (index, teacherRequest) => {
    const request = (teacherRequest || "").trim();
    if (!request) { setMsg("Type what to improve first."); return false; }
    const q = questions[index];
    if (!q) return false;

    setImproving(index);
    setMsg("");
    try {
      const res = await fetch(`${functionsBase}/generate-question-batch`, {
        method: "POST",
        headers: headers(session.access_token),
        body: JSON.stringify({
          mode: "improve",
          subject: q.subject,
          topic: q.topic,
          subtopic: q.subtopic || "",
          question: editableQuestion(q),
          teacherRequest: request,
        }),
      });
      const data = await parseResponse(res);
      if (!res.ok) throw new Error(data?.error || `${res.status}`);
      setQuestions(prev => prev.map((item, i) => (i === index ? { ...item, ...editableQuestion(data.question) } : item)));
      setMsg("AI revision passed verification and replaced the draft.");
      return true;
    } catch (e) {
      setMsg(`Error: ${fetchErrorMessage(e, functionsBase)}`);
      return false;
    } finally {
      setImproving(null);
    }
  }, [questions, functionsBase, headers, session]);

  const upload = useCallback(async (onUploaded) => {
    if (!questions.length) return;
    setUploading(true);
    setMsg("");
    try {
      const rows = [];
      const stimulusCache = new Map();

      for (const q of questions) {
        let stimulus_id = q.stimulus_id || null;
        if (q.stimulus_text?.trim()) {
          const stimKey = `${q.stimulus_title || ""}|||${q.stimulus_type || "reading_passage"}|||${q.stimulus_text}`;
          if (stimulus_id) {
            stimulusCache.set(stimKey, stimulus_id);
          } else if (stimulusCache.has(stimKey)) {
            stimulus_id = stimulusCache.get(stimKey);
          } else {
            const stimRes = await fetch(`${rest}/stimuli`, {
              method: "POST",
              headers: { ...headers(session.access_token), Prefer: "return=representation" },
              body: JSON.stringify({
                stimulus_title: q.stimulus_title || null,
                stimulus_type: q.stimulus_type || "reading_passage",
                stimulus_text: q.stimulus_text,
              }),
            });
            const stimData = await parseResponse(stimRes);
            if (!stimRes.ok) throw new Error(stimData?.error || JSON.stringify(stimData));
            stimulus_id = Array.isArray(stimData) ? stimData[0]?.id : stimData?.id;
            if (!stimulus_id) throw new Error("Stimulus insert did not return an id.");
            stimulusCache.set(stimKey, stimulus_id);
          }
        }

        const body = {
          subject: q.subject,
          topic: q.topic,
          subtopic: q.subtopic || null,
          difficulty_level: q.difficulty_level,
          question_text: q.question_text,
          choice_a: q.choice_a,
          choice_b: q.choice_b,
          choice_c: q.choice_c,
          choice_d: q.choice_d,
          choice_e: null,
          correct_answer: q.correct_answer,
          source_school: "AI Generated",
          // Land as draft, never active. AI output gets a human pass in the
          // bank (filter Status = draft) before students can ever see it.
          status: "draft",
          svg_content: q.svg_content?.trim() || null,
          stimulus_id,
        };
        if (body.svg_content && !svgLooksSafe(body.svg_content)) {
          throw new Error("One generated SVG failed the local safety check. Remove or revise it before upload.");
        }
        const mathValidation = validateMathItem(body);
        if (mathValidation.checked && !mathValidation.valid) body.status = "needs_human_review";
        rows.push(body);
      }

      const res = await fetch(`${rest}/questions`, {
        method: "POST",
        headers: { ...headers(session.access_token), Prefer: "return=representation" },
        body: JSON.stringify(rows),
      });
      const data = await parseResponse(res);
      if (!res.ok) throw new Error(typeof data === "string" ? data : JSON.stringify(data));
      setMsg(`Uploaded ${data.length || rows.length} questions as drafts. Filter the bank by Status = draft to review and activate them.`);
      setQuestions([]);
      onUploaded?.();
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setUploading(false);
    }
  }, [questions, rest, headers, session]);

  return {
    questions, setQuestions, updateQuestion, removeQuestion,
    scope, busy, progress, msg, setMsg,
    improving, uploading,
    generate, cancel, improve, upload,
  };
}
