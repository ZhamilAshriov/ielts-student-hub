import { store } from "./store.js";
import { ASSIGNMENTS } from "./assignments-data.js";

export const MISTAKE_LABELS = {
  MCQ: "Reading: Multiple Choice",
  TFNG: "True / False / Not Given",
  YNNG: "Yes / No / Not Given",
  MATCHING_HEADINGS: "Matching Headings",
  MATCHING_INFO: "Matching Information",
  MATCHING_FEATURES: "Matching Features",
  MATCHING_SENTENCE_ENDINGS: "Matching Sentence Endings",
  SENTENCE_COMPLETION: "Reading: Sentence Completion",
  SUMMARY_COMPLETION: "Summary Completion",
  NOTE_COMPLETION: "Note Completion",
  TABLE_COMPLETION: "Table Completion",
  FLOW_CHART_COMPLETION: "Flow-chart Completion",
  DIAGRAM_LABELLING: "Diagram Labelling",
  SHORT_ANSWER: "Reading: Short-Answer Questions",
  L_MCQ: "Listening: Multiple Choice",
  MATCHING: "Listening: Matching",
  MAP_DIAGRAM: "Listening: Plan, Map, or Diagram",
  FORM_NOTE_TABLE_SUMMARY: "Listening: Form / Note / Table / Summary",
  L_SENTENCE_COMPLETION: "Listening: Sentence Completion",
  L_SHORT_ANSWER: "Listening: Short-Answer Questions",
  W_ARTICLES: "Writing: Articles & Determiners",
  W_TENSE: "Writing: Verb Tense Consistency",
  W_SVA: "Writing: Subject-Verb Agreement",
  W_PREPOSITIONS: "Writing: Prepositions",
  W_WORD_CHOICE: "Writing: Word Choice & Collocation",
  W_SENTENCE_STRUCTURE: "Writing: Run-ons & Fragments",
  W_TASK_RESPONSE: "Writing: Task Response / Coherence",
  S_FLUENCY_HESITATION: "Speaking: Hesitation & Fillers",
  S_GRAMMAR_TENSE: "Speaking: Grammar & Tense Control",
  S_LEXICAL_RANGE: "Speaking: Limited Vocabulary Range",
  S_PRONUNCIATION: "Speaking: Pronunciation & Stress"
};

export function rawToIeltsBand(raw, total = 40) {
  const scaled = Math.round((raw / total) * 40);
  if (scaled >= 39) return 9.0;
  if (scaled >= 37) return 8.5;
  if (scaled >= 35) return 8.0;
  if (scaled >= 33) return 7.5;
  if (scaled >= 30) return 7.0;
  if (scaled >= 27) return 6.5;
  if (scaled >= 23) return 6.0;
  if (scaled >= 19) return 5.5;
  if (scaled >= 15) return 5.0;
  if (scaled >= 13) return 4.5;
  return 4.0;
}

export function calcOverallIelts(l, r, w, s) {
  const avg = (Number(l) + Number(r) + Number(w) + Number(s)) / 4;
  return Math.round(avg * 2) / 2;
}

export function buildScoreChart(canvasId, submissions, mocks, existingChart) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === "undefined") return existingChart;
  if (existingChart) existingChart.destroy();

  const events = [];
  mocks.forEach((m) => {
    const shortMock = (m.mockTitle || "Mock")
      .replace(/\s*20\d{2}\s*/g, " ")
      .replace(/Mock Exam/i, "Mock")
      .trim();
    events.push({
      sortKey: m.date || "2026-01-01",
      label: shortMock,
      listening: m.listening,
      reading: m.reading,
      writing: m.writing,
      speaking: m.speaking,
      overall: m.overall
    });
  });

  const skillCounters = { listening: 0, reading: 0, writing: 0, speaking: 0 };
  const sortedSubs = [...submissions].sort((a, b) => {
    const tA = a.submittedAt?.toMillis ? a.submittedAt.toMillis() : 0;
    const tB = b.submittedAt?.toMillis ? b.submittedAt.toMillis() : 0;
    return tA - tB;
  });

  sortedSubs.forEach((sub) => {
    const hw =
      ASSIGNMENTS.find((a) => a.id === sub.assignmentId) ||
      store.cachedTeacherHw.find((a) => a.id === sub.assignmentId) ||
      store.cachedTeacherPunishments.find((p) => p.id === sub.assignmentId);
    if (!sub.bandScore || sub.isDrill || (hw && hw.isDrill)) return;
    if ((sub.skill === "reading" || sub.skill === "listening") && Number(sub.totalQuestions) % 40 !== 0) return;

    const dateObj = sub.submittedAt?.toDate
      ? sub.submittedAt.toDate()
      : hw?.dueDate
        ? new Date(hw.dueDate)
        : new Date("2026-11-15");
    const dateStr = dateObj.toISOString().split("T")[0];
    const shortDate = dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const capSkill = sub.skill.charAt(0).toUpperCase() + sub.skill.slice(1);

    const bandsToPlot =
      Array.isArray(sub.setBands) && sub.setBands.length > 0
        ? sub.setBands
        : Array.isArray(sub.setScores) && sub.setScores.length > 0
          ? sub.setScores.map((sc) => rawToIeltsBand(sc, 40))
          : [sub.bandScore];

    bandsToPlot.forEach((bandVal) => {
      skillCounters[sub.skill] = (skillCounters[sub.skill] || 0) + 1;
      events.push({
        sortKey: dateStr,
        label: `${capSkill} #${skillCounters[sub.skill]} (${shortDate})`,
        listening: sub.skill === "listening" ? bandVal : null,
        reading: sub.skill === "reading" ? bandVal : null,
        writing: sub.skill === "writing" ? bandVal : null,
        speaking: sub.skill === "speaking" ? bandVal : null,
        overall: null
      });
    });
  });

  events.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const labels = events.length > 0 ? events.map((e) => e.label) : ["No Scores Yet"];

  return new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Overall (Mock)", data: events.map((e) => e.overall), borderColor: "#0f172a", backgroundColor: "#0f172a", borderWidth: 3, spanGaps: true, tension: 0.25 },
        { label: "Listening", data: events.map((e) => e.listening), borderColor: "#1d4ed8", backgroundColor: "#1d4ed8", spanGaps: true, tension: 0.25 },
        { label: "Reading", data: events.map((e) => e.reading), borderColor: "#16a34a", backgroundColor: "#16a34a", spanGaps: true, tension: 0.25 },
        { label: "Writing", data: events.map((e) => e.writing), borderColor: "#d97706", backgroundColor: "#d97706", spanGaps: true, tension: 0.25 },
        { label: "Speaking", data: events.map((e) => e.speaking), borderColor: "#dc2626", backgroundColor: "#dc2626", spanGaps: true, tension: 0.25 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          ticks: { maxRotation: 0, minRotation: 0, autoSkip: true, font: { size: 11 } },
          grid: { display: false }
        },
        y: { min: 4.0, max: 9.0, ticks: { stepSize: 0.5 } }
      },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } } }
    }
  });
}

export function buildGroupCompareChart(canvasId, myMocks, groupMocks, existingChart) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === "undefined") return existingChart;
  if (existingChart) existingChart.destroy();

  const latestByStudent = {};
  groupMocks.forEach((m) => {
    const prev = latestByStudent[m.studentId];
    if (!prev || (m.date || "") >= (prev.date || "")) latestByStudent[m.studentId] = m;
  });

  const latestList = Object.values(latestByStudent);
  const myLatest = myMocks.length > 0 ? myMocks[myMocks.length - 1] : null;

  const avgSkill = (key) => {
    if (latestList.length === 0) return 0;
    const sum = latestList.reduce((acc, m) => acc + (Number(m[key]) || 0), 0);
    return Number((sum / latestList.length).toFixed(1));
  };
  const maxSkill = (key) => {
    if (latestList.length === 0) return 0;
    return Math.max(...latestList.map((m) => Number(m[key]) || 0));
  };
  const skills = ["listening", "reading", "writing", "speaking", "overall"];

  return new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["Listening", "Reading", "Writing", "Speaking", "Overall"],
      datasets: [
        { label: "You (Latest Mock)", data: skills.map((k) => (myLatest ? Number(myLatest[k]) : 0)), backgroundColor: "#1d4ed8", borderRadius: 6 },
        { label: "Group Average", data: skills.map((k) => avgSkill(k)), backgroundColor: "#94a3b8", borderRadius: 6 },
        { label: "Group Highest", data: skills.map((k) => maxSkill(k)), backgroundColor: "#16a34a", borderRadius: 6 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { min: 4.0, max: 9.0, ticks: { stepSize: 0.5 } } },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } } }
    }
  });
}

export function renderMistakeBars(containerId, mistakesObj, emptyText, barColor = "var(--danger)") {
  const container = document.getElementById(containerId);
  if (!container) return;

  const entries = Object.entries(mistakesObj || {})
    .map(([type, val]) => ({ type, wrong: typeof val === "number" ? val : val.wrong || 0 }))
    .filter((item) => item.wrong > 0)
    .sort((a, b) => b.wrong - a.wrong);

  if (entries.length === 0) {
    container.innerHTML = `<p class="muted">${emptyText}</p>`;
    return;
  }
  const maxWrong = Math.max(...entries.map((e) => e.wrong), 1);
  container.innerHTML = entries
    .map((item) => {
      const pct = Math.round((item.wrong / maxWrong) * 100);
      return `
      <div class="type-bar-row">
        <div class="type-bar-head">
          <span>${MISTAKE_LABELS[item.type] || item.type}</span>
          <span style="color:${barColor};">${item.wrong} mistake${item.wrong > 1 ? "s" : ""}</span>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%;background:${barColor};"></div></div>
      </div>
    `;
    })
    .join("");
}
