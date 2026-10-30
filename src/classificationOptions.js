export const WEIGHTING_TABLE_CANDIDATES = [
  "subtopic_classificationimportance",
  "subtopic_classification_importance",
  "subtopic_classficationimportance",
  "subtopic_classfication_importance",
  "mock_exam_1_weightings", "mock_exam_weightings", "exam_weightings",
  "mock_exam_1_distribution", "mock_exam_distributions", "exam_distributions",
  "blueprint_subtopic_weights", "blueprint_topic_weights",
  "template_subtopic_weights", "template_topic_weights",
  "diagnostic_subtopic_weights", "diagnostic_topic_weights",
];

export function getRowSubject(row) {
  return row.subject || row.subject_name || row.section_subject || row.classification || row.classification_name;
}

export function getRowTopic(row) {
  return row.topic || row.topic_name || row.topic_classification || row.main_topic;
}

export function getRowSubtopic(row) {
  return row.subtopic || row.subtopic_name || row.sub_topic || row.subtopic_classification || row.classification_subtopic;
}

export function optionsFromWeightRows(rows) {
  const subjects = [];
  const topics = [];
  const subtopics = [];
  rows.forEach(row => {
    const subject = getRowSubject(row);
    const topic = getRowTopic(row);
    const subtopic = getRowSubtopic(row);
    if (subject) subjects.push(subject);
    if (subject && topic) topics.push(`${subject}|||${topic}`);
    if (subject && topic && subtopic) subtopics.push(`${subject}|||${topic}|||${subtopic}`);
    else if (subject && subtopic) subtopics.push(`${subject}||||||${subtopic}`);
  });
  return {
    subjects: [...new Set(subjects)].sort(),
    topics: [...new Set(topics)].sort(),
    subtopics: [...new Set(subtopics)].sort(),
  };
}

async function fetchAllRows(rest, table, headers) {
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  while (true) {
    const r = await fetch(`${rest}/${table}?select=*&limit=${PAGE}&offset=${offset}`, { headers });
    if (!r.ok) throw new Error(`${r.status}`);
    const page = await r.json();
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

export async function loadClassificationOptions(rest, headers) {
  for (const table of WEIGHTING_TABLE_CANDIDATES) {
    try {
      const rows = await fetchAllRows(rest, table, headers);
      const parsed = optionsFromWeightRows(rows);
      if (parsed.subjects.length || parsed.topics.length || parsed.subtopics.length) {
        return { ...parsed, source: table };
      }
    } catch {
      // Try the next likely weighting table name.
    }
  }
  return { subjects: [], topics: [], subtopics: [], source: "" };
}
