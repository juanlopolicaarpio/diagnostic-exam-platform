import { useCallback, useEffect, useMemo, useState } from "react";
import { ChoiceContent, MathContent } from "./mathContent";
import { validateMathItem } from "./mathValidation";
import { VisualAssetPreview, questionInlineVisualAssets } from "./visualContent";
import { QuestionWithUnderline } from "./questionText";
import StudentExamPreview from "./StudentExamPreview";
import { loadClassificationOptions } from "./classificationOptions";

const URL_BASE = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const REST = `${URL_BASE?.replace(/\/$/, "")}/rest/v1`;
const STORAGE = `${URL_BASE?.replace(/\/$/, "")}/storage/v1/object/public`;
const hdr = (t) => ({ apikey: KEY, Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
// Credentials for the throwaway student account used by "Preview Exam" and by
// the delete flow when it reparents that account's sessions. These were
// hardcoded; they now come from the environment so a working password is not
// committed to the repository.
//
// Note these are VITE_ variables, so they are still embedded in the browser
// bundle and readable by anyone who can load the admin app. That is acceptable
// for a disposable preview account and is not acceptable for anything else.
// Set both in .env (see .env.example). Preview is disabled if either is missing.
const PREVIEW_STUDENT_EMAIL = import.meta.env.VITE_PREVIEW_STUDENT_EMAIL || "";
const PREVIEW_STUDENT_PASSWORD = import.meta.env.VITE_PREVIEW_STUDENT_PASSWORD || "";
const PREVIEW_CREDENTIALS_SET = Boolean(PREVIEW_STUDENT_EMAIL && PREVIEW_STUDENT_PASSWORD);
const ARCHIVE_TEMPLATE_CODE = "__DELETED_EXAM_SESSIONS__";
const PS = 20;
const DRAFT_INDEX_KEY = "exam_builder_drafts";

const SUBJECTS = [
  { key: "math", subjects: ["Mathematics"], label: "Math", section_name: "math", total: 40, color: "#6366f1" },
  { key: "science", subjects: ["Science"], label: "Science", section_name: "science", total: 40, color: "#06b6d4" },
  { key: "language", subjects: ["English Language", "Filipino Language"], label: "Language", section_name: "language", total: 30, color: "#ec4899" },
  { key: "reading", subjects: ["Reading"], label: "Reading", section_name: "reading", total: 30, color: "#8b5cf6" },
  { key: "social_studies", subjects: ["Social Studies"], label: "Social Studies", section_name: "social_studies", total: 15, color: "#f97316" },
  { key: "logic", subjects: ["Logic/Abstract Reasoning"], label: "Logic & Abstract Reasoning", section_name: "logic", total: 15, color: "#14b8a6" },
];

const DIFFICULTY_TARGETS = {
  math: { easy: 12, medium: 20, hard: 8 },
  science: { easy: 12, medium: 20, hard: 8 },
  language: { easy: 9, medium: 15, hard: 6 },
  reading: { easy: 9, medium: 15, hard: 6 },
  social_studies: { easy: 4, medium: 8, hard: 3 },
  logic: { easy: 0, medium: 15, hard: 0 },
};

const DIFFICULTIES = ["easy", "medium", "hard"];
// Individual items the auto-picker must never select — an item found to be
// defective after it was already active, where retiring it outright would have
// removed it from exams in progress. Empty here; populated per environment.
const EXCLUDED_AUTO_PICK_QUESTION_IDS = new Set([]);

const RECOMMENDED_BLUEPRINT = {
  math: {
    topics: [
      {
        name: "Advanced Algebra / Pre-Calculus",
        count: 2,
        subtopics: [
          { name: "Exponential Functions", count: 2, difficulty: { easy: 1, medium: 1, hard: 0 } },
        ],
      },
      {
        name: "Algebra",
        count: 21,
        subtopics: [
          { name: "Algebraic Expressions", count: 2, difficulty: { easy: 0, medium: 1, hard: 1 } },
          { name: "Factoring", count: 2, difficulty: { easy: 0, medium: 1, hard: 1 } },
          { name: "Graphs of Linear Equations in Two Variables", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } },
          { name: "Linear Equations and Inequalities in One Var.", count: 5, difficulty: { easy: 1, medium: 3, hard: 1 } },
          { name: "Linear Functions and Inequalities", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } },
          { name: "Number Sequence and Pattern Finding", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
          { name: "Polynomial Functions", count: 2, difficulty: { easy: 1, medium: 1, hard: 0 } },
          { name: "Radicals", count: 3, difficulty: { easy: 1, medium: 1, hard: 1 } },
          { name: "Rational Expressions", count: 2, difficulty: { easy: 0, medium: 1, hard: 1 } },
          { name: "Rectangular Coordinate System", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } },
          { name: "Systems of Linear Inequalities", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } },
        ],
      },
      {
        name: "Calculus",
        count: 1,
        subtopics: [
          { name: "Introduction to Limits", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } },
        ],
      },
      {
        name: "Geometry",
        count: 10,
        subtopics: [
          { name: "Circles", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
          { name: "Coordinate Geometry", count: 2, difficulty: { easy: 1, medium: 0, hard: 1 } },
          { name: "Polygons", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
          { name: "Properties of Proportion", count: 2, difficulty: { easy: 1, medium: 1, hard: 0 } },
          { name: "Quadrilaterals", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
          { name: "Solid Geometry", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
          { name: "Triangles", count: 2, difficulty: { easy: 0, medium: 2, hard: 0 } },
        ],
      },
      {
        name: "Logic & Discrete Mathematics",
        count: 2,
        subtopics: [
          { name: "Logic", count: 2, difficulty: { easy: 0, medium: 1, hard: 1 } },
        ],
      },
      {
        name: "Statistics & Probability",
        count: 3,
        subtopics: [
          { name: "Introduction to Statistics", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } },
          { name: "Measures of Central Tendency", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
          { name: "Probability", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
        ],
      },
      {
        name: "Trigonometry Advanced",
        count: 1,
        subtopics: [{ name: "Trigonometric Identities", count: 1, difficulty: { easy: 0, medium: 0, hard: 1 } }],
      },
    ],
  },
  science: {
    topics: [
      { name: "Acids and Bases", count: 3, subtopics: [
        { name: "Concept of buffer", count: 1, difficulty: { easy: 0, medium: 0, hard: 1 } },
        { name: "Definitions: strong and weak acids and bases", count: 1, difficulty: { easy: 0, medium: 0, hard: 1 } },
        { name: "Properties of salts, acids and bases", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
      ]},
      { name: "Atomic Structure", count: 3, subtopics: [
        { name: "Atomic number, mass number, isotopes", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } },
        { name: "Electron configuration", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
        { name: "Electronic structure (shell model & orbitals)", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
      ]},
      { name: "Biochemistry", count: 1, subtopics: [{ name: "Structure and functions of enzymes", count: 1, difficulty: { easy: 0, medium: 0, hard: 1 } }] },
      { name: "Cell Biology", count: 2, subtopics: [
        { name: "Cell Cycle", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
        { name: "Transport Mechanisms", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } },
      ]},
      { name: "Chemical Bonding", count: 1, subtopics: [{ name: "Names & formulas for ionic and covalent compounds", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } }] },
      { name: "Current Electricity", count: 2, subtopics: [
        { name: "Current and potential difference in circuits", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
        { name: "Electric power and energy", count: 1, difficulty: { easy: 0, medium: 0, hard: 1 } },
      ]},
      { name: "Earth Systems", count: 5, subtopics: [
        { name: "Anthrosphere / Humanosphere", count: 2, difficulty: { easy: 0, medium: 1, hard: 1 } },
        { name: "Atmosphere", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
        { name: "Biosphere", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
        { name: "Geosphere", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
      ]},
      { name: "Electromagnetic Waves", count: 1, subtopics: [{ name: "Applications of electromagnetic waves", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } }] },
      { name: "Environmental Issues", count: 1, subtopics: [{ name: "Pollution (Land, Air, Water)", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } }] },
      { name: "Evolution", count: 2, subtopics: [{ name: "Relevance, mechanisms & evidence/bases of Evolution", count: 2, difficulty: { easy: 1, medium: 1, hard: 0 } }] },
      { name: "Genetics", count: 2, subtopics: [{ name: "Molecular basis of genetics", count: 2, difficulty: { easy: 1, medium: 1, hard: 0 } }] },
      { name: "Geology", count: 1, subtopics: [{ name: "History of the Earth", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } }] },
      { name: "Human Activity & Impact", count: 1, subtopics: [{ name: "Transportation", count: 1, difficulty: { easy: 0, medium: 0, hard: 1 } }] },
      { name: "Kinematics (1D)", count: 1, subtopics: [{ name: "Distance, displacement, speed, velocity", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } }] },
      { name: "Light", count: 1, subtopics: [{ name: "Refraction of light", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } }] },
      { name: "Magnetism", count: 1, subtopics: [{ name: "Laws of magnetism", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } }] },
      { name: "Measurement & Units", count: 1, subtopics: [{ name: "Standards, SI units, and prefixes", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } }] },
      { name: "Momentum & Collisions", count: 1, subtopics: [{ name: "Conservation of momentum", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } }] },
      { name: "Organic Chemistry & Biological Molecules", count: 1, subtopics: [{ name: "Biological molecules (Chem context)", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } }] },
      { name: "Periodic Table", count: 1, subtopics: [{ name: "Properties of elements vs. atomic structure", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } }] },
      { name: "Phases of Matter", count: 1, subtopics: [{ name: "Properties of gases", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } }] },
      { name: "Population & Biodiversity", count: 1, subtopics: [{ name: "Biodiversity", count: 1, difficulty: { easy: 0, medium: 0, hard: 1 } }] },
      { name: "Sound", count: 1, subtopics: [{ name: "Speed of sound", count: 1, difficulty: { easy: 0, medium: 0, hard: 1 } }] },
      { name: "Taxonomy", count: 1, subtopics: [{ name: "Basic taxonomic concepts, nomenclature & classification", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } }] },
      { name: "Thermodynamics (Physics)", count: 1, subtopics: [{ name: "Radiation", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } }] },
      { name: "Unifying Themes", count: 1, subtopics: [{ name: "Form and function", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } }] },
      { name: "Universe & Solar System", count: 2, subtopics: [{ name: "Universe and Solar System", count: 2, difficulty: { easy: 1, medium: 1, hard: 0 } }] },
    ],
  },
  language: {
    topics: [
      { name: "Advanced Grammar & Syntax", count: 8, subtopics: [
        { name: "Coordination and subordination", count: 4, difficulty: { easy: 1, medium: 3, hard: 0 } },
        { name: "Degree-comparatives and equatives", count: 2, difficulty: { easy: 1, medium: 1, hard: 0 } },
        { name: "Embedded sentence", count: 1, difficulty: { easy: 0, medium: 0, hard: 1 } },
        { name: "Relative clauses", count: 1, difficulty: { easy: 0, medium: 0, hard: 1 } },
      ]},
      { name: "Core Grammar", count: 5, subtopics: [
        { name: "Gerunds", count: 1, difficulty: { easy: 0, medium: 0, hard: 1 } },
        { name: "Prepositional phrases", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } },
        { name: "Reported speech", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
        { name: "Tense consistency", count: 2, difficulty: { easy: 2, medium: 0, hard: 0 } },
      ]},
      { name: "Discourse & Pragmatics", count: 1, subtopics: [{ name: "Sequence markers", count: 1, difficulty: { easy: 0, medium: 0, hard: 1 } }] },
      { name: "Study & Writing Skills", count: 2, subtopics: [{ name: "Note taking", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } }, { name: "Outlining", count: 1, difficulty: { easy: 0, medium: 0, hard: 1 } }] },
      { name: "Text Types & Communication", count: 1, subtopics: [{ name: "Main varieties of English (British, American, Philippine)", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } }] },
      { name: "Vocabulary & Word Study", count: 7, subtopics: [
        { name: "Context clues", count: 3, difficulty: { easy: 0, medium: 3, hard: 0 } },
        { name: "Semantic restrictions", count: 4, difficulty: { easy: 1, medium: 3, hard: 0 } },
      ]},
      { name: "Filipino Language in Culture & Society", count: 1, subtopics: [{ name: "The relationship of the Filipino language to Philippine culture and society", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } }] },
      { name: "Linguistics & Metalinguistics", count: 5, subtopics: [
        { name: "The different levels of discourse in Filipino", count: 3, difficulty: { easy: 1, medium: 1, hard: 1 } },
        { name: "The relationship of text and context in the use of Filipino", count: 2, difficulty: { easy: 2, medium: 0, hard: 0 } },
      ]},
    ],
  },
  reading: {
    topics: [
      { name: "Critical Reading", count: 4, subtopics: [
        { name: "Passage Analysis", count: 3, difficulty: { easy: 0, medium: 1, hard: 2 } },
        { name: "Tone and Purpose", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
      ]},
      { name: "Reading Comprehension", count: 26, subtopics: [
        { name: "Inference and Sequence", count: 2, difficulty: { easy: 0, medium: 1, hard: 1 } },
        { name: "Main Idea and Details", count: 20, difficulty: { easy: 8, medium: 11, hard: 1 } },
        { name: "Vocabulary and Reference", count: 4, difficulty: { easy: 1, medium: 1, hard: 2 } },
      ]},
    ],
  },
  social_studies: {
    topics: [
      { name: "Asian History", count: 6, subtopics: [
        { name: "Asia at present: Asian governments, cultures and societies Current issues: migration, border conflicts, human rights, socio-economic inequity, integration and competition", count: 3, difficulty: { easy: 1, medium: 1, hard: 1 } },
        { name: "Asia in the transitional and modern periods (16th-20th centuries): Asian contacts with the West, colonialism, Asian nationalism, struggle for independence across different regions of Asia amid the resilience of kingdoms in other parts, modernization", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
        { name: "East Asia: early history of Korea and Japan; imperial period â€” China to the Ming Dynasty; Nara and Heian periods; feudal Japan to the opening to the West", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
        { name: "South Asia to 1600s: Hindu heritage â€” Vedic and epic times; era of regional and sub-continental empires to Mughal Dynasty", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
      ]},
      { name: "Economics", count: 2, subtopics: [
        { name: "Market structures: pure competition, monopolistic competition, oligopoly and monopoly", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
        { name: "Mechanisms of allocation and economic systems", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
      ]},
      { name: "Philippine History", count: 3, subtopics: [
        { name: "Geography: land and people, geographical features and boundaries, cultural communities and diversity, peopling of the Philippines", count: 3, difficulty: { easy: 1, medium: 1, hard: 1 } },
      ]},
      { name: "World History", count: 4, subtopics: [
        { name: "Between two wars: World War I and new alliances, Russian Revolution, independence movements and decolonization, World War II, Cold War", count: 1, difficulty: { easy: 0, medium: 1, hard: 0 } },
        { name: "Contemporary concerns: new technologies, border and religious wars, globalization", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } },
        { name: "Geography and people: continents and climate, human evolution, cradles of civilization", count: 1, difficulty: { easy: 1, medium: 0, hard: 0 } },
        { name: "Reformation, Renaissance and age of exploration: Reformation and Counter (or Catholic) Reformation, explorations and the Columbian exchange, scientific Revolution", count: 1, difficulty: { easy: 0, medium: 0, hard: 1 } },
      ]},
    ],
  },
  logic: {
    topics: [
      { name: "Logic", count: 15, difficulty: { easy: 0, medium: 15, hard: 0 }, subtopics: [] },
    ],
  },
};

const DIFF_COLOR = { easy: "#22c55e", medium: "#f59e0b", hard: "#ef4444" };

function choiceLabel(l) {
  return l.toUpperCase();
}

function emptySelections() {
  return Object.fromEntries(SUBJECTS.map(s => [s.key, []]));
}

function createBlueprint() {
  return Object.fromEntries(SUBJECTS.map(s => [s.key, { topics: [] }]));
}

function getDraftKey(code) {
  return `exam_draft_${code}`;
}

function slugCode(name) {
  return name.trim().toUpperCase().replace(/\s+/g, "-").replace(/[^A-Z0-9-]/g, "");
}

function readJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeDraftIndex(drafts) {
  localStorage.setItem(DRAFT_INDEX_KEY, JSON.stringify(drafts));
}

function readDraftIndex() {
  return readJson(DRAFT_INDEX_KEY, []);
}

function upsertDraftMeta(meta) {
  const now = new Date().toISOString();
  const nextMeta = { ...meta, updatedAt: now };
  const others = readDraftIndex().filter(d => d.code !== meta.code);
  writeDraftIndex([nextMeta, ...others]);
  return nextMeta;
}

function removeDraft(code) {
  localStorage.removeItem(getDraftKey(code));
  writeDraftIndex(readDraftIndex().filter(d => d.code !== code));
}

function topicTotal(topic) {
  return topic.subtopics?.length
    ? topic.subtopics.reduce((sum, st) => sum + Number(st.count || 0), 0)
    : Number(topic.count || 0);
}

function subjectBlueprintTotal(subjectBlueprint) {
  return (subjectBlueprint?.topics || []).reduce((sum, topic) => sum + topicTotal(topic), 0);
}

function isBlueprintComplete(blueprint) {
  return SUBJECTS.every(s => subjectBlueprintTotal(blueprint[s.key]) === s.total);
}

function selectedTotal(selections) {
  return Object.values(selections).reduce((sum, list) => sum + list.length, 0);
}

function formatCount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? String(n) : "0";
}

function totalTarget() {
  return SUBJECTS.reduce((sum, s) => sum + s.total, 0);
}

function clampTopicCount(subjectKey, topicIndex, nextCount, topics) {
  const subject = SUBJECTS.find(s => s.key === subjectKey);
  const otherTopicsTotal = topics.reduce((sum, topic, idx) => {
    if (idx === topicIndex) return sum;
    return sum + topicTotal(topic);
  }, 0);
  const maxCount = subject ? Math.max(0, subject.total - otherTopicsTotal) : Number(nextCount || 0);
  return Math.max(0, Math.min(maxCount, Number(nextCount || 0)));
}

function fitSubtopicsToCount(subtopics, newCount) {
  const sum = subtopics.reduce((s, st) => s + Number(st.count || 0), 0);
  if (sum <= newCount) return subtopics;
  let excess = sum - newCount;
  const result = subtopics.map(st => ({ ...st, count: Number(st.count || 0) }));
  // Reduce largest subtopics first until excess is gone
  while (excess > 0) {
    const maxIdx = result.reduce((best, st, i) => st.count > result[best].count ? i : best, 0);
    if (result[maxIdx].count === 0) break;
    const cut = Math.min(result[maxIdx].count, excess);
    result[maxIdx].count -= cut;
    excess -= cut;
  }
  return result;
}

function clampSubtopicCount(topic, subtopicIndex, nextCount) {
  const otherSubtopicsTotal = (topic.subtopics || []).reduce((sum, st, idx) => {
    if (idx === subtopicIndex) return sum;
    return sum + Number(st.count || 0);
  }, 0);
  const maxCount = Math.max(0, Number(topic.count || 0) - otherSubtopicsTotal);
  return Math.max(0, Math.min(maxCount, Number(nextCount || 0)));
}

function questionFitsSlot(q, slot) {
  if (!q || !slot) return false;
  const subjectOk = (slot.subjects || []).includes(q.subject);
  if (!subjectOk) return false;
  if (slot.key === "logic") return true;
  if (slot.topic && q.topic !== slot.topic) return false;
  if (slot.subtopic && q.subtopic !== slot.subtopic) return false;
  return true;
}

function buildSlots(blueprint) {
  const slots = [];
  SUBJECTS.forEach(s => {
    (blueprint[s.key]?.topics || []).forEach(topic => {
      if (topic.subtopics?.length) {
        topic.subtopics.forEach(subtopic => {
          if (Number(subtopic.count || 0) > 0) {
            slots.push({ ...s, topic: topic.name, subtopic: subtopic.name, target: Number(subtopic.count), difficultyTargets: subtopic.difficulty || null, slot_id: `${s.key}|||${topic.name}|||${subtopic.name}` });
          }
        });
      } else if (Number(topic.count || 0) > 0) {
        slots.push({ ...s, topic: topic.name, subtopic: "", target: Number(topic.count), difficultyTargets: topic.difficulty || null, slot_id: `${s.key}|||${topic.name}|||` });
      }
    });
  });
  return slots;
}

function slotSelectedCount(selections, slot) {
  return (selections[slot.key] || []).filter(q => (q._slotId ? q._slotId === slot.slot_id : questionFitsSlot(q, slot))).length;
}

function getAllSelectedIds(selections) {
  return new Set(Object.values(selections).flat().map(q => q.id));
}

function groupingKeyForQuestion(q) {
  if ((String(q?.subject || "").toLowerCase().includes("logic") || q?.section_name === "logic") && !q.topic && !q.subtopic) {
    return "Logic|||";
  }
  return `${q.topic || "Unclassified"}|||${q.subtopic || ""}`;
}

function reconcileSelectionsWithBlueprint(selections, blueprint) {
  const next = Object.fromEntries(SUBJECTS.map(s => [s.key, []]));
  const slots = buildSlots(blueprint);
  const slotLookup = new Map(slots.map(slot => [slot.slot_id, slot]));
  let removed = 0;

  SUBJECTS.forEach(subject => {
    const usedBySlot = new Map();
    (selections[subject.key] || []).forEach(q => {
      let slot = q._slotId ? slotLookup.get(q._slotId) : null;
      if (!slot || !questionFitsSlot(q, slot)) {
        slot = slots.find(candidate => candidate.key === subject.key && questionFitsSlot(q, candidate)) || null;
      }
      if (!slot) {
        removed += 1;
        return;
      }
      const count = usedBySlot.get(slot.slot_id) || 0;
      if (count >= slot.target) {
        removed += 1;
        return;
      }
      usedBySlot.set(slot.slot_id, count + 1);
      next[subject.key].push({ ...q, _slotId: slot.slot_id });
    });
  });

  return { selections: next, removed };
}

function blueprintFromSelections(selections) {
  const blueprint = createBlueprint();
  SUBJECTS.forEach(s => {
    const grouped = {};
    (selections[s.key] || []).forEach(q => {
      const [topic, subtopic] = groupingKeyForQuestion(q).split("|||");
      if (!grouped[topic]) grouped[topic] = {};
      grouped[topic][subtopic] = (grouped[topic][subtopic] || 0) + 1;
    });
    blueprint[s.key].topics = Object.entries(grouped).map(([topic, subtopics]) => {
      const rows = Object.entries(subtopics).filter(([name]) => name);
      if (rows.length) {
        return { name: topic, count: rows.reduce((sum, [, count]) => sum + count, 0), subtopics: rows.map(([name, count]) => ({ name, count })) };
      }
      return { name: topic, count: subtopics[""] || 0, subtopics: [] };
    });
  });
  return blueprint;
}

function normalizeDraftPayload(payload, fallback) {
  const sourceSelections = { ...(payload?.selections || fallback?.selections || {}) };
  const sourceBlueprint = payload?.blueprint || createBlueprint();
  return {
    stage: payload?.stage || "welcome",
    activeSubject: payload?.activeSubject || SUBJECTS[0].key,
    activeSlotIndex: payload?.activeSlotIndex || 0,
    blueprint: Object.fromEntries(SUBJECTS.map(s => [s.key, sourceBlueprint[s.key] || { topics: [] }])),
    selections: Object.fromEntries(SUBJECTS.map(s => [s.key, sourceSelections[s.key] || []])),
  };
}

function optionsForSubject(classOpts, subject) {
  const subjects = Array.isArray(subject) ? subject : [subject];
  const topics = [...new Set(classOpts.topics
    .filter(t => subjects.some(subjectName => t.startsWith(subjectName + "|||")))
    .map(t => t.split("|||")[1])
    .filter(Boolean))].sort();
  const subtopicsByTopic = {};
  classOpts.subtopics.forEach(row => {
    const [sub, topic, subtopic] = row.split("|||");
    if (!subjects.includes(sub) || !topic || !subtopic) return;
    if (!subtopicsByTopic[topic]) subtopicsByTopic[topic] = [];
    subtopicsByTopic[topic].push(subtopic);
  });
  Object.keys(subtopicsByTopic).forEach(topic => {
    subtopicsByTopic[topic] = [...new Set(subtopicsByTopic[topic])].sort();
  });
  return { topics, subtopicsByTopic };
}

function cloneBlueprint(blueprint) {
  return JSON.parse(JSON.stringify(blueprint));
}

function normalizeDifficulty(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "difficult" ? "hard" : text;
}

function rowMatchesSlotTopic(row, slot) {
  return row?.subject && (slot.subjects || []).includes(row.subject) && row.topic === slot.topic;
}

function emptyDifficultyCounts() {
  return Object.fromEntries(DIFFICULTIES.map(difficulty => [difficulty, 0]));
}

function difficultyTotal(counts) {
  return DIFFICULTIES.reduce((sum, difficulty) => sum + Number(counts?.[difficulty] || 0), 0);
}

function distributeQuota(cells, quota) {
  const totalAvailable = cells.reduce((sum, cell) => sum + cell.available, 0);
  if (totalAvailable < quota) return null;
  const rows = cells.map(cell => {
    const raw = totalAvailable ? (cell.available / totalAvailable) * quota : 0;
    return {
      ...cell,
      take: Math.min(cell.capacity, cell.available, Math.floor(raw)),
      remainder: raw - Math.floor(raw),
    };
  });
  let assigned = rows.reduce((sum, cell) => sum + cell.take, 0);
  while (assigned < quota) {
    rows.sort((a, b) =>
      (b.remainder - a.remainder) ||
      ((Math.min(b.capacity, b.available) - b.take) - (Math.min(a.capacity, a.available) - a.take)) ||
      (a.index - b.index)
    );
    const next = rows.find(cell => cell.take < cell.capacity && cell.take < cell.available);
    if (!next) return null;
    next.take += 1;
    next.remainder = 0;
    assigned += 1;
  }
  return rows.filter(cell => cell.take > 0);
}

function trimReadingToTarget(questions, targetTotal, difficultyTargets) {
  if (questions.length <= targetTotal) return questions;
  const excess = questions.length - targetTotal;
  const counts = Object.fromEntries(DIFFICULTIES.map(d => [d, 0]));
  questions.forEach(q => {
    const d = normalizeDifficulty(q.difficulty_level);
    if (DIFFICULTIES.includes(d)) counts[d]++;
  });
  const toRemoveIds = new Set();
  const diffsByOverage = [...DIFFICULTIES].sort((a, b) =>
    (counts[b] - (difficultyTargets[b] || 0)) - (counts[a] - (difficultyTargets[a] || 0))
  );
  const reversed = [...questions].reverse();
  for (const diff of diffsByOverage) {
    if (toRemoveIds.size >= excess) break;
    const overage = Math.max(0, counts[diff] - (difficultyTargets[diff] || 0));
    let removed = 0;
    for (const q of reversed) {
      if (toRemoveIds.size >= excess || removed >= overage) break;
      if (!toRemoveIds.has(q.id) && normalizeDifficulty(q.difficulty_level) === diff) {
        toRemoveIds.add(q.id);
        removed++;
      }
    }
  }
  for (const q of reversed) {
    if (toRemoveIds.size >= excess) break;
    if (!toRemoveIds.has(q.id)) toRemoveIds.add(q.id);
  }
  return questions.filter(q => !toRemoveIds.has(q.id));
}

function SegMarkup({ markup }) {
  if (!markup) return null;
  const parts = [];
  const rx = /<seg\s+choice='([A-D])'>(.*?)<\/seg>/g;
  let match;
  let last = 0;
  while ((match = rx.exec(markup)) !== null) {
    if (match.index > last) parts.push({ type: "text", text: markup.slice(last, match.index) });
    parts.push({ type: "seg", choice: match[1], text: match[2] });
    last = rx.lastIndex;
  }
  if (last < markup.length) parts.push({ type: "text", text: markup.slice(last) });
  return (
    <div style={{ fontSize: 15, lineHeight: 2.3, color: "#cbd5e1" }}>
      {parts.map((part, index) => part.type === "text" ? (
        <span key={index}>{part.text}</span>
      ) : (
        <span key={index} style={{ borderBottom: "2px solid #f59e0b", padding: "0 3px", margin: "0 2px" }}>
          <span style={{ color: "#f59e0b", fontSize: 10, fontWeight: 800, marginRight: 3 }}>{part.choice}</span>
          {part.text}
        </span>
      ))}
    </div>
  );
}

function ExamBuilderEditor({ session, templateCode, templateLabel, templateId: propTemplateId, initialSelections, draftCode, onBack, onSaveComplete }) {
  const draftKey = getDraftKey(templateCode);
  const savedDraft = useMemo(() => readJson(draftKey, null), [draftKey]);
  const initialPayload = useMemo(() => {
    if (savedDraft) return normalizeDraftPayload(savedDraft, null);
    const selections = initialSelections || emptySelections();
    return normalizeDraftPayload({
      stage: propTemplateId ? "select" : "welcome",
      blueprint: propTemplateId ? blueprintFromSelections(selections) : createBlueprint(),
      selections,
    });
  }, [savedDraft, initialSelections, propTemplateId]);

  const dbPayload = useMemo(() => {
    const selections = initialSelections || emptySelections();
    return normalizeDraftPayload({
      stage: propTemplateId ? "select" : "welcome",
      blueprint: propTemplateId ? blueprintFromSelections(selections) : createBlueprint(),
      selections,
    });
  }, [initialSelections, propTemplateId]);

  const [stage, setStage] = useState(initialPayload.stage);
  const [activeSubject, setActiveSubject] = useState(initialPayload.activeSubject);
  const [activeSlotIndex, setActiveSlotIndex] = useState(initialPayload.activeSlotIndex);
  const [blueprint, setBlueprint] = useState(initialPayload.blueprint);
  const [selections, setSelections] = useState(initialPayload.selections);
  const [classOpts, setClassOpts] = useState({ subjects: [], topics: [], subtopics: [] });
  const [weightOpts, setWeightOpts] = useState({ subjects: [], topics: [], subtopics: [], source: "" });
  const [questions, setQuestions] = useState([]);
  const [stimulusMap, setStimulusMap] = useState({});
  const [visualMap, setVisualMap] = useState({});
  const [filters, setFilters] = useState({ difficulty_level: "all" });
  const [search, setSearch] = useState("");
  const [hideAdded, setHideAdded] = useState(false);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [quotaMove, setQuotaMove] = useState({ amount: 1, from: "", to: "" });
  const [quotaMsg, setQuotaMsg] = useState("");
  const [viewQ, setViewQ] = useState(null);
  const [editingQ, setEditingQ] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [editBusy, setEditBusy] = useState(false);
  const [editMsg, setEditMsg] = useState("");
  const [autoPickBusy, setAutoPickBusy] = useState(false);
  const [autoPickMsg, setAutoPickMsg] = useState("");
  const [viewLoading, setViewLoading] = useState(false);
  const [questionRefresh, setQuestionRefresh] = useState(0);
  const [exampleTemplateMsg, setExampleTemplateMsg] = useState("");
  const [planSyncMsg, setPlanSyncMsg] = useState("");
  const [activePassageId, setActivePassageId] = useState(null);

  const slots = useMemo(() => buildSlots(blueprint), [blueprint]);
  const activeSubjectSlots = useMemo(() => slots.filter(slot => slot.key === activeSubject), [slots, activeSubject]);
  const activeSlot = activeSubjectSlots[Math.min(activeSlotIndex, Math.max(activeSubjectSlots.length - 1, 0))];
  const activeSubjectInfo = SUBJECTS.find(s => s.key === activeSubject) || SUBJECTS[0];
  const activeSubjectIndex = Math.max(0, SUBJECTS.findIndex(s => s.key === activeSubjectInfo.key));
  const previousSubject = SUBJECTS[Math.max(0, activeSubjectIndex - 1)] || SUBJECTS[0];
  const nextSubject = SUBJECTS[Math.min(SUBJECTS.length - 1, activeSubjectIndex + 1)] || SUBJECTS[SUBJECTS.length - 1];
  const activeSubjectBlueprint = blueprint[activeSubjectInfo.key] || { topics: [] };
  const allSelectedIds = useMemo(() => getAllSelectedIds(selections), [selections]);
  const selectedCount = selectedTotal(selections);
  const targetCount = totalTarget();
  const blueprintComplete = isBlueprintComplete(blueprint);
  const isReadingSubject = activeSubject === "reading";
  const readingSubjectInfo = SUBJECTS.find(s => s.key === "reading");
  const readingTotal = readingSubjectInfo?.total || 30;
  const allSlotsComplete = blueprintComplete && slots.every(slot => slotSelectedCount(selections, slot) === slot.target);
  const pages = Math.ceil(total / PS);

  const loadClassOpts = useCallback(async () => {
    if (!session) return;
    setClassOpts(await fetchClassOpts(session.access_token));
  }, [session]);

  useEffect(() => {
    void Promise.resolve().then(loadClassOpts);
  }, [loadClassOpts]);

  useEffect(() => {
    if (!session) return;
    loadClassificationOptions(REST, hdr(session.access_token)).then(setWeightOpts).catch(() => {});
  }, [session]);

  useEffect(() => {
    const payload = { stage, activeSubject, activeSlotIndex, blueprint, selections, savedAt: new Date().toISOString() };
    localStorage.setItem(draftKey, JSON.stringify(payload));
    if (!propTemplateId) {
      const meta = upsertDraftMeta({
        code: templateCode,
        label: templateLabel,
        selected: selectedCount,
        total: targetCount,
        blueprintComplete,
      });
      localStorage.setItem(draftKey, JSON.stringify({ ...payload, updatedAt: meta.updatedAt }));
    }
  }, [stage, activeSubject, activeSlotIndex, blueprint, selections, draftKey, propTemplateId, templateCode, templateLabel, selectedCount, targetCount, blueprintComplete]);

  useEffect(() => { setActivePassageId(null); }, [activeSubject]);

  function discardChanges() {
    if (!window.confirm("Discard unsaved changes and reload from the database?")) return;
    localStorage.removeItem(draftKey);
    setStage(dbPayload.stage);
    setActiveSubject(dbPayload.activeSubject);
    setActiveSlotIndex(dbPayload.activeSlotIndex);
    setBlueprint(dbPayload.blueprint);
    setSelections(dbPayload.selections);
  }

  useEffect(() => {
    if (!session || stage !== "select") return;
    if (!isReadingSubject && !activeSlot) return;
    let cancelled = false;
    async function loadQuestions() {
      setBusy(true);
      const parts = [
        "select=*",
        "status=eq.active",
        `order=${isReadingSubject ? "stimulus_id.asc,topic.asc,subtopic.asc" : "topic.asc,subtopic.asc"}`,
        `limit=${PS}`,
        `offset=${page * PS}`,
      ];
      if (isReadingSubject) {
        parts.push("subject=eq.Reading");
        if (activePassageId) parts.push(`stimulus_id=eq.${encodeURIComponent(activePassageId)}`);
      } else {
        if ((activeSlot.subjects || []).length > 1) {
          parts.push(`subject=in.(${activeSlot.subjects.map(encodeURIComponent).join(",")})`);
        } else {
          parts.push(`subject=eq.${encodeURIComponent(activeSlot.subjects[0])}`);
        }
        if (activeSlot.topic) parts.push(`topic=eq.${encodeURIComponent(activeSlot.topic)}`);
        if (activeSlot.subtopic) parts.push(`subtopic=eq.${encodeURIComponent(activeSlot.subtopic)}`);
      }
      if (filters.difficulty_level !== "all") parts.push(`difficulty_level=eq.${filters.difficulty_level}`);
      if (search.trim()) parts.push(`question_text=ilike.*${encodeURIComponent(search.trim())}*`);

      const r = await fetch(`${REST}/questions?${parts.join("&")}`, {
        headers: { ...hdr(session.access_token), Prefer: "count=exact" },
      });
      const data = await r.json();
      if (cancelled) return;
      const rows = Array.isArray(data) ? data : [];
      setQuestions(rows);
      setTotal(Number(r.headers.get("content-range")?.split("/")[1] || rows.length));
      if (isReadingSubject) {
        const ids = [...new Set(rows.map(q => q.stimulus_id).filter(Boolean))];
        if (ids.length) {
          const sr = await fetch(`${REST}/stimuli?select=id,stimulus_title,stimulus_type,stimulus_text&id=in.(${ids.map(encodeURIComponent).join(",")})`, {
            headers: hdr(session.access_token),
          });
          const stims = sr.ok ? await sr.json() : [];
          if (!cancelled) setStimulusMap(prev => ({ ...prev, ...Object.fromEntries(stims.map(s => [s.id, s])) }));
        }
      } else {
        setStimulusMap({});
      }
      setBusy(false);
    }
    loadQuestions();
    return () => { cancelled = true; };
  }, [session, stage, activeSlot, isReadingSubject, activePassageId, filters, search, page, questionRefresh]);

  useEffect(() => {
    if (!session) return;
    const subjectKey = isReadingSubject ? "reading" : activeSlot?.key;
    if (!subjectKey) return;
    const selected = selections[subjectKey] || [];
    const candidates = [...questions, ...selected];
    const missing = [...new Set(candidates.map(q => q.id).filter(Boolean))].filter(id => !visualMap[id]);
    if (!missing.length) return;
    let cancelled = false;
    async function loadVisuals() {
      const r = await fetch(`${REST}/question_visual_assets?question_id=in.(${missing.map(encodeURIComponent).join(",")})&select=*,visual_assets(*)`, {
        headers: hdr(session.access_token),
      });
      if (!r.ok || cancelled) return;
      const rows = await r.json();
      const grouped = Object.fromEntries(missing.map(id => [id, []]));
      (Array.isArray(rows) ? rows : []).forEach(row => {
        if (!grouped[row.question_id]) grouped[row.question_id] = [];
        grouped[row.question_id].push(row);
      });
      setVisualMap(prev => ({ ...prev, ...grouped }));
    }
    loadVisuals();
    return () => { cancelled = true; };
  }, [session, questions, selections, activeSlot, isReadingSubject, visualMap]);

  function updateSubjectBlueprint(subjectKey, updater) {
    setBlueprint(prev => {
      const nextBlueprint = { ...prev, [subjectKey]: updater(prev[subjectKey] || { topics: [] }) };
      const reconciled = reconcileSelectionsWithBlueprint(selections, nextBlueprint);
      if (reconciled.removed > 0) {
        setSelections(reconciled.selections);
        setPlanSyncMsg(`The plan changed, so ${formatCount(reconciled.removed)} selected question${reconciled.removed === 1 ? "" : "s"} no longer fit and were removed.`);
      }
      return nextBlueprint;
    });
  }

  function addTopic(subjectKey) {
    updateSubjectBlueprint(subjectKey, bp => ({ ...bp, topics: [...bp.topics, { name: "", count: 0, subtopics: [] }] }));
  }

  function updateTopic(subjectKey, index, patch) {
    updateSubjectBlueprint(subjectKey, bp => ({
      ...bp,
      topics: bp.topics.map((topic, i) => {
        if (i !== index) return topic;
        const next = { ...topic, ...patch };
        if (Object.prototype.hasOwnProperty.call(patch, "count")) {
          next.count = clampTopicCount(subjectKey, index, patch.count, bp.topics);
          if (next.subtopics?.length) {
            next.subtopics = fitSubtopicsToCount(next.subtopics, next.count);
          }
        }
        return next;
      }),
    }));
  }

  function removeTopic(subjectKey, index) {
    updateSubjectBlueprint(subjectKey, bp => ({ ...bp, topics: bp.topics.filter((_, i) => i !== index) }));
  }

  function addSubtopic(subjectKey, topicIndex) {
    updateSubjectBlueprint(subjectKey, bp => ({
      ...bp,
      topics: bp.topics.map((topic, i) => i === topicIndex
        ? { ...topic, subtopics: [...(topic.subtopics || []), { name: "", count: 0 }] }
        : topic),
    }));
  }

  function updateSubtopic(subjectKey, topicIndex, subtopicIndex, patch) {
    updateSubjectBlueprint(subjectKey, bp => ({
      ...bp,
      topics: bp.topics.map((topic, i) => {
        if (i !== topicIndex) return topic;
        const next = { ...topic, subtopics: topic.subtopics.map((st, j) => {
          if (j !== subtopicIndex) return st;
          const merged = { ...st, ...patch };
          if (Object.prototype.hasOwnProperty.call(patch, "count")) {
            merged.count = clampSubtopicCount(topic, subtopicIndex, patch.count);
          }
          return merged;
        }) };
        if (Number(next.count || 0) < next.subtopics.reduce((sum, st) => sum + Number(st.count || 0), 0)) {
          next.count = next.subtopics.reduce((sum, st) => sum + Number(st.count || 0), 0);
        }
        return next;
      }),
    }));
  }

  function removeSubtopic(subjectKey, topicIndex, subtopicIndex) {
    updateSubjectBlueprint(subjectKey, bp => ({
      ...bp,
      topics: bp.topics.map((topic, i) => i === topicIndex
        ? { ...topic, subtopics: topic.subtopics.filter((_, j) => j !== subtopicIndex) }
        : topic),
    }));
  }

  function applyQuotaMove() {
    const amount = Number(quotaMove.amount);
    const from = quotaMove.from;
    const to = quotaMove.to;
    if (!from || !to || from === to || !Number.isFinite(amount) || amount <= 0) {
      setQuotaMsg("Choose different source and destination rows plus a valid amount.");
      return;
    }
    const [fromTopic, fromSubtopic = ""] = from.split("|||");
    const [toTopic, toSubtopic = ""] = to.split("|||");
    const sourceTopic = activeSubjectBlueprint.topics.find(topic => topic.name === fromTopic);
    const destinationTopic = activeSubjectBlueprint.topics.find(topic => topic.name === toTopic);
    const sourceCount = fromSubtopic
      ? Number(sourceTopic?.subtopics?.find(st => st.name === fromSubtopic)?.count || 0)
      : Number(sourceTopic?.count || 0);
    const destinationCount = toSubtopic
      ? Number(destinationTopic?.subtopics?.find(st => st.name === toSubtopic)?.count || 0)
      : Number(destinationTopic?.count || 0);
    const destinationCapacity = toSubtopic
      ? Math.max(0, Number(destinationTopic?.count || 0) - ((destinationTopic?.subtopics || []).reduce((sum, st) => sum + Number(st.count || 0), 0) - destinationCount))
      : Math.max(0, activeSubjectInfo.total - (activeSubjectBlueprint.topics.reduce((sum, topic) => {
        if (topic.name === toTopic) return sum;
        return sum + topicTotal(topic);
      }, 0)));
    if (sourceCount < amount) {
      setQuotaMsg("Source does not have enough questions to move.");
      return;
    }
    if (destinationCapacity < amount) {
      setQuotaMsg("Destination does not have enough room for that move.");
      return;
    }
    updateSubjectBlueprint(activeSubjectInfo.key, bp => ({
      ...bp,
      topics: bp.topics.map(topic => {
        let next = { ...topic, subtopics: [...(topic.subtopics || [])] };
        if (next.name === fromTopic) {
          if (fromSubtopic) {
            next.subtopics = next.subtopics.map(st => st.name === fromSubtopic ? { ...st, count: Number(st.count || 0) - amount } : st);
          } else {
            next.count = Number(next.count || 0) - amount;
          }
        }
        if (next.name === toTopic) {
          if (toSubtopic) {
            next.subtopics = next.subtopics.map(st => st.name === toSubtopic ? { ...st, count: Number(st.count || 0) + amount } : st);
          } else {
            next.count = Number(next.count || 0) + amount;
          }
        }
        return next;
      }),
    }));
    setQuotaMsg(`Moved ${amount} question${amount === 1 ? "" : "s"}.`);
  }

  function addQuestion(q) {
    if (allSelectedIds.has(q.id)) return;
    if (isReadingSubject) {
      if ((selections.reading || []).length >= readingTotal) return;
      const matchingSlot = activeSubjectSlots.find(slot => questionFitsSlot(q, slot) && slotSelectedCount(selections, slot) < slot.target)
        || activeSubjectSlots.find(slot => slotSelectedCount(selections, slot) < slot.target);
      const slotId = matchingSlot ? matchingSlot.slot_id : "reading|||Reading|||";
      setSelections(prev => ({ ...prev, reading: [...prev.reading, { ...q, _slotId: slotId }] }));
      return;
    }
    if (!activeSlot || !questionFitsSlot(q, activeSlot)) return;
    if (slotSelectedCount(selections, activeSlot) >= activeSlot.target) return;
    const nextFilled = slotSelectedCount(selections, activeSlot) + 1;
    setSelections(prev => ({ ...prev, [activeSlot.key]: [...prev[activeSlot.key], { ...q, _slotId: activeSlot.slot_id }] }));
    if (nextFilled >= activeSlot.target) {
      const currentIndex = activeSubjectSlots.findIndex(slot => slot.slot_id === activeSlot.slot_id);
      const nextInSubject = activeSubjectSlots.slice(currentIndex + 1).find(slot => slotSelectedCount(selections, slot) < slot.target);
      if (nextInSubject) {
        setActiveSlotIndex(activeSubjectSlots.findIndex(slot => slot.slot_id === nextInSubject.slot_id));
      } else {
        const currentSubjectIndex = SUBJECTS.findIndex(s => s.key === activeSubject);
        const nextSubjectItem = SUBJECTS.slice(currentSubjectIndex + 1).find(subject => {
          const subjectSlots = slots.filter(slot => slot.key === subject.key);
          return subjectSlots.some(slot => slotSelectedCount(selections, slot) < slot.target);
        });
        if (nextSubjectItem) {
          setActiveSubject(nextSubjectItem.key);
          setActiveSlotIndex(0);
        }
      }
      setPage(0);
    }
  }

  function removeQuestion(subjectKey, qid) {
    setSelections(prev => ({ ...prev, [subjectKey]: prev[subjectKey].filter(q => q.id !== qid) }));
  }

  function loadRecommendedTemplate() {
    setBlueprint(cloneBlueprint(RECOMMENDED_BLUEPRINT));
    setSelections(emptySelections());
    setActiveSubject(SUBJECTS[0].key);
    setActiveSlotIndex(0);
    setQuotaMsg("");
    setPlanSyncMsg("");
    setAutoPickMsg("");
    setExampleTemplateMsg("Filled the recommended plan. You can edit any topic or subtopic now.");
  }

  async function fetchQuestionPages(params) {
    const rows = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const pageParams = new URLSearchParams(params);
      pageParams.set("limit", String(pageSize));
      pageParams.set("offset", String(offset));
      const response = await fetch(`${REST}/questions?${pageParams}`, { headers: hdr(session.access_token) });
      if (!response.ok) throw new Error(await response.text());
      const pageRows = await response.json();
      rows.push(...(Array.isArray(pageRows) ? pageRows : []));
      if (!Array.isArray(pageRows) || pageRows.length < pageSize) break;
    }
    return rows;
  }

  async function autoPickQuestions() {
    setAutoPickBusy(true);
    setAutoPickMsg("");
    try {
      const plan = cloneBlueprint(blueprintComplete ? blueprint : RECOMMENDED_BLUEPRINT);
      const planSlots = buildSlots(plan);
      const nextSelections = emptySelections();
      const usedIds = new Set();
      const fallbackNotes = [];

      for (const subject of SUBJECTS) {
        if (subject.key === "reading") {
          const diffTarget = DIFFICULTY_TARGETS.reading;
          const allReadingQs = await fetchQuestionPages({
            select: "*",
            status: "eq.active",
            subject: "eq.Reading",
            order: "stimulus_id.asc,id.asc",
          }).then(rows => rows.filter(row => !EXCLUDED_AUTO_PICK_QUESTION_IDS.has(row.id) && row.stimulus_id));

          const byStimulus = new Map();
          allReadingQs.forEach(row => {
            if (!byStimulus.has(row.stimulus_id)) byStimulus.set(row.stimulus_id, []);
            byStimulus.get(row.stimulus_id).push(row);
          });

          const stimIds = [...byStimulus.keys()];
          for (let i = stimIds.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [stimIds[i], stimIds[j]] = [stimIds[j], stimIds[i]];
          }

          const pickedQs = [];
          let passageCount = 0;
          for (const stimId of stimIds) {
            if (passageCount >= 8 || pickedQs.length >= subject.total) break;
            pickedQs.push(...byStimulus.get(stimId).slice(0, 6));
            passageCount++;
          }

          const finalQs = trimReadingToTarget(pickedQs, subject.total, diffTarget);
          finalQs.sort((a, b) => a.stimulus_id.localeCompare(b.stimulus_id) || a.id.localeCompare(b.id));

          const topicMap = {};
          finalQs.forEach(q => {
            const t = q.topic || "Reading";
            const st = q.subtopic || "";
            if (!topicMap[t]) topicMap[t] = {};
            topicMap[t][st] = (topicMap[t][st] || 0) + 1;
          });
          plan.reading = {
            topics: Object.entries(topicMap).map(([topicName, stCounts]) => {
              const stEntries = Object.entries(stCounts).filter(([name]) => name);
              const total = Object.values(stCounts).reduce((a, b) => a + b, 0);
              return stEntries.length
                ? { name: topicName, count: total, subtopics: stEntries.map(([name, count]) => ({ name, count })) }
                : { name: topicName, count: total, subtopics: [] };
            }),
          };

          const readingSlots = buildSlots({ ...plan }).filter(s => s.key === "reading");
          finalQs.forEach(row => {
            const slot = readingSlots.find(s => questionFitsSlot(row, s));
            nextSelections.reading.push({ ...row, _slotId: slot ? slot.slot_id : readingSlots[0]?.slot_id || "reading|||Reading|||" });
            usedIds.add(row.id);
          });

          const pickedStimulusIds = [...new Set(finalQs.map(q => q.stimulus_id).filter(Boolean))];
          if (pickedStimulusIds.length) {
            const sr = await fetch(`${REST}/stimuli?select=id,stimulus_title,stimulus_type,stimulus_text&id=in.(${pickedStimulusIds.map(encodeURIComponent).join(",")})`, {
              headers: hdr(session.access_token),
            });
            if (sr.ok) {
              const stims = await sr.json();
              setStimulusMap(Object.fromEntries(stims.map(s => [s.id, s])));
            }
          }

          const selectedCounts = nextSelections.reading.reduce((counts, row) => {
            const d = normalizeDifficulty(row.difficulty_level);
            if (DIFFICULTIES.includes(d)) counts[d]++;
            return counts;
          }, emptyDifficultyCounts());
          if (DIFFICULTIES.some(d => selectedCounts[d] !== diffTarget[d])) {
            fallbackNotes.push(`Reading: difficulty split ${DIFFICULTIES.map(d => selectedCounts[d]).join("/")} (target ${DIFFICULTIES.map(d => diffTarget[d]).join("/")}) — passages were picked randomly so exact split may vary.`);
          }
          continue;
        }

        const subjectSlots = planSlots.filter(slot => slot.key === subject.key);
        const target = DIFFICULTY_TARGETS[subject.key];
        if (!target || difficultyTotal(target) !== subject.total) {
          fallbackNotes.push(`${subject.label}: difficulty target misconfigured, skipping subject.`);
          continue;
        }

        const rows = await fetchQuestionPages({
          select: "*",
          status: "eq.active",
          subject: subject.subjects.length > 1 ? `in.(${subject.subjects.join(",")})` : `eq.${subject.subjects[0]}`,
          order: "topic.asc,subtopic.asc,difficulty_level.asc,id.asc",
        }).then(questionRows => questionRows.filter(row => !EXCLUDED_AUTO_PICK_QUESTION_IDS.has(row.id)));

        const allocation = new Map(subjectSlots.map(slot => [slot.slot_id, emptyDifficultyCounts()]));
        const hasSlotDifficultyTargets = subjectSlots.every(slot =>
          slot.difficultyTargets &&
          difficultyTotal(slot.difficultyTargets) === slot.target
        );

        if (hasSlotDifficultyTargets) {
          subjectSlots.forEach(slot => {
            allocation.set(slot.slot_id, { ...emptyDifficultyCounts(), ...slot.difficultyTargets });
          });
        } else {
          const remainingBySlot = new Map(subjectSlots.map(slot => [slot.slot_id, slot.target]));
          const availableByDifficulty = Object.fromEntries(DIFFICULTIES.map(difficulty => [
            difficulty,
            rows.filter(row => DIFFICULTIES.includes(normalizeDifficulty(row.difficulty_level)) && normalizeDifficulty(row.difficulty_level) === difficulty).length,
          ]));
          const difficultyOrder = [...DIFFICULTIES].sort((a, b) => {
            const aRatio = target[a] ? availableByDifficulty[a] / target[a] : Infinity;
            const bRatio = target[b] ? availableByDifficulty[b] / target[b] : Infinity;
            return aRatio - bRatio;
          });

          for (const difficulty of difficultyOrder) {
            const quota = target[difficulty];
            if (!quota) continue;
            const cells = subjectSlots.map((slot, index) => ({
              index,
              slot,
              capacity: remainingBySlot.get(slot.slot_id) || 0,
              available: rows.filter(row =>
                !usedIds.has(row.id) &&
                questionFitsSlot(row, slot) &&
                normalizeDifficulty(row.difficulty_level) === difficulty
              ).length,
            })).filter(cell => cell.capacity > 0 && cell.available > 0);
            const totalAvail = cells.reduce((sum, cell) => sum + cell.available, 0);
            const effectiveQuota = Math.min(quota, totalAvail);
            if (effectiveQuota < quota) {
              fallbackNotes.push(`${subject.label}: only ${totalAvail} active ${difficulty} question(s) available (needed ${quota}); shortfall filled with other difficulties.`);
            }
            const distributed = effectiveQuota > 0 ? distributeQuota(cells, effectiveQuota) : null;
            if (distributed) {
              distributed.forEach(cell => {
                allocation.get(cell.slot.slot_id)[difficulty] = cell.take;
                remainingBySlot.set(cell.slot.slot_id, (remainingBySlot.get(cell.slot.slot_id) || 0) - cell.take);
              });
            }
          }
          // Fill any remaining slot capacity (from difficulty shortfalls) using the most-available difficulty
          for (const slot of subjectSlots) {
            const remaining = remainingBySlot.get(slot.slot_id) || 0;
            if (remaining <= 0) continue;
            const flexDiff = [...DIFFICULTIES].sort((a, b) => {
              const aAvail = rows.filter(row => !usedIds.has(row.id) && questionFitsSlot(row, slot) && normalizeDifficulty(row.difficulty_level) === a).length;
              const bAvail = rows.filter(row => !usedIds.has(row.id) && questionFitsSlot(row, slot) && normalizeDifficulty(row.difficulty_level) === b).length;
              return bAvail - aAvail;
            })[0];
            if (flexDiff) {
              allocation.get(slot.slot_id)[flexDiff] = (allocation.get(slot.slot_id)[flexDiff] || 0) + remaining;
              remainingBySlot.set(slot.slot_id, 0);
            }
          }
        }

        for (const slot of subjectSlots) {
          for (const difficulty of DIFFICULTIES) {
            const take = allocation.get(slot.slot_id)?.[difficulty] || 0;
            if (!take) continue;
            const picked = [];
            const pickFrom = (predicate) => {
              const needed = take - picked.length;
              if (needed <= 0) return;
              rows
                .filter(row => !usedIds.has(row.id) && predicate(row))
                .slice(0, needed)
                .forEach(row => {
                  usedIds.add(row.id);
                  picked.push(row);
                });
            };

            pickFrom(row => questionFitsSlot(row, slot) && normalizeDifficulty(row.difficulty_level) === difficulty);
            if (picked.length < take) {
              pickFrom(row => rowMatchesSlotTopic(row, slot) && normalizeDifficulty(row.difficulty_level) === difficulty);
            }
            if (picked.length < take) {
              pickFrom(row => (slot.subjects || []).includes(row.subject) && normalizeDifficulty(row.difficulty_level) === difficulty);
            }
            if (picked.length < take) {
              pickFrom(row => questionFitsSlot(row, slot));
            }
            if (picked.length < take) {
              pickFrom(row => rowMatchesSlotTopic(row, slot));
            }
            if (picked.length < take) {
              pickFrom(row => (slot.subjects || []).includes(row.subject));
            }
            if (picked.length < take) {
              fallbackNotes.push(`${subject.label}: ${slot.topic}${slot.subtopic ? `/${slot.subtopic}` : ""} could only fill ${picked.length}/${take} questions.`);
            }
            if (picked.some(row => !questionFitsSlot(row, slot) || normalizeDifficulty(row.difficulty_level) !== difficulty)) {
              fallbackNotes.push(`${subject.label}: ${slot.topic}${slot.subtopic ? ` / ${slot.subtopic}` : ""} used fallback question(s) for ${difficulty}.`);
            }
            picked.forEach(row => {
              nextSelections[subject.key].push({ ...row, _slotId: slot.slot_id });
            });
          }
        }

        const selectedCounts = nextSelections[subject.key].reduce((counts, row) => {
          const difficulty = normalizeDifficulty(row.difficulty_level);
          if (DIFFICULTIES.includes(difficulty)) counts[difficulty] += 1;
          return counts;
        }, emptyDifficultyCounts());
        if (DIFFICULTIES.some(difficulty => selectedCounts[difficulty] !== target[difficulty])) {
          fallbackNotes.push(`${subject.label}: final difficulty split is ${DIFFICULTIES.map(difficulty => selectedCounts[difficulty]).join("/")}, target was ${DIFFICULTIES.map(difficulty => target[difficulty]).join("/")}.`);
        }
      }

      setBlueprint(plan);
      setSelections(nextSelections);
      setActiveSubject(SUBJECTS[0].key);
      setActiveSlotIndex(0);
      setPage(0);
      setPlanSyncMsg("");
      setAutoPickMsg(`Auto-picked ${formatCount(selectedTotal(nextSelections))} questions.`);
    } catch (e) {
      setAutoPickMsg(`Auto-pick failed: ${e.message}`);
    } finally {
      setAutoPickBusy(false);
    }
  }

  async function openQ(q) {
    const base = { ...q, _inst: null, _stim: null, _vis: [] };
    setViewQ(base);
    setEditingQ(false);
    setEditMsg("");
    setEditForm(makeEditForm(base));
    setViewLoading(true);
    try {
      let inst = null;
      let stim = null;
      let vis = [];
      if (q.instruction_id) {
        const r = await fetch(`${REST}/instructions?id=eq.${encodeURIComponent(q.instruction_id)}&limit=1`, { headers: hdr(session.access_token) });
        inst = (await r.json())[0] || null;
      }
      if (q.stimulus_id) {
        const r = await fetch(`${REST}/stimuli?id=eq.${encodeURIComponent(q.stimulus_id)}&limit=1`, { headers: hdr(session.access_token) });
        stim = (await r.json())[0] || null;
      }
      const vr = await fetch(`${REST}/question_visual_assets?question_id=eq.${encodeURIComponent(q.id)}&select=*,visual_assets(*)`, { headers: hdr(session.access_token) });
      vis = vr.ok ? await vr.json() : [];
      const full = { ...base, _inst: inst, _stim: stim, _vis: vis };
      setViewQ(full);
      setEditForm(makeEditForm(full));
    } catch (e) {
      setEditMsg("Error: " + e.message);
    } finally {
      setViewLoading(false);
    }
  }

  function applyQuestionUpdate(updated) {
    setViewQ(prev => prev?.id === updated.id ? { ...prev, ...updated } : prev);
    setQuestions(prev => prev.map(q => q.id === updated.id ? { ...q, ...updated } : q));
    setSelections(prev => Object.fromEntries(
      Object.entries(prev).map(([key, list]) => [key, list.map(q => q.id === updated.id ? { ...q, ...updated } : q)])
    ));
  }

  async function saveQuestionEdits() {
    if (!viewQ) return;
    setEditBusy(true);
    setEditMsg("");
    const questionBody = {
      question_text: editForm.question_text,
      choice_a: editForm.choice_a,
      choice_b: editForm.choice_b,
      choice_c: editForm.choice_c,
      choice_d: editForm.choice_d,
      choice_e: editForm.choice_e || null,
      correct_answer: editForm.correct_answer,
      difficulty_level: editForm.difficulty_level,
      status: editForm.status,
      source_school: editForm.source_school || null,
      subject: editForm.subject,
      topic: editForm.topic,
      subtopic: editForm.subtopic || null,
      render_markup: editForm.render_markup || null,
    };
    const mathValidation = validateMathItem(questionBody);
    if (mathValidation.checked && !mathValidation.valid) questionBody.status = "needs_human_review";
    try {
      const qr = await fetch(`${REST}/questions?id=eq.${encodeURIComponent(viewQ.id)}`, {
        method: "PATCH",
        headers: { ...hdr(session.access_token), Prefer: "return=representation" },
        body: JSON.stringify(questionBody),
      });
      if (!qr.ok) throw new Error("Question update failed: " + await qr.text());
      const updatedQuestion = (await qr.json())[0] || { ...viewQ, ...questionBody };

      let updatedInst = viewQ._inst || null;
      if (viewQ.instruction_id && viewQ._inst) {
        const ir = await fetch(`${REST}/instructions?id=eq.${encodeURIComponent(viewQ.instruction_id)}`, {
          method: "PATCH",
          headers: { ...hdr(session.access_token), Prefer: "return=representation" },
          body: JSON.stringify({ code: editForm.instruction_code || null, instruction_text: editForm.instruction_text || null }),
        });
        if (!ir.ok) throw new Error("Instruction update failed: " + await ir.text());
        updatedInst = (await ir.json())[0] || updatedInst;
      }

      let updatedStim = viewQ._stim || null;
      if (viewQ.stimulus_id && viewQ._stim) {
        const sr = await fetch(`${REST}/stimuli?id=eq.${encodeURIComponent(viewQ.stimulus_id)}`, {
          method: "PATCH",
          headers: { ...hdr(session.access_token), Prefer: "return=representation" },
          body: JSON.stringify({
            stimulus_type: editForm.stimulus_type || null,
            stimulus_title: editForm.stimulus_title || null,
            stimulus_text: editForm.stimulus_text || null,
          }),
        });
        if (!sr.ok) throw new Error("Stimulus update failed: " + await sr.text());
        updatedStim = (await sr.json())[0] || updatedStim;
      }

      const merged = { ...viewQ, ...updatedQuestion, _inst: updatedInst, _stim: updatedStim };
      applyQuestionUpdate(merged);
      setViewQ(merged);
      setEditForm(makeEditForm(merged));
      setEditingQ(false);
      setEditMsg(mathValidation.checked && !mathValidation.valid ? `Saved; flagged needs_human_review. ${mathValidation.reason}` : "Saved to database.");
      setQuestionRefresh(v => v + 1);
      await loadClassOpts();
      if (allSelectedIds.has(merged.id) && activeSlot && !questionFitsSlot(merged, activeSlot)) {
        setEditMsg("Saved to database. This selected question no longer matches the current slot; review the selected list before saving the exam.");
      }
    } catch (e) {
      setEditMsg("Error: " + e.message);
    } finally {
      setEditBusy(false);
    }
  }

  async function saveTemplate() {
    setSaving(true);
    setSaveMsg("");
    try {
      let template_id = propTemplateId || null;
      if (!template_id) {
        const checkRes = await fetch(`${REST}/diagnostic_templates?code=eq.${encodeURIComponent(templateCode)}&select=id&limit=1`, {
          headers: hdr(session.access_token),
        });
        const existing = await checkRes.json();
        if (existing?.length > 0) {
          template_id = existing[0].id;
        } else {
          const createRes = await fetch(`${REST}/diagnostic_templates`, {
            method: "POST",
            headers: { ...hdr(session.access_token), Prefer: "return=representation" },
            body: JSON.stringify({ code: templateCode, version: 1, total_questions: selectedCount, is_active: true }),
          });
          if (!createRes.ok) throw new Error("Failed to create template: " + await createRes.text());
          const created = await createRes.json();
          template_id = Array.isArray(created) ? created[0].id : created.id;
        }
      } else {
        const patchRes = await fetch(`${REST}/diagnostic_templates?id=eq.${template_id}`, {
          method: "PATCH",
          headers: { ...hdr(session.access_token), Prefer: "return=minimal" },
          body: JSON.stringify({ total_questions: selectedCount }),
        });
        if (!patchRes.ok) throw new Error("Failed to update template: " + await patchRes.text());
      }

      const deleteRes = await fetch(`${REST}/diagnostic_template_questions?template_id=eq.${template_id}`, {
        method: "DELETE",
        headers: hdr(session.access_token),
      });
      if (!deleteRes.ok) throw new Error("Failed to clear existing template rows: " + await deleteRes.text());

      let order = 0;
      const rows = SUBJECTS.flatMap(subject => {
        let list = selections[subject.key] || [];
        if (subject.key === "reading") {
          list = [...list].sort((a, b) =>
            (a.stimulus_id || "").localeCompare(b.stimulus_id || "") || (a.id || "").localeCompare(b.id || "")
          );
        }
        return list.map(q => ({
          template_id,
          question_id: q.id,
          section_name: subject.section_name,
          display_order: ++order,
        }));
      });
      const insertRes = await fetch(`${REST}/diagnostic_template_questions`, {
        method: "POST",
        headers: { ...hdr(session.access_token), Prefer: "return=minimal" },
        body: JSON.stringify(rows),
      });
      if (!insertRes.ok) throw new Error("Failed to insert rows: " + await insertRes.text());

      setSaveMsg("Saved successfully.");
      removeDraft(draftCode || templateCode);
      setTimeout(() => onSaveComplete(), 700);
    } catch (e) {
      setSaveMsg("Error: " + e.message);
    } finally {
      setSaving(false);
    }
  }

  const subjectOptions = optionsForSubject(classOpts, activeSubjectInfo.subjects);
  const quotaRows = activeSubjectBlueprint.topics.flatMap(topic => {
    if (topic.subtopics?.length) return topic.subtopics.map(st => ({ label: `${topic.name} / ${st.name}`, value: `${topic.name}|||${st.name}`, count: Number(st.count || 0) }));
    return [{ label: topic.name || "Unnamed topic", value: `${topic.name}|||`, count: Number(topic.count || 0) }];
  });
  const readingPassageGroups = useMemo(() => {
    if (!isReadingSubject) return [];
    const groups = {};
    (selections.reading || []).forEach(q => {
      if (!q.stimulus_id) return;
      if (!groups[q.stimulus_id]) groups[q.stimulus_id] = 0;
      groups[q.stimulus_id]++;
    });
    return Object.entries(groups).map(([stimId, count]) => ({
      stimId,
      title: stimulusMap[stimId]?.stimulus_title || "Untitled passage",
      count,
    }));
  }, [isReadingSubject, selections.reading, stimulusMap]);

  // Pin already-selected questions for this slot to the top of the list so they're
  // easy to find and edit after an exam is built, regardless of which DB page they're on.
  const slotSelections = useMemo(() => {
    if (isReadingSubject) {
      return activePassageId
        ? (selections.reading || []).filter(q => q.stimulus_id === activePassageId)
        : [];
    }
    return activeSlot ? (selections[activeSlot.key] || []).filter(q => questionFitsSlot(q, activeSlot)) : [];
  }, [isReadingSubject, activePassageId, selections, activeSlot]);
  const slotSelectionIds = new Set(slotSelections.map(q => q.id));
  const displayed = hideAdded
    ? questions.filter(q => !allSelectedIds.has(q.id))
    : [...slotSelections, ...questions.filter(q => !slotSelectionIds.has(q.id))];
  const activeSlotCount = activeSlot ? slotSelectedCount(selections, activeSlot) : 0;
  const readingSelectedCount = (selections.reading || []).length;
  const viewAdded = viewQ ? allSelectedIds.has(viewQ.id) : false;
  const viewCanAdd = viewQ && !viewAdded && (
    isReadingSubject
      ? readingSelectedCount < readingTotal
      : activeSlot && questionFitsSlot(viewQ, activeSlot) && activeSlotCount < activeSlot.target
  );
  const editSubjectOptions = [...new Set([...weightOpts.subjects, editForm.subject].filter(Boolean))].sort();
  const editTopicOptions = [...new Set([
    ...weightOpts.topics.map(t => t.split("|||")).filter(p => !editForm.subject || p[0] === editForm.subject).map(p => p[1]).filter(Boolean),
    editForm.topic,
  ].filter(Boolean))].sort();
  const editSubtopicOptions = [...new Set([
    ...weightOpts.subtopics.map(s => s.split("|||")).filter(p => (!editForm.subject || p[0] === editForm.subject) && (!editForm.topic || !p[1] || p[1] === editForm.topic)).map(p => p[2]).filter(Boolean),
    editForm.subtopic,
  ].filter(Boolean))].sort();

  return (
    <div style={PAGE}>
      {showConfirm && (
        <Modal onClose={() => setShowConfirm(false)} width={460}>
          <h3 style={H3}>Save {templateLabel}?</h3>
          <p style={P}>This writes to the same tables as the old builder: <code>diagnostic_templates</code> and <code>diagnostic_template_questions</code>.</p>
          {saveMsg && <div style={{ ...MSG, color: saveMsg.startsWith("Error") ? "#ef4444" : "#22c55e" }}>{saveMsg}</div>}
          <div style={ROW}>
            <button onClick={saveTemplate} disabled={saving} style={{ ...BTN, opacity: saving ? 0.65 : 1 }}>{saving ? "Saving..." : "Confirm Save"}</button>
            <button onClick={() => setShowConfirm(false)} disabled={saving} style={BTN2}>Cancel</button>
          </div>
        </Modal>
      )}

      {viewQ && (
        <QuestionModal
          viewQ={viewQ}
          activeSlot={activeSlot}
          viewLoading={viewLoading}
          editingQ={editingQ}
          setEditingQ={setEditingQ}
          editForm={editForm}
          setEditForm={setEditForm}
          editBusy={editBusy}
          editMsg={editMsg}
          saveQuestionEdits={saveQuestionEdits}
          close={() => setViewQ(null)}
          openAdd={() => { addQuestion(viewQ); setViewQ(null); }}
          openRemove={() => { SUBJECTS.forEach(s => removeQuestion(s.key, viewQ.id)); setViewQ(null); }}
          viewAdded={viewAdded}
          viewCanAdd={viewCanAdd}
          visualMap={visualMap}
          editSubjectOptions={editSubjectOptions}
          editTopicOptions={editTopicOptions}
          editSubtopicOptions={editSubtopicOptions}
        />
      )}

      <div style={TOPBAR}>
        <button onClick={onBack} style={BTN2}>Back to Exams</button>
        {propTemplateId && (
          <button onClick={discardChanges} style={{ ...BTN2, color: "#f87171", borderColor: "#f8717155" }}>Discard Changes</button>
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ color: "#f1f5f9", fontSize: 14, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{templateLabel}</div>
          <div style={{ color: "#64748b", fontSize: 11 }}>{formatCount(selectedCount)} / {formatCount(targetCount)} questions selected</div>
        </div>
        <div style={{ flex: 1, height: 5, background: "#1a2236", borderRadius: 8, overflow: "hidden", maxWidth: 220 }}>
          <div style={{ width: `${Math.min(100, (selectedCount / targetCount) * 100)}%`, height: "100%", background: allSlotsComplete ? "#22c55e" : "#f59e0b" }} />
        </div>
        <button onClick={() => setShowConfirm(true)} disabled={!allSlotsComplete} style={{ ...BTN, marginLeft: "auto", opacity: allSlotsComplete ? 1 : 0.45 }}>
          {allSlotsComplete ? "Save Exam" : "Complete exam to save"}
        </button>
      </div>

      <div style={STEPS}>
        {[
          ["welcome", "Welcome"],
          ["blueprint", "1. Plan"],
          ["select", "2. Pick Questions"],
          ["review", "3. Check"],
        ].map(([key, label]) => (
          <button key={key} onClick={() => setStage(key)} style={{ ...STEPBTN, color: stage === key ? "#f1f5f9" : "#64748b", borderColor: stage === key ? "#f59e0b" : "#1a2236" }}>
            {label}
          </button>
        ))}
      </div>

      {stage === "welcome" && (
        <div style={WELCOME}>
          <div style={WELCOME_INNER}>
            <div style={WELCOME_COPY}>
              <h2 style={{ margin: 0, color: "#f1f5f9", fontSize: 22 }}>Exam Builder</h2>
              <p style={{ ...P, maxWidth: 760, marginLeft: "auto", marginRight: "auto" }}>
                This has 2 simple parts. First, make the plan one subject at a time. That means telling the builder how many questions go into each topic and subtopic for the current subject. Then pick the actual questions that match that subject.
              </p>
            </div>
            <div style={WELCOME_GRID}>
            {SUBJECTS.map(s => (
              <div key={s.key} style={{ ...CARD, flex: "1 1 250px", maxWidth: 300, minWidth: 250 }}>
                <div style={{ color: s.color, fontSize: 11, fontWeight: 900, textTransform: "uppercase" }}>{s.label}</div>
                <div style={{ color: "#f1f5f9", fontSize: 24, fontWeight: 900 }}>{s.total}</div>
                <div style={{ color: "#64748b", fontSize: 12 }}>fixed questions in the exam</div>
              </div>
            ))}
            </div>
            <div style={WELCOME_ACTION}>
                  <button onClick={() => { setStage("blueprint"); setActiveSubject(SUBJECTS[0].key); }} style={BTN}>Start Planning</button>
            </div>
          </div>
        </div>
      )}

      {stage === "blueprint" && (
        <div style={WORKSPACE}>
          <div style={WORKSPACE_BODY}>
          <aside style={SIDEBAR}>
            {SUBJECTS.map(s => {
              const used = subjectBlueprintTotal(blueprint[s.key]);
              const done = used === s.total;
              return (
                <button key={s.key} onClick={() => { setActiveSubject(s.key); setQuotaMsg(""); }} style={{ ...SUBJECT_BTN, borderColor: activeSubject === s.key ? s.color : "#1a2236" }}>
                  <span style={{ color: activeSubject === s.key ? "#f1f5f9" : "#94a3b8", fontWeight: 800 }}>{s.label}</span>
                  <span style={{ color: done ? "#22c55e" : used > s.total ? "#ef4444" : "#f59e0b", fontSize: 11 }}>{formatCount(used)}/{formatCount(s.total)}</span>
                </button>
              );
            })}
          </aside>
          <main style={MAIN}>
            <div style={BLUEPRINT_HEAD}>
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ color: activeSubjectInfo.color, fontSize: 11, fontWeight: 900, textTransform: "uppercase", marginBottom: 6 }}>{activeSubjectInfo.label}</div>
                    <h3 style={{ ...H3, marginBottom: 6 }}>Plan {activeSubjectInfo.label} Question Allocation</h3>
                    <div style={SMALL}>You need {activeSubjectInfo.total} {activeSubjectInfo.label} questions. Distribute them across topics and subtopics below.</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", flexShrink: 0 }}>
                    <button onClick={() => addTopic(activeSubjectInfo.key)} style={BTN}>Add Topic</button>
                    <button onClick={() => { if (blueprintComplete) { setActiveSubject(SUBJECTS[0].key); setActiveSlotIndex(0); setStage("select"); } }} disabled={!blueprintComplete} style={{ ...BTN2, opacity: blueprintComplete ? 1 : 0.45 }}>Next: Pick Questions</button>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ ...STATUS_PILL, color: subjectBlueprintTotal(activeSubjectBlueprint) === activeSubjectInfo.total ? "#22c55e" : subjectBlueprintTotal(activeSubjectBlueprint) > activeSubjectInfo.total ? "#ef4444" : "#f59e0b" }}>
                    {subjectBlueprintTotal(activeSubjectBlueprint) === activeSubjectInfo.total
                      ? `All ${formatCount(activeSubjectInfo.total)} assigned ✓`
                      : subjectBlueprintTotal(activeSubjectBlueprint) > activeSubjectInfo.total
                        ? `${formatCount(subjectBlueprintTotal(activeSubjectBlueprint))} / ${formatCount(activeSubjectInfo.total)} — ${formatCount(subjectBlueprintTotal(activeSubjectBlueprint) - activeSubjectInfo.total)} over budget`
                        : `${formatCount(subjectBlueprintTotal(activeSubjectBlueprint))} / ${formatCount(activeSubjectInfo.total)} — ${formatCount(activeSubjectInfo.total - subjectBlueprintTotal(activeSubjectBlueprint))} in pool`}
                  </div>
                  <span style={TOPIC_COUNT_PILL}>Subject {activeSubjectIndex + 1} of {SUBJECTS.length}</span>
                  <button
                    onClick={() => setActiveSubject(previousSubject.key)}
                    disabled={activeSubjectIndex === 0}
                    style={{ ...BTN2, opacity: activeSubjectIndex === 0 ? 0.45 : 1 }}
                  >
                    Previous Subject
                  </button>
                  <button
                    onClick={() => setActiveSubject(nextSubject.key)}
                    disabled={activeSubjectIndex === SUBJECTS.length - 1}
                    style={{ ...BTN2, opacity: activeSubjectIndex === SUBJECTS.length - 1 ? 0.45 : 1 }}
                  >
                    Next Subject
                  </button>
                </div>
              </div>
            </div>

            {exampleTemplateMsg && <div style={{ ...WARN, marginBottom: 12, color: "#cbd5e1" }}>{exampleTemplateMsg}</div>}
            {planSyncMsg && <div style={{ ...WARN, marginBottom: 12, color: "#cbd5e1" }}>{planSyncMsg}</div>}

            <div style={IMPORT_PANEL}>
              <div style={IMPORT_HEADER}>
                <div>
                  <div style={LABEL}>Recommended plan</div>
                  <div style={{ color: "#cbd5e1", fontSize: 12 }}>Fill the topic and subtopic allocation from the current exam proposal or start from a blank plan.</div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={loadRecommendedTemplate} style={BTN2}>Fill Recommended Plan</button>
                  <button onClick={() => { setBlueprint(createBlueprint()); setSelections(emptySelections()); setExampleTemplateMsg("Started a blank plan."); setQuotaMsg(""); setPlanSyncMsg(""); setActiveSubject(SUBJECTS[0].key); setActiveSlotIndex(0); }} style={BTN2}>Start Blank</button>
                </div>
              </div>
            </div>

            {(() => {
              const freePool = activeSubjectInfo.total - subjectBlueprintTotal(activeSubjectBlueprint);
              if (freePool === 0) return null;
              return (
                <div style={{ maxWidth: 860, width: "100%", margin: "0 auto 12px", padding: "12px 16px", borderRadius: 10, background: freePool > 0 ? "#1c2a1a" : "#2a1a1a", border: `1px solid ${freePool > 0 ? "#22c55e40" : "#ef444440"}`, display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 20, lineHeight: 1 }}>{freePool > 0 ? "🟢" : "🔴"}</span>
                  <div>
                    <div style={{ color: freePool > 0 ? "#86efac" : "#fca5a5", fontWeight: 800, fontSize: 14 }}>
                      {freePool > 0 ? `${freePool} question${freePool !== 1 ? "s" : ""} free to assign` : `${Math.abs(freePool)} question${Math.abs(freePool) !== 1 ? "s" : ""} over budget — remove some`}
                    </div>
                    <div style={{ color: "#64748b", fontSize: 12, marginTop: 2 }}>
                      {freePool > 0 ? "Use the + buttons below to distribute them across topics." : "Reduce a topic's count to get back in budget."}
                    </div>
                  </div>
                </div>
              );
            })()}
            {activeSubjectBlueprint.topics.length === 0 && <div style={EMPTY}>Click Add Topic to create the first bucket for this subject.</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 860, width: "100%", margin: "0 auto" }}>
              {activeSubjectBlueprint.topics.map((topic, topicIndex) => {
                const subtopicSum = (topic.subtopics || []).reduce((sum, st) => sum + Number(st.count || 0), 0);
                const topicCount = Number(topic.count || 0);
                const topicBalance = topic.subtopics?.length ? topicCount - subtopicSum : 0;
                const otherTopicsTotal = activeSubjectBlueprint.topics.reduce((sum, t, i) => i !== topicIndex ? sum + topicTotal(t) : sum, 0);
                const topicMax = Math.max(topicCount, activeSubjectInfo.total - otherTopicsTotal);
                return (
                  <div key={topicIndex} style={TOPIC_CARD}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start", marginBottom: 10, flexWrap: "wrap" }}>
                      <div>
                        <div style={LABEL}>Topic</div>
                        <div style={{ color: "#f1f5f9", fontSize: 16, fontWeight: 800 }}>Topic: {topic.name || "Untitled topic"}</div>
                      </div>
                      <div style={TOPIC_COUNT_PILL}>Questions for this topic: {formatCount(topic.count)}</div>
                    </div>
                    <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 10 }}>A topic bucket for this subject. Add subtopics to split it into smaller parts.</div>
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1fr) auto auto", gap: 8, alignItems: "center" }}>
                      <ComboInput value={topic.name} options={subjectOptions.topics} placeholder="Topic" onChange={value => updateTopic(activeSubjectInfo.key, topicIndex, { name: value })} />
                      <NumberInput value={topic.count} onChange={value => updateTopic(activeSubjectInfo.key, topicIndex, { count: value })} max={topicMax} />
                      <button onClick={() => removeTopic(activeSubjectInfo.key, topicIndex)} style={DANGER_BTN}>Remove Topic</button>
                    </div>
                    <div style={{ color: topic.subtopics?.length && topicBalance !== 0 ? "#f59e0b" : "#64748b", fontSize: 12, marginTop: 10 }}>
                      {topic.subtopics?.length ? `Subtopics allocated: ${formatCount(subtopicSum)} / ${formatCount(topicCount)}` : "If you do not add subtopics, this topic count is used directly."}
                    </div>
                    {topic.subtopics?.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
                        {topic.subtopics.map((subtopic, subtopicIndex) => {
                          const subtopicMax = Math.max(0, Number(topic.count || 0) - (subtopicSum - Number(subtopic.count || 0)));
                          return (
                            <div key={subtopicIndex} style={{ display: "grid", gridTemplateColumns: "24px minmax(180px, 1fr) auto auto", gap: 8, alignItems: "center" }}>
                              <span style={{ color: "#334155", textAlign: "center" }}>-</span>
                              <ComboInput value={subtopic.name} options={subjectOptions.subtopicsByTopic[topic.name] || []} placeholder="Subtopic" onChange={value => updateSubtopic(activeSubjectInfo.key, topicIndex, subtopicIndex, { name: value })} />
                              <NumberInput value={subtopic.count} onChange={value => updateSubtopic(activeSubjectInfo.key, topicIndex, subtopicIndex, { count: value })} max={subtopicMax} />
                              <button onClick={() => removeSubtopic(activeSubjectInfo.key, topicIndex, subtopicIndex)} style={DANGER_BTN}>Remove</button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                      <button onClick={() => addSubtopic(activeSubjectInfo.key, topicIndex)} style={BTN2}>Add Subtopic</button>
                    </div>
                  </div>
                );
              })}
            </div>

            {quotaRows.length > 1 && (
              <div style={{ ...PANEL, marginTop: 16, maxWidth: 860, width: "100%", marginLeft: "auto", marginRight: "auto" }}>
                <div style={LABEL}>Transfer Questions</div>
                <div style={{ color: "#64748b", fontSize: 12, marginBottom: 10 }}>Move questions from one topic to another without changing the total. Pick how many, where they come from, and where they go.</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ ...SMALL, color: "#94a3b8", fontSize: 11 }}>How many</span>
                    <input type="number" min="1" value={quotaMove.amount} onChange={e => setQuotaMove(v => ({ ...v, amount: e.target.value }))} style={{ ...INPUT, width: 70 }} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ ...SMALL, color: "#94a3b8", fontSize: 11 }}>Take from</span>
                    <select value={quotaMove.from} onChange={e => setQuotaMove(v => ({ ...v, from: e.target.value }))} style={SELECT}>
                      <option value="">— pick topic —</option>
                      {quotaRows.map(row => <option key={row.value} value={row.value}>{row.label} ({row.count} now)</option>)}
                    </select>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ ...SMALL, color: "#94a3b8", fontSize: 11 }}>Give to</span>
                    <select value={quotaMove.to} onChange={e => setQuotaMove(v => ({ ...v, to: e.target.value }))} style={SELECT}>
                      <option value="">— pick topic —</option>
                      {quotaRows.map(row => <option key={row.value} value={row.value}>{row.label} ({row.count} now)</option>)}
                    </select>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ ...SMALL, fontSize: 11, color: "transparent" }}>.</span>
                    <button onClick={applyQuotaMove} style={BTN2}>Move</button>
                  </div>
                </div>
                {quotaMsg && <div style={{ ...MSG, color: quotaMsg.startsWith("Moved") ? "#22c55e" : "#ef4444" }}>{quotaMsg}</div>}
              </div>
            )}
          </main>
          </div>
        </div>
      )}

      {stage === "select" && (
        <div style={WORKSPACE}>
          <main style={MAIN}>
            {!blueprintComplete && <div style={WARN}>Finish the plan first. You need to assign all questions before picking them.</div>}
            <div style={{ ...PANEL, marginBottom: 12, maxWidth: 1180, width: "100%", padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0 }}>
                  <span style={{ color: activeSubjectInfo.color, fontSize: 11, fontWeight: 900, textTransform: "uppercase", whiteSpace: "nowrap" }}>{activeSubjectInfo.label}</span>
                  <span style={TOPIC_COUNT_PILL}>Subject {activeSubjectIndex + 1}/{SUBJECTS.length}</span>
                  <span style={{ color: "#64748b", fontSize: 12 }}>Pick one subject at a time.</span>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    onClick={autoPickQuestions}
                    disabled={autoPickBusy}
                    style={{ ...BTN, padding: "5px 10px", opacity: autoPickBusy ? 0.6 : 1 }}
                  >
                    {autoPickBusy ? "Auto-picking..." : "Auto-pick Questions"}
                  </button>
                  <button
                    onClick={() => { setActiveSubject(previousSubject.key); setActiveSlotIndex(0); setPage(0); }}
                    disabled={activeSubjectIndex === 0}
                    style={{ ...BTN2, padding: "5px 9px", opacity: activeSubjectIndex === 0 ? 0.45 : 1 }}
                  >
                    Prev
                  </button>
                  <button
                    onClick={() => { setActiveSubject(nextSubject.key); setActiveSlotIndex(0); setPage(0); }}
                    disabled={activeSubjectIndex === SUBJECTS.length - 1}
                    style={{ ...BTN2, padding: "5px 9px", opacity: activeSubjectIndex === SUBJECTS.length - 1 ? 0.45 : 1 }}
                  >
                    Next
                  </button>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, overflowX: "auto", overflowY: "hidden", paddingTop: 10, paddingBottom: 2, scrollbarWidth: "thin" }}>
                {isReadingSubject ? (
                  <>
                    <button
                      onClick={() => { setActivePassageId(null); setPage(0); }}
                      style={{ ...SLOT_BTN, minWidth: 160, flex: "0 0 160px", borderColor: activePassageId === null ? activeSubjectInfo.color : "#1a2236", marginBottom: 0, padding: "7px 9px" }}
                    >
                      <span style={{ color: activePassageId === null ? "#f1f5f9" : "#94a3b8", fontWeight: 800 }}>All passages</span>
                      <div style={{ height: 5, background: "#1a2236", borderRadius: 999, overflow: "hidden", marginTop: 3 }}>
                        <div style={{ width: `${Math.min(100, Math.round((readingSelectedCount / readingTotal) * 100))}%`, height: "100%", background: readingSelectedCount === readingTotal ? "#22c55e" : activeSubjectInfo.color }} />
                      </div>
                      <span style={{ color: readingSelectedCount === readingTotal ? "#22c55e" : "#f59e0b", fontSize: 11, fontWeight: 900 }}>{formatCount(readingSelectedCount)}/{formatCount(readingTotal)} picked</span>
                    </button>
                    {readingPassageGroups.map(({ stimId, title, count }) => (
                      <button
                        key={stimId}
                        onClick={() => { setActivePassageId(stimId); setPage(0); }}
                        style={{ ...SLOT_BTN, minWidth: 180, flex: "0 0 180px", borderColor: activePassageId === stimId ? activeSubjectInfo.color : "#1a2236", marginBottom: 0, padding: "7px 9px" }}
                      >
                        <span style={{ color: activePassageId === stimId ? "#f1f5f9" : "#94a3b8", fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{title}</span>
                        <span style={{ color: "#22c55e", fontSize: 11, fontWeight: 900 }}>{count} question{count !== 1 ? "s" : ""} selected</span>
                      </button>
                    ))}
                  </>
                ) : (
                  activeSubjectSlots.map((slot, index) => {
                    const filled = slotSelectedCount(selections, slot);
                    const active = index === activeSlotIndex;
                    const pct = slot.target ? Math.min(100, Math.round((filled / slot.target) * 100)) : 0;
                    return (
                      <button key={`${slot.key}-${slot.topic}-${slot.subtopic}-${index}`} onClick={() => { setActiveSlotIndex(index); setPage(0); }} style={{ ...SLOT_BTN, minWidth: 180, flex: "0 0 180px", borderColor: active ? slot.color : "#1a2236", marginBottom: 0, padding: "7px 9px" }}>
                        <span style={{ color: active ? "#f1f5f9" : "#94a3b8", fontWeight: 800 }}>{slot.label}</span>
                        <span style={{ color: "#64748b", fontSize: 11 }}>{slot.topic}{slot.subtopic ? ` / ${slot.subtopic}` : ""}</span>
                        <div style={{ height: 5, background: "#1a2236", borderRadius: 999, overflow: "hidden", marginTop: 3 }}>
                          <div style={{ width: `${pct}%`, height: "100%", background: filled === slot.target ? "#22c55e" : slot.color }} />
                        </div>
                        <span style={{ color: filled === slot.target ? "#22c55e" : "#f59e0b", fontSize: 11, fontWeight: 900 }}>{formatCount(filled)}/{formatCount(slot.target)} picked</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
            {autoPickMsg && <div style={{ ...WARN, marginBottom: 12, color: autoPickMsg.startsWith("Auto-pick failed") ? "#ef4444" : "#cbd5e1" }}>{autoPickMsg}</div>}

            {(isReadingSubject || activeSlot) ? (
              <>
                <div style={SECTION_HEAD}>
                  {isReadingSubject ? (
                    <>
                      <div>
                        <div style={{ color: activeSubjectInfo.color, fontSize: 11, fontWeight: 900, textTransform: "uppercase" }}>Reading</div>
                        <h3 style={H3}>{activePassageId ? (stimulusMap[activePassageId]?.stimulus_title || "Untitled passage") : "All passages"}</h3>
                        <div style={SMALL}>Browse and add questions. Questions from the same passage will stay grouped together in the exam.</div>
                      </div>
                      <div style={{ color: readingSelectedCount === readingTotal ? "#22c55e" : "#f59e0b", fontWeight: 900 }}>{formatCount(readingSelectedCount)}/{formatCount(readingTotal)}</div>
                    </>
                  ) : (
                    <>
                      <div>
                        <div style={{ color: activeSlot.color, fontSize: 11, fontWeight: 900, textTransform: "uppercase" }}>{activeSlot.label}</div>
                        <h3 style={H3}>{activeSlot.topic}{activeSlot.subtopic ? ` / ${activeSlot.subtopic}` : ""}</h3>
                        <div style={SMALL}>You only need to work on this subject right now. Finish its buckets, then move to the next subject.</div>
                      </div>
                      <div style={{ color: activeSlotCount === activeSlot.target ? "#22c55e" : "#f59e0b", fontWeight: 900 }}>{formatCount(activeSlotCount)}/{formatCount(activeSlot.target)}</div>
                    </>
                  )}
                </div>
                {planSyncMsg && <div style={{ ...WARN, marginBottom: 12, color: "#cbd5e1" }}>{planSyncMsg}</div>}
                <div style={FILTERBAR}>
                  <span style={{ color: "#cbd5e1", fontSize: 12, fontWeight: 800 }}>{activeSubjectInfo.label}</span>
                  <select value={filters.difficulty_level} onChange={e => { setFilters({ difficulty_level: e.target.value }); setPage(0); }} style={SELECT}>
                    <option value="all">All difficulties</option>
                    <option value="easy">Easy</option>
                    <option value="medium">Medium</option>
                    <option value="hard">Hard</option>
                  </select>
                  <input value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} placeholder="Search questions" style={INPUT} />
                  <label style={{ display: "flex", gap: 6, alignItems: "center", color: "#64748b", fontSize: 12 }}>
                    <input type="checkbox" checked={hideAdded} onChange={e => setHideAdded(e.target.checked)} />
                    Hide added
                  </label>
                  <span style={{ marginLeft: "auto", color: "#475569", fontSize: 12 }}>{total} results</span>
                </div>
                <QuestionList
                  busy={busy}
                  questions={displayed}
                  stimulusMap={stimulusMap}
                  visualMap={visualMap}
                  allSelectedIds={allSelectedIds}
                  canAddMore={isReadingSubject ? readingSelectedCount < readingTotal : activeSlotCount < activeSlot.target}
                  activeSlot={isReadingSubject ? null : activeSlot}
                  onView={openQ}
                  onAdd={addQuestion}
                  subjectKey={isReadingSubject ? "reading" : activeSlot.key}
                  selections={selections}
                  onRemove={removeQuestion}
                  pinnedCount={hideAdded ? 0 : slotSelections.length}
                />
                {pages > 1 && (
                  <div style={PAGER}>
                    <button disabled={page === 0} onClick={() => setPage(p => p - 1)} style={BTN2}>Prev</button>
                    <span style={SMALL}>{page + 1}/{pages}</span>
                    <button disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)} style={BTN2}>Next</button>
                  </div>
                )}
              </>
            ) : (
              <div style={EMPTY}>No blueprint slots yet.</div>
            )}
          </main>
        </div>
      )}

      {stage === "review" && (
        <div style={{ ...MAIN, overflow: "auto" }}>
          <h3 style={H3}>Review Exam</h3>
          {!blueprintComplete && <div style={WARN}>The plan is not finished yet. Go back and fill every subject.</div>}
          {blueprintComplete && !allSlotsComplete && <div style={WARN}>Some question buckets are still empty. Go back and keep picking questions until each bucket is full.</div>}
          <div style={GRID}>
            {SUBJECTS.map(s => {
              const used = subjectBlueprintTotal(blueprint[s.key]);
              const selected = (selections[s.key] || []).length;
              return (
                <div key={s.key} style={CARD}>
                  <div style={{ color: s.color, fontSize: 11, fontWeight: 900, textTransform: "uppercase" }}>{s.label}</div>
                  <div style={{ color: used === s.total && selected === s.total ? "#22c55e" : "#f59e0b", fontSize: 18, fontWeight: 900 }}>{formatCount(selected)}/{formatCount(s.total)}</div>
                  {(blueprint[s.key]?.topics || []).map(topic => (
                    <div key={topic.name} style={{ color: "#94a3b8", fontSize: 12, marginTop: 8 }}>
                      {topic.name}: {topicTotal(topic)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          <button onClick={() => setShowConfirm(true)} disabled={!allSlotsComplete} style={{ ...BTN, marginTop: 18, opacity: allSlotsComplete ? 1 : 0.45 }}>Save Exam</button>
        </div>
      )}
    </div>
  );
}

function QuestionList({ busy, questions, stimulusMap, visualMap, allSelectedIds, canAddMore, onView, onAdd, subjectKey, selections, onRemove, pinnedCount = 0 }) {
  if (busy) return <div style={EMPTY}>Loading...</div>;
  if (!questions.length) return <div style={EMPTY}>No questions found.</div>;
  return (
    <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 8, paddingBottom: 12 }}>
      {pinnedCount > 0 && (
        <div style={{ fontSize: 10, fontWeight: 800, color: "#22c55e", textTransform: "uppercase", letterSpacing: 1, padding: "2px 0" }}>
          ● Selected for this slot
        </div>
      )}
      {questions.map((q, idx) => {
        const added = allSelectedIds.has(q.id);
        const isDivider = pinnedCount > 0 && idx === pinnedCount;
        const qVisuals = [...(visualMap[q.id] || []), ...questionInlineVisualAssets(q)];
        const stim = q.stimulus_id ? stimulusMap[q.stimulus_id] : null;
        return (
          <div key={q.id}>
            {isDivider && (
              <div style={{ fontSize: 10, fontWeight: 800, color: "#475569", textTransform: "uppercase", letterSpacing: 1, padding: "6px 0 2px", borderTop: "1px solid #1e293b", marginTop: 4 }}>
                All questions
              </div>
            )}
          <div style={{ ...PANEL, opacity: added ? 0.55 : 1 }}>
            {stim && (
              <div style={{ color: "#64748b", fontSize: 11, marginBottom: 8 }}>
                Passage: {stim.stimulus_title || "Untitled passage"}
              </div>
            )}
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                  <span style={{ color: DIFF_COLOR[q.difficulty_level] || "#94a3b8", fontSize: 10, fontWeight: 900 }}>{q.difficulty_level}</span>
                  {q.topic && <span style={PILL}>{q.topic}</span>}
                  {q.subtopic && <span style={PILL}>{q.subtopic}</span>}
                </div>
                <VisualAssetPreview assets={qVisuals} storageBase={STORAGE} compact />
                <div style={{ color: "#cbd5e1", fontSize: 13, lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                  <QuestionWithUnderline text={q.question_text} choiceA={q.choice_a} subject={q.subject} />
                </div>
              </div>
              <button onClick={() => onView(q)} style={BTN2}>View</button>
              {added ? (
                <button onClick={() => onRemove(subjectKey, q.id)} style={DANGER_BTN}>Remove</button>
              ) : (
                <button onClick={() => onAdd(q)} disabled={!canAddMore || selections[subjectKey]?.some(item => item.id === q.id)} style={{ ...BTN, opacity: canAddMore ? 1 : 0.45 }}>
                  Add
                </button>
              )}
            </div>
          </div>
          </div>
        );
      })}
    </div>
  );
}

function makeEditForm(q) {
  return {
    question_text: q.question_text || "",
    choice_a: q.choice_a || "",
    choice_b: q.choice_b || "",
    choice_c: q.choice_c || "",
    choice_d: q.choice_d || "",
    choice_e: q.choice_e || "",
    correct_answer: q.correct_answer || "a",
    difficulty_level: q.difficulty_level || "medium",
    status: q.status || "active",
    source_school: q.source_school || "",
    subject: q.subject || "",
    topic: q.topic || "",
    subtopic: q.subtopic || "",
    render_markup: q.render_markup || "",
    instruction_code: q._inst?.code || "",
    instruction_text: q._inst?.instruction_text || "",
    stimulus_type: q._stim?.stimulus_type || "",
    stimulus_title: q._stim?.stimulus_title || "",
    stimulus_text: q._stim?.stimulus_text || "",
  };
}

async function fetchClassOpts(token) {
  const pageSize = 1000;
  const rows = [];
  let offset = 0;
  while (true) {
    const r = await fetch(`${REST}/questions?select=subject,topic,subtopic&limit=${pageSize}&offset=${offset}`, {
      headers: { ...hdr(token), Prefer: "count=exact" },
    });
    if (!r.ok) break;
    const data = await r.json();
    rows.push(...(Array.isArray(data) ? data : []));
    offset += data.length;
    const totalRows = Number(r.headers.get("content-range")?.split("/")[1] || 0);
    if (!data.length || (totalRows && rows.length >= totalRows) || data.length < pageSize) break;
  }
  return {
    subjects: [...new Set(rows.map(q => q.subject).filter(Boolean))].sort(),
    topics: [...new Set(rows.filter(q => q.subject && q.topic).map(q => `${q.subject}|||${q.topic}`))].sort(),
    subtopics: [...new Set(rows.filter(q => q.subject && q.topic && q.subtopic).map(q => `${q.subject}|||${q.topic}|||${q.subtopic}`))].sort(),
  };
}

function QuestionModal(props) {
  const {
    viewQ, activeSlot, viewLoading, editingQ, setEditingQ, editForm, setEditForm,
    editBusy, editMsg, saveQuestionEdits, close, openAdd, openRemove, viewAdded,
    viewCanAdd, visualMap, editSubjectOptions, editTopicOptions, editSubtopicOptions,
    hideSlotActions,
  } = props;
  return (
    <Modal onClose={close} width={820}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            <span style={{ color: DIFF_COLOR[viewQ.difficulty_level] || "#94a3b8", fontSize: 10, fontWeight: 900 }}>{viewQ.difficulty_level}</span>
            {viewQ.subject && <span style={PILL}>{viewQ.subject}</span>}
            {viewQ.topic && <span style={PILL}>{viewQ.topic}</span>}
            {viewQ.subtopic && <span style={PILL}>{viewQ.subtopic}</span>}
          </div>
          <div style={{ color: "#334155", fontSize: 10, fontFamily: "monospace", wordBreak: "break-all" }}>{viewQ.id}</div>
        </div>
        <button onClick={() => setEditingQ(!editingQ)} style={BTN2}>{editingQ ? "View" : "Edit"}</button>
        <button onClick={close} style={BTN2}>Close</button>
      </div>

      {viewLoading && <div style={EMPTY}>Loading supporting context...</div>}

      {editingQ ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <EditField label="Question Text" value={editForm.question_text} multi onChange={v => setEditForm({ ...editForm, question_text: v })} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
            <EditSelect label="Difficulty" value={editForm.difficulty_level} opts={["easy", "medium", "hard"]} onChange={v => setEditForm({ ...editForm, difficulty_level: v })} />
            <EditSelect label="Status" value={editForm.status} opts={["active", "retired", "draft", "needs_human_review"]} onChange={v => setEditForm({ ...editForm, status: v })} />
            <EditSelect label="Correct" value={editForm.correct_answer} opts={["a", "b", "c", "d", "e"]} onChange={v => setEditForm({ ...editForm, correct_answer: v })} />
            <EditField label="School" value={editForm.source_school} onChange={v => setEditForm({ ...editForm, source_school: v })} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
            <EditSelect label="Subject" value={editForm.subject} opts={editSubjectOptions} onChange={v => setEditForm({ ...editForm, subject: v, topic: "", subtopic: "" })} />
            <EditSelect label="Topic" value={editForm.topic} opts={editTopicOptions} onChange={v => setEditForm({ ...editForm, topic: v, subtopic: "" })} />
            <EditSelect label="Subtopic" value={editForm.subtopic} opts={editSubtopicOptions} onChange={v => setEditForm({ ...editForm, subtopic: v })} />
          </div>
          {["a", "b", "c", "d", "e"].map(l => (
            <EditField key={l} label={`Choice ${choiceLabel(l)}${l === "e" ? " (optional)" : ""}`} value={editForm[`choice_${l}`]} onChange={v => setEditForm({ ...editForm, [`choice_${l}`]: v })} />
          ))}
          <EditField label="Render Markup" value={editForm.render_markup} multi onChange={v => setEditForm({ ...editForm, render_markup: v })} />
          {viewQ._inst && (
            <div style={PANEL}>
              <div style={LABEL}>Instruction</div>
              <EditField label="Instruction Code" value={editForm.instruction_code} onChange={v => setEditForm({ ...editForm, instruction_code: v })} />
              <EditField label="Instruction Text" value={editForm.instruction_text} multi onChange={v => setEditForm({ ...editForm, instruction_text: v })} />
            </div>
          )}
          {viewQ._stim && (
            <div style={PANEL}>
              <div style={LABEL}>Passage / Stimulus</div>
              <EditField label="Passage Type" value={editForm.stimulus_type} onChange={v => setEditForm({ ...editForm, stimulus_type: v })} />
              <EditField label="Passage Title" value={editForm.stimulus_title} onChange={v => setEditForm({ ...editForm, stimulus_title: v })} />
              <EditField label="Passage Text" value={editForm.stimulus_text} multi onChange={v => setEditForm({ ...editForm, stimulus_text: v })} />
            </div>
          )}
          <div style={ROW}>
            <button onClick={saveQuestionEdits} disabled={editBusy} style={{ ...BTN, opacity: editBusy ? 0.6 : 1 }}>{editBusy ? "Saving..." : "Save Edits to DB"}</button>
            <button onClick={() => setEditingQ(false)} disabled={editBusy} style={BTN2}>Cancel</button>
            {editMsg && <span style={{ ...MSG, color: editMsg.startsWith("Error") ? "#ef4444" : "#22c55e" }}>{editMsg}</span>}
          </div>
        </div>
      ) : (
        <>
          {viewQ._inst && <InfoBlock title="Instruction"><MathContent value={viewQ._inst.instruction_text} subject={viewQ.subject} /></InfoBlock>}
          {viewQ._stim && <InfoBlock title="Passage"><MathContent value={viewQ._stim.stimulus_text} subject={viewQ.subject} /></InfoBlock>}
          {viewQ._vis?.length > 0 && <VisualAssetPreview assets={viewQ._vis} storageBase={STORAGE} />}
          {!viewQ._vis?.length && visualMap[viewQ.id]?.length > 0 && <VisualAssetPreview assets={visualMap[viewQ.id]} storageBase={STORAGE} />}
          <VisualAssetPreview assets={questionInlineVisualAssets(viewQ)} storageBase={STORAGE} />
          <div style={{ color: "#f1f5f9", fontSize: 16, lineHeight: 1.75, margin: "14px 0", whiteSpace: "pre-wrap" }}>
            {viewQ.render_markup ? <SegMarkup markup={viewQ.render_markup} /> : <QuestionWithUnderline text={viewQ.question_text} choiceA={viewQ.choice_a} subject={viewQ.subject} />}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {["a", "b", "c", "d", "e"].map(l => {
              const txt = viewQ[`choice_${l}`];
              if (!txt) return null;
              const ok = viewQ.correct_answer === l;
              return (
                <div key={l} style={{ display: "flex", gap: 10, padding: "10px 12px", borderRadius: 8, background: ok ? "#16a34a12" : "#0a0f1a", border: ok ? "1px solid #16a34a40" : "1px solid #1a2236" }}>
                  <span style={{ width: 24, height: 24, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, background: ok ? "#16a34a" : "#1e293b", color: ok ? "#fff" : "#64748b" }}>{choiceLabel(l)}</span>
                  <span style={{ color: ok ? "#86efac" : "#cbd5e1", fontSize: 14, lineHeight: 1.5 }}><ChoiceContent value={txt} subject={viewQ.subject} /></span>
                </div>
              );
            })}
          </div>
          {editMsg && <div style={{ ...MSG, color: editMsg.startsWith("Error") ? "#ef4444" : "#22c55e" }}>{editMsg}</div>}
        </>
      )}

      {!hideSlotActions && (
        <div style={{ ...ROW, justifyContent: "space-between", marginTop: 18 }}>
          <span style={SMALL}>{viewAdded ? "Already selected" : activeSlot ? `Current slot: ${activeSlot.topic}${activeSlot.subtopic ? ` / ${activeSlot.subtopic}` : ""}` : ""}</span>
          <div style={ROW}>
            {viewAdded && <button onClick={openRemove} style={DANGER_BTN}>Remove from Exam</button>}
            {!viewAdded && <button onClick={openAdd} disabled={!viewCanAdd} style={{ ...BTN, opacity: viewCanAdd ? 1 : 0.45 }}>Add to Slot</button>}
          </div>
        </div>
      )}
    </Modal>
  );
}

function InfoBlock({ title, children }) {
  return <div style={PANEL}><div style={LABEL}>{title}</div><div style={{ color: "#cbd5e1", fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{children}</div></div>;
}

function Modal({ children, onClose, width = 640 }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", zIndex: 2000, display: "flex", justifyContent: "center", alignItems: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ width, maxWidth: "96vw", maxHeight: "90vh", overflow: "auto", background: "#0f1629", border: "1px solid #253048", borderRadius: 12, padding: "24px 28px", boxShadow: "0 24px 80px rgba(0,0,0,0.45)" }}>
        {children}
      </div>
    </div>
  );
}

function ComboInput({ value, options, placeholder, onChange }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <input value={value || ""} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={{ ...INPUT, flex: 1 }} list={`${placeholder}-${options.length}`} />
      <datalist id={`${placeholder}-${options.length}`}>
        {options.map(option => <option key={option} value={option} />)}
      </datalist>
    </div>
  );
}

function NumberInput({ value, onChange, max }) {
  const stepBtn = { background: "#1e293b", border: "1px solid #253048", color: "#cbd5e1", borderRadius: 6, width: 32, height: 34, cursor: "pointer", fontSize: 18, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, flexShrink: 0 };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <button type="button" onClick={() => onChange(Math.max(0, (value ?? 0) - 1))} style={stepBtn}>−</button>
      <input
        type="number" min="0" max={max ?? undefined} value={value ?? 0}
        onChange={e => onChange(Math.max(0, Number(e.target.value) || 0))}
        style={{ ...INPUT, width: 60, textAlign: "center" }}
      />
      <button type="button" onClick={() => { const next = max !== undefined ? Math.min(max, (value ?? 0) + 1) : (value ?? 0) + 1; if (next > (value ?? 0)) onChange(next); }} style={stepBtn}>+</button>
    </div>
  );
}

function EditField({ label, value, onChange, multi }) {
  return (
    <div>
      <label style={LABEL}>{label}</label>
      {multi
        ? <textarea rows={4} value={value || ""} onChange={e => onChange(e.target.value)} style={{ ...INPUT, width: "100%", resize: "vertical" }} />
        : <input value={value || ""} onChange={e => onChange(e.target.value)} style={{ ...INPUT, width: "100%" }} />}
    </div>
  );
}

function EditSelect({ label, value, opts, onChange }) {
  const options = [...new Set([value, ...opts].filter(v => v !== undefined && v !== null))];
  return (
    <div>
      <label style={LABEL}>{label}</label>
      <select value={value || ""} onChange={e => onChange(e.target.value)} style={{ ...SELECT, width: "100%", maxWidth: "none" }}>
        {options.map(option => <option key={option || "none"} value={option || ""}>{option || "None"}</option>)}
      </select>
    </div>
  );
}

export default function ExamManager({ session }) {
  const [view, setView] = useState("list");
  const [templates, setTemplates] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [activeTemplate, setActiveTemplate] = useState(null);
  const [loadedSelections, setLoadedSelections] = useState(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [newErr, setNewErr] = useState("");
  const [previewTemplate, setPreviewTemplate] = useState(null);
  const [previewViewQ, setPreviewViewQ] = useState(null);
  const [previewEditingQ, setPreviewEditingQ] = useState(false);
  const [previewEditForm, setPreviewEditForm] = useState({});
  const [previewEditBusy, setPreviewEditBusy] = useState(false);
  const [previewEditMsg, setPreviewEditMsg] = useState("");
  const [previewViewLoading, setPreviewViewLoading] = useState(false);
  const [previewClassOpts, setPreviewClassOpts] = useState({ subjects: [], topics: [], subtopics: [] });

  const loadTemplates = useCallback(async () => {
    setLoadingList(true);
    setDrafts(readDraftIndex());
    try {
      const r = await fetch(`${REST}/diagnostic_templates?select=*&order=created_at.desc`, { headers: hdr(session.access_token) });
      const data = await r.json();
      setTemplates(Array.isArray(data) ? data.filter(t => t.code !== ARCHIVE_TEMPLATE_CODE) : []);
    } catch (e) {
      console.error("Failed to load templates", e);
    }
    setLoadingList(false);
  }, [session]);

  useEffect(() => {
    void Promise.resolve().then(loadTemplates);
  }, [loadTemplates]);

  useEffect(() => {
    if (!previewTemplate || !session) return;
    fetchClassOpts(session.access_token).then(setPreviewClassOpts).catch(() => {});
  }, [previewTemplate, session]);

  async function openQuestionForPreview(questionId) {
    const base = { id: questionId, _inst: null, _stim: null, _vis: [] };
    setPreviewViewQ(base);
    setPreviewEditingQ(false);
    setPreviewEditMsg("");
    setPreviewEditForm(makeEditForm(base));
    setPreviewViewLoading(true);
    try {
      const qr = await fetch(`${REST}/questions?id=eq.${encodeURIComponent(questionId)}&limit=1`, { headers: hdr(session.access_token) });
      const [q] = await qr.json();
      if (!q) throw new Error("Question not found");
      let inst = null, stim = null, vis = [];
      if (q.instruction_id) {
        const r = await fetch(`${REST}/instructions?id=eq.${encodeURIComponent(q.instruction_id)}&limit=1`, { headers: hdr(session.access_token) });
        inst = (await r.json())[0] || null;
      }
      if (q.stimulus_id) {
        const r = await fetch(`${REST}/stimuli?id=eq.${encodeURIComponent(q.stimulus_id)}&limit=1`, { headers: hdr(session.access_token) });
        stim = (await r.json())[0] || null;
      }
      const vr = await fetch(`${REST}/question_visual_assets?question_id=eq.${encodeURIComponent(q.id)}&select=*,visual_assets(*)`, { headers: hdr(session.access_token) });
      vis = vr.ok ? await vr.json() : [];
      const full = { ...q, _inst: inst, _stim: stim, _vis: vis };
      setPreviewViewQ(full);
      setPreviewEditForm(makeEditForm(full));
    } catch (e) {
      setPreviewEditMsg("Error: " + e.message);
    } finally {
      setPreviewViewLoading(false);
    }
  }

  async function savePreviewEdits() {
    if (!previewViewQ) return;
    setPreviewEditBusy(true);
    setPreviewEditMsg("");
    const questionBody = {
      question_text: previewEditForm.question_text,
      choice_a: previewEditForm.choice_a,
      choice_b: previewEditForm.choice_b,
      choice_c: previewEditForm.choice_c,
      choice_d: previewEditForm.choice_d,
      choice_e: previewEditForm.choice_e || null,
      correct_answer: previewEditForm.correct_answer,
      difficulty_level: previewEditForm.difficulty_level,
      status: previewEditForm.status,
      source_school: previewEditForm.source_school || null,
      subject: previewEditForm.subject,
      topic: previewEditForm.topic,
      subtopic: previewEditForm.subtopic || null,
      render_markup: previewEditForm.render_markup || null,
    };
    const mathValidation = validateMathItem(questionBody);
    if (mathValidation.checked && !mathValidation.valid) questionBody.status = "needs_human_review";
    try {
      const qr = await fetch(`${REST}/questions?id=eq.${encodeURIComponent(previewViewQ.id)}`, {
        method: "PATCH",
        headers: { ...hdr(session.access_token), Prefer: "return=representation" },
        body: JSON.stringify(questionBody),
      });
      if (!qr.ok) throw new Error("Question update failed: " + await qr.text());
      const updatedQ = (await qr.json())[0] || { ...previewViewQ, ...questionBody };

      let updatedInst = previewViewQ._inst || null;
      if (previewViewQ.instruction_id && previewViewQ._inst) {
        const ir = await fetch(`${REST}/instructions?id=eq.${encodeURIComponent(previewViewQ.instruction_id)}`, {
          method: "PATCH",
          headers: { ...hdr(session.access_token), Prefer: "return=representation" },
          body: JSON.stringify({ code: previewEditForm.instruction_code || null, instruction_text: previewEditForm.instruction_text || null }),
        });
        if (!ir.ok) throw new Error("Instruction update failed: " + await ir.text());
        updatedInst = (await ir.json())[0] || updatedInst;
      }

      let updatedStim = previewViewQ._stim || null;
      if (previewViewQ.stimulus_id && previewViewQ._stim) {
        const sr = await fetch(`${REST}/stimuli?id=eq.${encodeURIComponent(previewViewQ.stimulus_id)}`, {
          method: "PATCH",
          headers: { ...hdr(session.access_token), Prefer: "return=representation" },
          body: JSON.stringify({ stimulus_type: previewEditForm.stimulus_type || null, stimulus_title: previewEditForm.stimulus_title || null, stimulus_text: previewEditForm.stimulus_text || null }),
        });
        if (!sr.ok) throw new Error("Stimulus update failed: " + await sr.text());
        updatedStim = (await sr.json())[0] || updatedStim;
      }

      const merged = { ...previewViewQ, ...updatedQ, _inst: updatedInst, _stim: updatedStim };
      setPreviewViewQ(merged);
      setPreviewEditForm(makeEditForm(merged));
      setPreviewEditingQ(false);
      setPreviewEditMsg(mathValidation.checked && !mathValidation.valid ? `Saved; flagged needs_human_review. ${mathValidation.reason}` : "Saved to database.");
    } catch (e) {
      setPreviewEditMsg("Error: " + e.message);
    } finally {
      setPreviewEditBusy(false);
    }
  }

  async function openEditExam(t) {
    let loaded = emptySelections();
    try {
      const r = await fetch(`${REST}/diagnostic_template_questions?template_id=eq.${t.id}&select=section_name,display_order,questions(*)&order=display_order.asc`, {
        headers: hdr(session.access_token),
      });
      const rows = await r.json();
      (Array.isArray(rows) ? rows : []).forEach(row => {
        if (!row.questions) return;
        const subject = SUBJECTS.find(s => s.section_name === row.section_name && (s.subjects || []).includes(row.questions.subject))
          || SUBJECTS.find(s => s.section_name === row.section_name);
        if (subject) loaded[subject.key].push(row.questions);
      });
    } catch (e) {
      console.error("Could not load template questions", e);
    }
    setLoadedSelections(loaded);
    setActiveTemplate({ id: t.id, code: t.code, label: t.code });
    setView("editor");
  }

  function openDraft(draft) {
    setLoadedSelections(null);
    setActiveTemplate({ id: null, code: draft.code, label: draft.label, draftCode: draft.code });
    setView("editor");
  }

  function openNewExam() {
    const name = newName.trim();
    if (!name) {
      setNewErr("Enter a name.");
      return;
    }
    const code = slugCode(name);
    const meta = upsertDraftMeta({ code, label: `${name} Draft`, selected: 0, total: totalTarget(), blueprintComplete: false });
    localStorage.setItem(getDraftKey(code), JSON.stringify(normalizeDraftPayload({ stage: "welcome", blueprint: createBlueprint(), selections: emptySelections() })));
    setDrafts(readDraftIndex());
    setLoadedSelections(null);
    setActiveTemplate({ id: null, code, label: meta.label, draftCode: code });
    setShowNewModal(false);
    setNewName("");
    setNewErr("");
    setView("editor");
  }

  function onSaveComplete() {
    setView("list");
    setActiveTemplate(null);
    setLoadedSelections(null);
    loadTemplates();
  }

  async function setPrimaryTemplate(t) {
    const h = { ...hdr(session.access_token), Prefer: "return=minimal" };
    try {
      // Clear is_primary on all active templates, then set it on this one.
      const clearRes = await fetch(`${REST}/diagnostic_templates?is_active=eq.true`, {
        method: "PATCH",
        headers: h,
        body: JSON.stringify({ is_primary: false }),
      });
      if (!clearRes.ok) throw new Error(await clearRes.text() || "Could not clear existing primary.");
      const setRes = await fetch(`${REST}/diagnostic_templates?id=eq.${encodeURIComponent(t.id)}`, {
        method: "PATCH",
        headers: h,
        body: JSON.stringify({ is_primary: true }),
      });
      if (!setRes.ok) throw new Error(await setRes.text() || "Could not set primary template.");
      loadTemplates();
    } catch (e) {
      alert(`Failed to set active exam: ${e.message}`);
    }
  }

  async function deleteTemplate(t) {
    if (!window.confirm(`Delete "${t.code}"? This removes it from the live exam pool and cannot be undone.`)) return;
    const adminH = { ...hdr(session.access_token), Prefer: "return=minimal" };
    if (t.code === ARCHIVE_TEMPLATE_CODE) {
      alert("The internal deleted-session archive cannot be deleted.");
      return;
    }

    const ensureArchiveTemplate = async () => {
      const existingRes = await fetch(`${REST}/diagnostic_templates?code=eq.${encodeURIComponent(ARCHIVE_TEMPLATE_CODE)}&select=id&limit=1`, {
        headers: hdr(session.access_token),
      });
      if (!existingRes.ok) throw new Error(await existingRes.text() || "Could not inspect archive template.");
      const existing = await existingRes.json();
      if (Array.isArray(existing) && existing[0]?.id) return existing[0].id;

      const createRes = await fetch(`${REST}/diagnostic_templates`, {
        method: "POST",
        headers: { ...hdr(session.access_token), Prefer: "return=representation" },
        body: JSON.stringify({
          code: ARCHIVE_TEMPLATE_CODE,
          version: 1,
          total_questions: 0,
          is_active: false,
        }),
      });
      if (!createRes.ok) throw new Error(await createRes.text() || "Could not create archive template.");
      const created = await createRes.json();
      return Array.isArray(created) ? created[0]?.id : created?.id;
    };

    let archiveTemplateId = null;
    try {
      archiveTemplateId = await ensureArchiveTemplate();
    } catch (error) {
      alert(`Delete failed while preparing session archive: ${error.message}`);
      return;
    }
    if (!archiveTemplateId) {
      alert("Delete failed: could not resolve the deleted-session archive template.");
      return;
    }

    const moveSessionsForToken = async (token) => {
      const actorH = { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=minimal" };
      const sessRes = await fetch(`${REST}/diagnostic_sessions?select=id&template_id=eq.${encodeURIComponent(t.id)}`, { headers: actorH });
      if (!sessRes.ok) throw new Error(await sessRes.text() || "Could not inspect diagnostic sessions.");
      const sessions = await sessRes.json();
      if (!Array.isArray(sessions) || !sessions.length) return;

      const idList = sessions.map(s => encodeURIComponent(s.id)).join(",");
      const res = await fetch(`${REST}/diagnostic_sessions?id=in.(${idList})`, {
        method: "PATCH",
        headers: actorH,
        body: JSON.stringify({ template_id: archiveTemplateId }),
      });
      if (!res.ok) throw new Error(`Could not detach diagnostic sessions: ${await res.text() || res.status}`);
    };

    try {
      await moveSessionsForToken(session.access_token);
    } catch (error) {
      alert(`Delete failed while cleaning admin sessions: ${error.message}`);
      return;
    }


    // Only relevant when a preview account is configured — it exists to reparent
    // sessions that account created. With no credentials there is nothing to move.
    if (PREVIEW_CREDENTIALS_SET) {
      try {
        const lr = await fetch(`${URL_BASE?.replace(/\/$/, "")}/auth/v1/token?grant_type=password`, {
          method: "POST",
          headers: { apikey: KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ email: PREVIEW_STUDENT_EMAIL, password: PREVIEW_STUDENT_PASSWORD }),
        });
        if (lr.ok) {
          const { access_token: stuToken } = await lr.json();
          await moveSessionsForToken(stuToken);
        }
      } catch (error) {
        alert(`Delete failed while cleaning preview student sessions: ${error.message}`);
        return;
      }
    }

    await fetch(`${REST}/diagnostic_template_questions?template_id=eq.${encodeURIComponent(t.id)}`, { method: "DELETE", headers: adminH });
    const delRes = await fetch(`${REST}/diagnostic_templates?id=eq.${encodeURIComponent(t.id)}`, { method: "DELETE", headers: adminH });
    if (!delRes.ok) {
      const msg = await delRes.text();
      alert(`Delete failed: ${msg || delRes.status}`);
      return;
    }
    loadTemplates();
  }

  if (view === "editor" && activeTemplate) {
    return (
      <ExamBuilderEditor
        session={session}
        templateCode={activeTemplate.code}
        templateLabel={activeTemplate.label}
        templateId={activeTemplate.id}
        draftCode={activeTemplate.draftCode}
        initialSelections={loadedSelections}
        onBack={() => { setView("list"); setActiveTemplate(null); setLoadedSelections(null); setDrafts(readDraftIndex()); }}
        onSaveComplete={onSaveComplete}
      />
    );
  }

  if (previewTemplate) {
    const prevEditSubjectOpts = [...new Set([...previewClassOpts.subjects, ...SUBJECTS.flatMap(s => s.subjects), previewEditForm.subject].filter(Boolean))].sort();
    const prevEditTopicOpts = [...new Set([...previewClassOpts.topics.map(t => t.split("|||")).filter(p => !previewEditForm.subject || p[0] === previewEditForm.subject).map(p => p[1]).filter(Boolean), previewEditForm.topic].filter(Boolean))].sort();
    const prevEditSubtopicOpts = [...new Set([...previewClassOpts.subtopics.map(s => s.split("|||")).filter(p => (!previewEditForm.subject || p[0] === previewEditForm.subject) && (!previewEditForm.topic || p[1] === previewEditForm.topic)).map(p => p[2]).filter(Boolean), previewEditForm.subtopic].filter(Boolean))].sort();
    return (
      <>
        <StudentExamPreview
          adminSession={session}
          template={previewTemplate}
          onClose={() => setPreviewTemplate(null)}
          onEditQuestion={openQuestionForPreview}
        />
        {previewViewQ && (
          <QuestionModal
            viewQ={previewViewQ}
            activeSlot={null}
            viewLoading={previewViewLoading}
            editingQ={previewEditingQ}
            setEditingQ={setPreviewEditingQ}
            editForm={previewEditForm}
            setEditForm={setPreviewEditForm}
            editBusy={previewEditBusy}
            editMsg={previewEditMsg}
            saveQuestionEdits={savePreviewEdits}
            close={() => { setPreviewViewQ(null); setPreviewEditMsg(""); setPreviewEditingQ(false); }}
            openAdd={() => {}}
            openRemove={() => {}}
            viewAdded={false}
            viewCanAdd={false}
            visualMap={{}}
            editSubjectOptions={prevEditSubjectOpts}
            editTopicOptions={prevEditTopicOpts}
            editSubtopicOptions={prevEditSubtopicOpts}
            hideSlotActions
          />
        )}
      </>
    );
  }

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "28px 32px", background: "#090e18", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      {showNewModal && (
        <Modal onClose={() => setShowNewModal(false)} width={400}>
          <h3 style={H3}>New Exam</h3>
          <p style={P}>Choose a name. A local draft will appear in the exam list immediately.</p>
          <input autoFocus value={newName} onChange={e => { setNewName(e.target.value); setNewErr(""); }} onKeyDown={e => { if (e.key === "Enter") openNewExam(); }} placeholder="e.g. Mock Exam 2" style={{ ...INPUT, width: "100%", marginBottom: 8 }} />
          {newErr && <div style={{ ...MSG, color: "#ef4444" }}>{newErr}</div>}
          <div style={ROW}>
            <button onClick={openNewExam} style={BTN}>Create Draft</button>
            <button onClick={() => setShowNewModal(false)} style={BTN2}>Cancel</button>
          </div>
        </Modal>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h2 style={{ color: "#f1f5f9", fontSize: 18, fontWeight: 800, margin: 0 }}>Exam Templates</h2>
          <p style={{ color: "#475569", fontSize: 12, margin: "4px 0 0" }}>Build saved exams and resume local drafts.</p>
        </div>
        <button onClick={() => { setShowNewModal(true); setNewName(""); setNewErr(""); }} style={BTN}>New Exam</button>
      </div>

      {loadingList ? (
        <div style={EMPTY}>Loading exams...</div>
      ) : (
        <div style={GRID}>
          {drafts.map(draft => (
            <div key={draft.code} style={{ ...CARD, borderColor: "#f59e0b55" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8, alignItems: "flex-start" }}>
                <div style={{ color: "#f1f5f9", fontSize: 14, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }} title={draft.label}>{draft.label}</div>
                <span style={{ ...PILL, color: "#f59e0b", flexShrink: 0 }}>DRAFT</span>
              </div>
              <div style={{ color: "#64748b", fontSize: 12, marginBottom: 14 }}>
                {draft.selected || 0} / {draft.total || totalTarget()} selected
                {!draft.blueprintComplete && <span style={{ color: "#f59e0b", marginLeft: 8 }}>blueprint incomplete</span>}
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <button onClick={() => openDraft(draft)} style={BTN}>Resume Draft</button>
              </div>
              <button onClick={() => { if (window.confirm(`Delete ${draft.label}?`)) { removeDraft(draft.code); setDrafts(readDraftIndex()); } }} style={{ ...DANGER_BTN, width: "100%" }}>Delete</button>
            </div>
          ))}
          {templates.map(t => {
            const pillLabel = !t.is_active ? "INACTIVE" : t.is_primary ? "ACTIVE" : "AVAILABLE";
            const pillColor = !t.is_active ? "#64748b" : t.is_primary ? "#22c55e" : "#3b82f6";
            return (
              <div key={t.id} style={{ ...CARD, borderColor: t.is_primary ? "#22c55e33" : "#1a2236" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8, alignItems: "flex-start" }}>
                  <div style={{ color: "#f1f5f9", fontSize: 14, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }} title={t.code}>{t.code}</div>
                  <span style={{ ...PILL, color: pillColor, flexShrink: 0 }}>{pillLabel}</span>
                </div>
                <div style={{ color: "#64748b", fontSize: 12, marginBottom: 14 }}>{t.total_questions ?? "?"} questions</div>
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <button
                    onClick={() => setPreviewTemplate(t)}
                    disabled={!PREVIEW_CREDENTIALS_SET}
                    title={PREVIEW_CREDENTIALS_SET ? "" : "Set VITE_PREVIEW_STUDENT_EMAIL and VITE_PREVIEW_STUDENT_PASSWORD in .env to enable preview."}
                    style={{ ...BTN2, borderColor: "#0f766e", color: "#99f6e4", opacity: PREVIEW_CREDENTIALS_SET ? 1 : 0.45 }}
                  >Preview Exam</button>
                  <button onClick={() => openEditExam(t)} style={BTN2}>Edit</button>
                </div>
                {t.is_active && !t.is_primary && (
                  <button onClick={() => setPrimaryTemplate(t)} style={{ ...BTN2, width: "100%", marginBottom: 8, borderColor: "#22c55e55", color: "#22c55e" }}>Set as Active</button>
                )}
                <button onClick={() => deleteTemplate(t)} style={{ ...DANGER_BTN, width: "100%" }}>Delete</button>
              </div>
            );
          })}
          {!drafts.length && !templates.length && <div style={EMPTY}>No exam templates yet. Create one to get started.</div>}
        </div>
      )}
    </div>
  );
}

const PAGE = { display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", fontFamily: "'DM Sans',system-ui,sans-serif", color: "#e2e8f0", background: "#090e18" };
const TOPBAR = { background: "#0b1120", borderBottom: "1px solid #1a2236", padding: "10px 20px", display: "flex", alignItems: "center", gap: 14, flexShrink: 0 };
const STEPS = { background: "#0f1629", borderBottom: "1px solid #1a2236", padding: "8px 20px", display: "flex", gap: 8, flexShrink: 0 };
const STEPBTN = { padding: "6px 10px", background: "#090e18", border: "1px solid #1a2236", borderRadius: 7, fontSize: 11, fontWeight: 800, cursor: "pointer" };
const WELCOME = { padding: 32, overflow: "auto", minHeight: "100%", display: "flex", alignItems: "center" };
const WELCOME_INNER = { width: "100%", maxWidth: 1120, margin: "0 auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 18 };
const WELCOME_COPY = { width: "100%", textAlign: "center" };
const WELCOME_GRID = { width: "100%", display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 14, maxWidth: 980 };
const WELCOME_ACTION = { display: "flex", justifyContent: "center", marginTop: 2 };
const WORKSPACE = { flex: 1, minHeight: 0, display: "flex", overflow: "auto", justifyContent: "center", padding: 16 };
const WORKSPACE_BODY = { width: "100%", maxWidth: 1240, display: "flex", gap: 16, minHeight: 0 };
const SIDEBAR = { width: 250, borderRight: "1px solid #1a2236", padding: 14, overflow: "auto", background: "#0b1120", flexShrink: 0 };
const MAIN = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", padding: 18, overflow: "auto" };
const SECTION_HEAD = { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", marginBottom: 14 };
const BLUEPRINT_HEAD = { display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 14, maxWidth: 860, width: "100%", marginLeft: "auto", marginRight: "auto" };
const STATUS_PILL = { padding: "8px 12px", borderRadius: 999, background: "#111827", border: "1px solid #253048", color: "#cbd5e1", fontSize: 12, fontWeight: 800, lineHeight: 1.4, maxWidth: 320 };
const IMPORT_PANEL = { maxWidth: 860, width: "100%", margin: "0 auto 14px", background: "#0f1629", border: "1px solid #1a2236", borderRadius: 10, padding: 12 };
const IMPORT_HEADER = { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" };
const TOPIC_CARD = { background: "#0f1629", border: "1px solid #1a2236", borderRadius: 10, padding: 14 };
const TOPIC_COUNT_PILL = { padding: "8px 10px", borderRadius: 999, background: "#111827", border: "1px solid #253048", color: "#cbd5e1", fontSize: 12, fontWeight: 800 };
const GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 14 };
const CARD = { background: "#0f1629", border: "1px solid #1a2236", borderRadius: 8, padding: "16px 18px" };
const PANEL = { background: "#0f1629", border: "1px solid #1a2236", borderRadius: 8, padding: 12 };
const FILTERBAR = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12, padding: 10, background: "#0b1120", border: "1px solid #1a2236", borderRadius: 8 };
const PAGER = { display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end", paddingTop: 10, borderTop: "1px solid #1a2236" };
const ROW = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };
const H3 = { margin: "0 0 10px", color: "#f1f5f9", fontSize: 17, fontWeight: 900 };
const P = { color: "#94a3b8", fontSize: 13, lineHeight: 1.7, margin: "0 0 16px" };
const EMPTY = { color: "#475569", fontSize: 13, padding: "32px 0", textAlign: "center" };
const WARN = { color: "#f59e0b", background: "#f59e0b12", border: "1px solid #f59e0b33", borderRadius: 8, padding: 12, fontSize: 12, marginBottom: 12 };
const LABEL = { display: "block", color: "#64748b", fontSize: 10, fontWeight: 900, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 };
const SMALL = { color: "#64748b", fontSize: 12 };
const MSG = { fontSize: 12, marginTop: 8 };
const INPUT = { boxSizing: "border-box", padding: "8px 10px", background: "#090e18", border: "1px solid #334155", borderRadius: 7, color: "#e2e8f0", fontSize: 12, outline: "none", fontFamily: "inherit" };
const SELECT = { padding: "8px 10px", background: "#090e18", border: "1px solid #334155", borderRadius: 7, color: "#e2e8f0", fontSize: 12, outline: "none", maxWidth: 230 };
const BTN = { padding: "8px 13px", background: "#f59e0b", border: "none", borderRadius: 7, color: "#090e18", fontSize: 12, fontWeight: 900, cursor: "pointer" };
const BTN2 = { padding: "6px 10px", background: "transparent", border: "1px solid #334155", borderRadius: 7, color: "#94a3b8", fontSize: 12, fontWeight: 800, cursor: "pointer" };
const DANGER_BTN = { padding: "6px 10px", background: "#450a0a", border: "1px solid #7f1d1d", borderRadius: 7, color: "#fecaca", fontSize: 12, fontWeight: 800, cursor: "pointer" };
const PILL = { color: "#94a3b8", background: "#1a2236", borderRadius: 4, padding: "2px 6px", fontSize: 10, fontWeight: 800 };
const SUBJECT_BTN = { width: "100%", display: "flex", justifyContent: "space-between", gap: 10, background: "#0f1629", border: "1px solid #1a2236", borderRadius: 8, padding: "8px 10px", marginBottom: 8, cursor: "pointer", textAlign: "left" };
const SLOT_BTN = { width: "100%", display: "flex", flexDirection: "column", gap: 4, background: "#0f1629", border: "1px solid #1a2236", borderRadius: 8, padding: "8px 10px", marginBottom: 8, cursor: "pointer", textAlign: "left" };
