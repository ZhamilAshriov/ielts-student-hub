import {
  doc,
  setDoc,
  getDoc,
  collection,
  getDocs,
  query,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase.js";
import { store } from "./store.js";
import {
  escapeHtml,
  notify,
  withLoading,
  getTodayStr,
  formatDueDate,
  parseLocalDeadline,
  isPastDeadline
} from "./utils.js";
import {
  uploadImagesToCloudinary,
  uploadAudioClipsToCloudinary,
  submitTaskSubmission
} from "./submissions.js";
import {
  initAnkiEngine,
  resetAnkiSession,
  getAllDueCountAcrossAllDecks
} from "./anki.js";
import {
  getRecordedClips,
  resetRecordedClips,
  stopActiveRecordingCleanup,
  startBrowserRecording,
  stopBrowserRecording
} from "./recorder.js";
import {
  MISTAKE_LABELS,
  rawToIeltsBand,
  buildScoreChart,
  buildGroupCompareChart,
  renderMistakeBars
} from "./charts.js";
import {
  sortAnnouncementsList,
  renderStudentAnnouncements,
  checkAndShowNewAnnouncementModal,
  toggleAnnouncementReaction
} from "./announcements.js";
import { ASSIGNMENTS } from "./assignments-data.js";
import { RESOURCES } from "./resources-data.js";

let studentChartInstance = null;
let groupCompareChartInstance = null;
let hwViewFilter = "todo";
let studentListenersBound = false;
let statsDataLoaded = false;

export async function initStudentModule() {
  if (!studentListenersBound) {
    bindStudentStaticListeners();
    bindStudentDelegatedClicks();
    studentListenersBound = true;
  }
  await handleUrlCheckInToken();
  await initStudentData();
}

function bindStudentStaticListeners() {
  initAnkiEngine({ onDashboardSync: updateDashboardUI });

  document.getElementById("dash-start-anki-btn")?.addEventListener("click", () => {
    document.querySelector('[data-target="student-anki"]')?.click();
  });
  document.getElementById("dash-go-hw-btn")?.addEventListener("click", () => {
    document.querySelector('[data-target="student-homework"]')?.click();
  });
  document.getElementById("dash-go-stats-btn")?.addEventListener("click", () => {
    document.querySelector('[data-target="student-stats"]')?.click();
  });

  document.getElementById("back-to-hw-btn")?.addEventListener("click", showHomeworkListView);
  document.getElementById("back-from-analysis-btn")?.addEventListener("click", showHomeworkListView);
  document.getElementById("back-to-hw-custom-btn")?.addEventListener("click", () => {
    stopActiveRecordingCleanup();
    document.getElementById("hw-custom-runner-view")?.classList.add("hidden");
    showHomeworkListView();
  });

  document.getElementById("back-to-punishments-btn")?.addEventListener("click", () => {
    stopActiveRecordingCleanup();
    document.getElementById("punishment-runner-view")?.classList.add("hidden");
    document.getElementById("student-punishments-container")?.classList.remove("hidden");
    renderStudentPunishmentsList();
    updateDashboardUI();
  });

  document.querySelectorAll(".res-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".res-filter-btn").forEach((b) => {
        b.classList.remove("btn-primary");
        b.classList.add("btn-outline");
      });
      btn.classList.remove("btn-outline");
      btn.classList.add("btn-primary");
      renderResourcesList(btn.dataset.cat);
    });
  });
}

function bindStudentDelegatedClicks() {
  document.getElementById("app-shell")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || store.role !== "student") return;
    const action = btn.dataset.action;

    if (action === "toggle-reaction") {
      await toggleAnnouncementReaction(btn.dataset.docId, btn.dataset.emoji, () =>
        renderStudentAnnouncements(store.cachedAnnouncements)
      );
    } else if (action === "filter-hw") {
      hwViewFilter = btn.dataset.filter;
      renderAssignmentsList();
    } else if (action === "start-hw") {
      startAssignment(btn.dataset.id);
    } else if (action === "open-analysis") {
      openAnalysisPage(btn.dataset.id);
    } else if (action === "start-punishment") {
      await startPunishmentRunner(btn.dataset.id);
    } else if (action === "rec-start") {
      await startBrowserRecording(btn.dataset.replace === "true");
    } else if (action === "rec-stop") {
      stopBrowserRecording();
    }
  });
}

async function handleUrlCheckInToken() {
  const urlParams = new URLSearchParams(window.location.search);
  const checkinDate = urlParams.get("checkin");
  if (!checkinDate || !store.currentStudentId) return;

  const todayStr = getTodayStr();
  if (checkinDate !== todayStr) {
    notify("This QR code is expired or invalid for today's date!", "error");
    window.history.replaceState({}, document.title, window.location.pathname);
    return;
  }

  const now = new Date();
  const dayOfWeek = now.getDay();
  const isClassDay = dayOfWeek === 2 || dayOfWeek === 4 || dayOfWeek === 6;
  if (!isClassDay) {
    notify("Today is not a scheduled class day (Tue, Thu, Sat)!", "error");
    window.history.replaceState({}, document.title, window.location.pathname);
    return;
  }

  try {
    const totalMinutes = now.getHours() * 60 + now.getMinutes();
    const scheduledStartMinutes = dayOfWeek === 6 ? 10 * 60 + 30 : 16 * 60;
    const status = totalMinutes <= scheduledStartMinutes + 15 ? "Present" : "Late";

    const docId = `${todayStr}_${store.currentStudentId}`;
    await setDoc(
      doc(db, "attendance", docId),
      { studentId: store.currentStudentId, date: todayStr, status, checkedInAt: serverTimestamp() },
      { merge: true }
    );

    const statusBox = document.getElementById("checkin-status-box");
    if (statusBox) {
      statusBox.innerHTML = `
        <span style="color: var(--success); font-size: 18px;">✅ Attendance Logged as "${status}"!</span>
        <div class="muted" style="font-size: 13px; margin-top: 4px;">Date: ${todayStr}</div>`;
    }
    notify(`Attendance logged: ${status}`, "success");
    window.history.replaceState({}, document.title, window.location.pathname);
  } catch (err) {
    console.error("Check-in error:", err);
  }
}

async function ensureStudentStatsDataLoaded(force = false) {
  if (statsDataLoaded && !force) return;
  const [usersSnap, mocksSnap] = await Promise.all([
    getDocs(collection(db, "users")),
    getDocs(collection(db, "mockScores"))
  ]);

  const groupUsers = [];
  usersSnap.forEach((d) => {
    if (d.data().role === "student") groupUsers.push(d.data());
  });
  store.allGroupUsers = groupUsers;

  const groupMocks = [];
  mocksSnap.forEach((d) => groupMocks.push(d.data()));
  groupMocks.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  store.allGroupMocks = groupMocks;
  store.studentMocksList = groupMocks.filter((m) => m.studentId === store.currentStudentId);
  statsDataLoaded = true;
}

async function initStudentData() {
  statsDataLoaded = false;
  const [meSnap, progSnap, subsSnap, myMocksSnap, annSnap, hwSnap, punSnap] = await Promise.all([
    getDoc(doc(db, "users", store.currentStudentId)),
    getDocs(query(collection(db, "ankiProgress"), where("studentId", "==", store.currentStudentId))),
    getDocs(query(collection(db, "submissions"), where("studentId", "==", store.currentStudentId))),
    getDocs(query(collection(db, "mockScores"), where("studentId", "==", store.currentStudentId))),
    getDocs(collection(db, "announcements")),
    getDocs(query(collection(db, "customAssignments"), where("studentId", "in", [store.currentStudentId, "ALL"]))),
    getDocs(query(collection(db, "punishments"), where("studentId", "==", store.currentStudentId)))
  ]);

  store.currentStudentProfile = meSnap.exists()
    ? meSnap.data()
    : { studentId: store.currentStudentId, fullName: store.currentStudentId, ankiStats: {}, permanentMistakes: {} };

  const myMocks = [];
  myMocksSnap.forEach((d) => myMocks.push(d.data()));
  myMocks.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  store.studentMocksList = myMocks;

  document.getElementById("user-display-name").textContent = store.currentStudentProfile.fullName;
  document.getElementById("welcome-student-name").textContent = store.currentStudentProfile.fullName;

  const progMap = {};
  progSnap.forEach((d) => {
    progMap[d.data().cardId] = d.data();
  });
  store.ankiProgressMap = progMap;

  const subsMap = {};
  subsSnap.forEach((d) => {
    subsMap[d.data().assignmentId] = d.data();
  });
  store.studentSubmissionsMap = subsMap;

  const teacherHw = [];
  hwSnap.forEach((d) => teacherHw.push(d.data()));
  store.cachedTeacherHw = teacherHw;

  const studentPuns = [];
  punSnap.forEach((d) => studentPuns.push(d.data()));
  store.cachedStudentPunishments = studentPuns;

  const rawAnns = [];
  annSnap.forEach((d) => rawAnns.push({ docId: d.id, ...d.data() }));
  store.cachedAnnouncements = sortAnnouncementsList(rawAnns);

  resetAnkiSession();
  updateDashboardUI();
  renderStudentAnnouncements(store.cachedAnnouncements);
  checkAndShowNewAnnouncementModal(store.cachedAnnouncements);
  renderAssignmentsList();
  renderStudentPunishmentsList();
  renderResourcesList("all");
}

function getUnifiedAssignmentsList() {
  const now = new Date();
  let fallbackWeek = "Current Assignments";
  if (ASSIGNMENTS.length > 0) {
    const upcoming = ASSIGNMENTS.find((a) => parseLocalDeadline(a.dueDate) >= now);
    fallbackWeek = upcoming ? upcoming.week : ASSIGNMENTS[ASSIGNMENTS.length - 1].week;
  }

  const mappedDynamicHw = store.cachedTeacherHw.map((t) => {
    const isTask1 = t.details?.taskType === "task1";
    let instructions = "";
    if (t.skill === "speaking") instructions = `${t.details?.questions || ""}\n\n${t.details?.notes || ""}`;
    else if (t.skill === "grammar" || t.skill === "other") instructions = t.details?.instructions || "";
    else if (t.skill === "listening" || t.skill === "reading") {
      instructions = `Complete ${t.details?.testCount || 1} test set(s). Take a screenshot of your result.`;
    }

    let displayWeek = t.week;
    if (!displayWeek || displayWeek === "Custom Assignments" || displayWeek === "Custom Teacher Tasks") {
      displayWeek = fallbackWeek;
    }

    return {
      id: t.id,
      title: t.title || t.reason,
      skill: t.skill,
      dueDate: t.dueDate,
      week: displayWeek,
      isDynamic: true,
      totalQuestions: (t.details?.testCount || 1) * 40,
      instructions: instructions.trim(),
      promptText: t.details?.promptText || t.title,
      isTask1,
      details: t.details,
      imageUrls: t.imageUrls || [],
      status: t.status
    };
  });

  return [...ASSIGNMENTS, ...mappedDynamicHw];
}

export function updateDashboardUI() {
  const totalDue = getAllDueCountAcrossAllDecks();
  const stats = store.currentStudentProfile?.ankiStats || {};
  const today = getTodayStr();
  const yesterday = getTodayStr(-1);

  let activeStreak = stats.streak || 0;
  if (stats.lastReviewedDate && stats.lastReviewedDate < yesterday) activeStreak = 0;
  const todayCount = stats.lastReviewedDate === today ? stats.todayCount || 0 : 0;

  const allAssignments = getUnifiedAssignmentsList();
  const pendingHw = allAssignments.filter((a) => {
    const isSub = store.studentSubmissionsMap[a.id] || a.status === "submitted" || a.status === "verified";
    if (isSub) return false;
    return !isPastDeadline(a.dueDate, 24);
  }).length;

  const pendingPuns = store.cachedStudentPunishments.filter((t) => t.status !== "verified" && t.status !== "submitted").length;

  document.getElementById("nav-due-badge").textContent = totalDue;
  document.getElementById("nav-hw-badge").textContent = pendingHw;
  document.getElementById("nav-pun-badge").textContent = pendingPuns;
  document.getElementById("dash-due-count").textContent = totalDue;
  document.getElementById("dash-streak-count").textContent = `🔥 ${activeStreak} days`;
  document.getElementById("dash-today-done").textContent = `${todayCount} reviewed today`;
  document.getElementById("dash-hw-pending").textContent = pendingHw;

  document.getElementById("dash-latest-band").textContent =
    store.studentMocksList.length > 0 ? `Band ${store.studentMocksList[store.studentMocksList.length - 1].overall}` : "—";
}

export function showHomeworkListView() {
  stopActiveRecordingCleanup();
  document.getElementById("hw-list-view")?.classList.remove("hidden");
  document.getElementById("hw-runner-view")?.classList.add("hidden");
  document.getElementById("hw-analysis-view")?.classList.add("hidden");
  document.getElementById("hw-custom-runner-view")?.classList.add("hidden");
  renderAssignmentsList();
}

function renderAssignmentsList() {
  const container = document.getElementById("assignments-list-container");
  if (!container) return;

  const todoList = [];
  const missedList = [];
  const doneList = [];
  const allAssignments = getUnifiedAssignmentsList();

  allAssignments.forEach((hw) => {
    const isSub = store.studentSubmissionsMap[hw.id] || hw.status === "submitted" || hw.status === "verified";
    if (isSub) doneList.push(hw);
    else if (isPastDeadline(hw.dueDate, 0)) missedList.push(hw);
    else todoList.push(hw);
  });

  const filterControls = `
    <div style="display:flex;gap:8px;margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:12px;overflow-x:auto;">
      <button type="button" class="btn ${hwViewFilter === "todo" ? "btn-primary" : "btn-outline"} btn-sm" data-action="filter-hw" data-filter="todo" style="white-space:nowrap;">To Do (${todoList.length})</button>
      <button type="button" class="btn ${hwViewFilter === "missed" ? "btn-primary" : "btn-outline"} btn-sm" data-action="filter-hw" data-filter="missed" style="white-space:nowrap;${hwViewFilter !== "missed" && missedList.length > 0 ? "color:var(--danger);border-color:#fecaca;" : ""}">Missed (${missedList.length})</button>
      <button type="button" class="btn ${hwViewFilter === "completed" ? "btn-primary" : "btn-outline"} btn-sm" data-action="filter-hw" data-filter="completed" style="white-space:nowrap;">Completed (${doneList.length})</button>
    </div>`;

  const activeList = hwViewFilter === "todo" ? todoList : hwViewFilter === "missed" ? missedList : doneList;
  if (activeList.length === 0) {
    const emptyMsg =
      hwViewFilter === "todo"
        ? "🎉 All caught up on current tasks!"
        : hwViewFilter === "missed"
          ? "✅ Excellent! You have no missed assignments."
          : "No completed assignments yet.";
    container.innerHTML = filterControls + `<p class="muted center" style="padding:24px 0;">${emptyMsg}</p>`;
    return;
  }

  const grouped = {};
  activeList.forEach((hw) => {
    const wk = hw.week || "Current Assignments";
    if (!grouped[wk]) grouped[wk] = [];
    grouped[wk].push(hw);
  });

  const groupsHtml = Object.entries(grouped)
    .map(([weekTitle, items]) => {
      const cardsHtml = items
        .map((hw) => {
          const sub = store.studentSubmissionsMap[hw.id];
          const isPastDue = isPastDeadline(hw.dueDate, 0);
          const isSub = sub || hw.status === "submitted" || hw.status === "verified";

          let statusBadge = "";
          let actionBtn = "";
          let feedbackHtml = "";

          if (isSub) {
            if (sub && sub.status === "graded") {
              statusBadge = sub.bandScore
                ? `<span class="badge badge-green">Verified: Band ${sub.bandScore}</span>`
                : `<span class="badge badge-green">Checked by Teacher</span>`;
            } else if (sub && sub.isLate) {
              statusBadge = `<span class="badge badge-red">Submitted Late${sub.bandScore ? ` • Band ${sub.bandScore}` : ""}</span>`;
            } else {
              statusBadge = `<span class="badge badge-blue">Submitted${sub && sub.bandScore ? ` • Band ${sub.bandScore}` : ""}</span>`;
            }
            if (sub && sub.teacherFeedback) {
              feedbackHtml = `<div class="feedback-callout"><strong>Teacher Feedback:</strong> ${escapeHtml(sub.teacherFeedback)}</div>`;
            }
            actionBtn =
              sub && (hw.skill === "reading" || hw.skill === "listening")
                ? `<button type="button" class="btn btn-outline btn-sm" data-action="open-analysis" data-id="${escapeHtml(hw.id)}">View Receipt</button>`
                : `<span class="muted" style="font-size:13px;margin:0;">Submitted</span>`;
          } else if (isPastDeadline(hw.dueDate, 24)) {
            statusBadge = `<span class="badge badge-red">Closed (Deadline Passed)</span>`;
            actionBtn = `<span class="muted" style="font-size:13px;font-weight:600;color:var(--danger);">Closed</span>`;
          } else if (isPastDue) {
            statusBadge = `<span class="badge badge-gray">Missing (Late Window Open)</span>`;
            actionBtn = `<button type="button" class="btn btn-primary btn-sm" data-action="start-hw" data-id="${escapeHtml(hw.id)}">Submit Late</button>`;
          } else {
            statusBadge = `<span class="badge badge-yellow">Due ${formatDueDate(hw.dueDate)}</span>`;
            actionBtn = `<button type="button" class="btn btn-primary btn-sm" data-action="start-hw" data-id="${escapeHtml(hw.id)}">Submit</button>`;
          }

          return `
          <div class="hw-item">
            <div style="flex:1;min-width:240px;">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span class="role-pill">${escapeHtml(hw.skill.toUpperCase())}</span>
                <strong>${escapeHtml(hw.title)}</strong>
              </div>
              <div class="hw-meta"><span>Deadline: ${formatDueDate(hw.dueDate)}</span>${statusBadge}</div>
              ${feedbackHtml}
            </div>
            <div>${actionBtn}</div>
          </div>`;
        })
        .join("");
      return `<div style="margin-bottom:18px;"><h3 style="font-size:14px;color:var(--primary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">${escapeHtml(weekTitle)}</h3><div style="display:flex;flex-direction:column;gap:12px;">${cardsHtml}</div></div>`;
    })
    .join("");

  container.innerHTML = filterControls + groupsHtml;
}

function renderTaskRunnerWorkspace({ task, leftPane, rightPane, collectionName = null, onComplete }) {
  const refImagesHtml =
    task.imageUrls && task.imageUrls.length > 0
      ? `<div style="margin-top:14px;display:flex;flex-direction:column;gap:10px;">
           ${task.imageUrls.map((url) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${escapeHtml(url)}" alt="Reference" style="width:100%;max-height:360px;object-fit:contain;border:1px solid var(--border);border-radius:8px;background:#fff;" /></a>`).join("")}
         </div>`
      : "";

  if (task.skill === "reading" || task.skill === "listening") {
    const isDrill = Boolean(task.isDrill);
    if (isDrill) {
      const drillTypes = task.drillTypes || [
        { key: "TFNG", label: "True / False / Not Given" },
        { key: "YNNG", label: "Yes / No / Not Given" }
      ];
      leftPane.innerHTML = `<h3>Drill Instructions</h3><p class="passage-box" style="margin-bottom:16px;">${escapeHtml(task.instructions)}</p>
        <div style="background:#f8fafc;border:1px solid var(--border);padding:14px;border-radius:8px;font-size:13px;"><strong>How this works:</strong><br/>Enter how many questions you got right and total questions for each type.</div>${refImagesHtml}`;

      const drillRowsHtml = drillTypes
        .map(
          (item) => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;">
          <span style="font-size:14px;font-weight:600;">${escapeHtml(item.label)}</span>
          <div style="display:flex;align-items:center;gap:8px;">
            <input type="number" class="drill-correct-input" data-type="${escapeHtml(item.key)}" min="0" placeholder="Correct" style="width:84px;padding:6px 8px;text-align:center;" required />
            <span style="font-weight:700;color:var(--muted);">/</span>
            <input type="number" class="drill-total-input" data-type="${escapeHtml(item.key)}" min="0" placeholder="Total" style="width:84px;padding:6px 8px;text-align:center;" required />
          </div>
        </div>`
        )
        .join("");

      rightPane.innerHTML = `<h3>Submit Drill Score</h3>
        <div class="form-group"><label>Upload Result Screenshot</label><input type="file" id="runner-lr-file" accept="image/*" multiple required /></div>
        <div class="form-group"><label>Score Breakdown</label><div style="border:1px solid var(--border);border-radius:8px;padding:2px 14px;">${drillRowsHtml}</div></div>
        <button type="button" class="btn btn-primary btn-full" id="runner-submit-btn">Upload Screenshot & Submit Drill</button>`;
    } else {
      const testCount = Math.max(1, Number(task.details?.testCount) || Math.round((task.totalQuestions || 40) / 40));
      const totalQ = testCount * 40;
      const mistakeTypes =
        task.skill === "reading"
          ? [
              { key: "MCQ", label: "Multiple Choice" },
              { key: "TFNG", label: "True / False / Not Given" },
              { key: "YNNG", label: "Yes / No / Not Given" },
              { key: "MATCHING_HEADINGS", label: "Matching Headings" },
              { key: "MATCHING_INFO", label: "Matching Information" },
              { key: "MATCHING_FEATURES", label: "Matching Features" },
              { key: "MATCHING_SENTENCE_ENDINGS", label: "Matching Sentence Endings" },
              { key: "SENTENCE_COMPLETION", label: "Sentence Completion" },
              { key: "SUMMARY_COMPLETION", label: "Summary Completion" },
              { key: "NOTE_COMPLETION", label: "Note Completion" },
              { key: "TABLE_COMPLETION", label: "Table Completion" },
              { key: "FLOW_CHART_COMPLETION", label: "Flow-chart Completion" },
              { key: "DIAGRAM_LABELLING", label: "Diagram Labelling" },
              { key: "SHORT_ANSWER", label: "Short-Answer Questions" }
            ]
          : [
              { key: "MCQ", label: "Multiple Choice" },
              { key: "MATCHING", label: "Matching" },
              { key: "MAP_DIAGRAM", label: "Plan, Map, or Diagram Labelling" },
              { key: "FORM_NOTE_TABLE_SUMMARY", label: "Form, Note, Table, Flow-Chart, or Summary" },
              { key: "SENTENCE_COMPLETION", label: "Sentence Completion" },
              { key: "SHORT_ANSWER", label: "Short-Answer Questions" }
            ];

      leftPane.innerHTML = `<h3>Instructions</h3><p class="passage-box" style="margin-bottom:16px;">${escapeHtml(task.instructions)}</p>
        <div style="background:#f8fafc;border:1px solid var(--border);padding:14px;border-radius:8px;font-size:13px;"><strong>How to log your mistakes:</strong><br/>Count how many questions you missed in each category.</div>${refImagesHtml}`;

      const setScoreInputsHtml = Array.from({ length: testCount }, (_, idx) => {
        const label = testCount > 1 ? `Test Set ${idx + 1} — Correct Answers (out of 40)` : `Your Correct Answers (out of 40)`;
        return `<div class="form-group"><label>${label}</label><input type="number" class="runner-set-score" min="0" max="40" required /></div>`;
      }).join("");

      const mistakeInputsHtml = mistakeTypes
        .map(
          (item) => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);">
          <span style="font-size:13px;font-weight:600;line-height:1.35;">${escapeHtml(item.label)}</span>
          <input type="number" class="runner-mistake-input" data-type="${escapeHtml(item.key)}" min="0" max="${totalQ}" value="0" style="width:72px;flex-shrink:0;padding:6px 8px;text-align:center;" />
        </div>`
        )
        .join("");

      rightPane.innerHTML = `<h3>Submit Score</h3>
        ${setScoreInputsHtml}
        <div class="form-group"><label>Upload Result Screenshot</label><input type="file" id="runner-lr-file" accept="image/*" multiple required /></div>
        <div class="form-group"><label>Mistakes by Question Type</label><div style="border:1px solid var(--border);border-radius:8px;padding:2px 12px;max-height:300px;overflow-y:auto;">${mistakeInputsHtml}</div></div>
        <button type="button" class="btn btn-primary btn-full" id="runner-submit-btn">Upload Screenshot & Submit Score</button>`;
    }

    document.getElementById("runner-submit-btn")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      await withLoading(btn, "Uploading & Submitting...", async () => {
        const urls = await uploadImagesToCloudinary("runner-lr-file", true);
        let rawVal = 0;
        let totalQ = task.totalQuestions || 40;
        const mistakeCounts = {};
        const drillBreakdown = {};
        const setScores = [];
        const updatedMistakes = { ...(store.currentStudentProfile.permanentMistakes || {}) };

        if (isDrill) {
          let sumCorrect = 0;
          let sumTotal = 0;
          for (const cInp of document.querySelectorAll(".drill-correct-input")) {
            const type = cInp.dataset.type;
            const tInp = document.querySelector(`.drill-total-input[data-type="${type}"]`);
            if (cInp.value === "" || tInp.value === "") {
              throw new Error(`Enter both Correct and Total for ${MISTAKE_LABELS[type] || type}.`);
            }
            const correctNum = Number(cInp.value);
            const totalNum = Number(tInp.value);
            if (isNaN(correctNum) || isNaN(totalNum) || correctNum < 0 || totalNum < 0 || correctNum > totalNum) {
              throw new Error(`Invalid numbers for ${type}.`);
            }
            const wrongNum = totalNum - correctNum;
            sumCorrect += correctNum;
            sumTotal += totalNum;
            drillBreakdown[type] = { correct: correctNum, total: totalNum };
            mistakeCounts[type] = wrongNum;
            if (wrongNum > 0) updatedMistakes[type] = { wrong: (updatedMistakes[type]?.wrong || 0) + wrongNum };
          }
          if (sumTotal === 0) throw new Error("Total questions must be greater than 0.");
          rawVal = sumCorrect;
          totalQ = sumTotal;
        } else {
          const scoreInputs = Array.from(document.querySelectorAll(".runner-set-score"));
          for (let i = 0; i < scoreInputs.length; i++) {
            const valStr = scoreInputs[i].value;
            const val = Number(valStr);
            if (valStr === "" || isNaN(val) || val < 0 || val > 40) {
              throw new Error(`Enter a valid score (0–40) for Test Set ${i + 1}.`);
            }
            setScores.push(val);
          }
          rawVal = setScores.reduce((sum, n) => sum + n, 0);
          totalQ = setScores.length * 40;

          document.querySelectorAll(".runner-mistake-input").forEach((inp) => {
            const type = inp.dataset.type;
            const wrongNum = Math.max(0, Number(inp.value) || 0);
            mistakeCounts[type] = wrongNum;
            if (wrongNum > 0) updatedMistakes[type] = { wrong: (updatedMistakes[type]?.wrong || 0) + wrongNum };
          });
        }

        const isRealTest = !isDrill && totalQ % 40 === 0;
        const bandScore = isRealTest ? rawToIeltsBand(rawVal, totalQ) : null;

        await submitTaskSubmission({
          task,
          collectionName,
          updatedMistakes,
          payload: {
            isDrill: !isRealTest,
            rawScore: rawVal,
            totalQuestions: totalQ,
            setScores,
            bandScore,
            screenshotUrls: urls,
            mistakeCounts,
            drillBreakdown
          }
        });

        notify("Score submitted successfully!", "success");
        updateDashboardUI();
        if (onComplete) onComplete(true);
      });
    });
  } else if (task.skill === "writing") {
    const hasTeacherChart = task.imageUrls && task.imageUrls.length > 0;
    const requiresChart = (task.isTask1 || task.id === "HW-05") && !hasTeacherChart;
    const chartHtml = requiresChart
      ? `<div class="form-group"><label>Upload Line Graph / Chart Image (Required)</label><input type="file" id="runner-w-img" accept="image/*" multiple required /></div>`
      : "";

    leftPane.innerHTML = `<h3>Instructions</h3><p class="passage-box" style="margin-bottom:16px;white-space:pre-line;">${escapeHtml(task.promptText || task.title)}</p>${refImagesHtml}`;
    rightPane.innerHTML = `<h3>Your Essay / Report Response</h3>
      ${chartHtml}
      <div class="form-group"><label>Type your response here</label><textarea id="runner-w-text" rows="12" style="width:100%;padding:12px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:14px;"></textarea></div>
      <button type="button" class="btn btn-primary btn-full" id="runner-submit-btn">Submit Writing</button>`;

    document.getElementById("runner-submit-btn")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      await withLoading(btn, "Submitting Writing...", async () => {
        const text = document.getElementById("runner-w-text").value.trim();
        if (!text) throw new Error("Please write your essay or report before submitting.");
        const urls = await uploadImagesToCloudinary("runner-w-img", requiresChart);

        await submitTaskSubmission({
          task,
          collectionName,
          payload: {
            essayText: text,
            wordCount: text.split(/\s+/).filter(Boolean).length,
            chartImageUrls: urls
          }
        });

        notify("Writing submitted successfully!", "success");
        updateDashboardUI();
        if (onComplete) onComplete(false);
      });
    });
  } else if (task.skill === "speaking") {
    leftPane.innerHTML = `<h3>Instructions</h3><p class="passage-box" style="margin-bottom:16px;white-space:pre-line;">${escapeHtml(task.instructions)}</p>${refImagesHtml}`;
    rightPane.innerHTML = `
      <h3>Record Speaking Answer</h3>
      <div style="text-align:center;padding:24px 0;">
        <div id="rec-status-label" style="font-weight:600;margin-bottom:12px;">Ready to record</div>
        <div id="rec-timer-display" style="font-size:32px;font-weight:700;font-family:monospace;margin-bottom:16px;">00:00</div>
        <div style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin-bottom:20px;">
          <button type="button" class="btn btn-primary" id="btn-start-rec" data-action="rec-start" data-replace="false">🔴 Start Recording</button>
          <button type="button" class="btn btn-outline hidden" id="btn-rerecord-rec" data-action="rec-start" data-replace="true">↻ Re-record Last</button>
          <button type="button" class="btn btn-outline hidden" id="btn-addmore-rec" data-action="rec-start" data-replace="false" style="color:var(--primary);border-color:#bfdbfe;">➕ Record One More</button>
          <button type="button" class="btn btn-outline hidden" id="btn-stop-rec" data-action="rec-stop" style="color:var(--danger);border-color:#fecaca;">⏹ Stop Recording</button>
        </div>
        <div id="rec-preview-area" class="hidden" style="margin-top:16px;text-align:left;"></div>
      </div>
      <div class="form-group" style="border-top:1px dashed var(--border);padding-top:14px;margin-top:4px;">
        <label style="font-size:13px;">Or Upload Audio File(s) from Phone / Dictaphone (MP3, M4A, WAV, OGG)</label>
        <input type="file" id="runner-spk-files" accept="audio/*,.m4a,.mp3,.wav,.ogg,.webm" multiple />
      </div>
      <button type="button" class="btn btn-primary btn-full" id="runner-submit-btn">Upload & Submit Speaking</button>`;

    document.getElementById("runner-submit-btn")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const recorded = getRecordedClips();
      const uploadedFiles = Array.from(document.getElementById("runner-spk-files")?.files || []);
      const combinedItems = recorded.length > 0 ? recorded : uploadedFiles;

      if (combinedItems.length === 0) {
        return notify("Please record your answer or attach an audio file first.", "warning");
      }
      if (combinedItems.length > 5) {
        return notify("Maximum 5 audio files allowed per submission.", "warning");
      }

      await withLoading(btn, `Uploading ${combinedItems.length} audio file(s)...`, async () => {
        const audioUrls = await uploadAudioClipsToCloudinary(combinedItems, task.id);
        await submitTaskSubmission({
          task,
          collectionName,
          payload: { audioUrl: audioUrls[0], audioUrls }
        });

        resetRecordedClips();
        notify("Speaking recording(s) uploaded!", "success");
        updateDashboardUI();
        if (onComplete) onComplete(false);
      });
    });
  } else if (task.skill === "grammar") {
    leftPane.innerHTML = `<h3>Instructions</h3><p class="passage-box" style="margin-bottom:16px;white-space:pre-line;">${escapeHtml(task.instructions)}</p>${refImagesHtml}`;
    rightPane.innerHTML = `
      <h3>Upload Completed Pages</h3>
      <div class="form-group"><label>Workbook Photo / Screenshot</label><input type="file" id="runner-gram-file" accept="image/*" multiple required /></div>
      <div class="form-group"><label>Student Notes / Questions (Optional)</label><input type="text" id="runner-gram-notes" /></div>
      <button type="button" class="btn btn-primary btn-full" id="runner-submit-btn">Upload & Submit Homework</button>`;

    document.getElementById("runner-submit-btn")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      await withLoading(btn, "Uploading images...", async () => {
        const urls = await uploadImagesToCloudinary("runner-gram-file", true);
        const notes = document.getElementById("runner-gram-notes").value.trim();

        await submitTaskSubmission({
          task,
          collectionName,
          payload: { screenshotUrls: urls, notes }
        });

        notify("Grammar homework uploaded!", "success");
        updateDashboardUI();
        if (onComplete) onComplete(false);
      });
    });
  } else {
    leftPane.innerHTML = `<h3>Instructions</h3><p class="passage-box" style="margin-bottom:16px;white-space:pre-line;">${escapeHtml(task.instructions)}</p>${refImagesHtml}`;
    rightPane.innerHTML = `
      <h3>Submit Task Response</h3>
      <div class="form-group"><label>Attach Photo / Screenshot (Optional)</label><input type="file" id="runner-other-file" accept="image/*" multiple /></div>
      <div class="form-group"><label>Type your answer or notes here</label><textarea id="runner-other-notes" rows="8" style="width:100%;padding:12px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:14px;"></textarea></div>
      <button type="button" class="btn btn-primary btn-full" id="runner-submit-btn">Submit Task</button>`;

    document.getElementById("runner-submit-btn")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      await withLoading(btn, "Submitting Task...", async () => {
        const notes = document.getElementById("runner-other-notes").value.trim();
        const fileInput = document.getElementById("runner-other-file");
        if (!notes && !fileInput?.files?.length) {
          throw new Error("Please enter notes or attach a file before submitting.");
        }
        const urls = await uploadImagesToCloudinary("runner-other-file", false);

        await submitTaskSubmission({
          task,
          collectionName,
          payload: { notes, screenshotUrls: urls }
        });

        notify("Task submitted successfully!", "success");
        updateDashboardUI();
        if (onComplete) onComplete(false);
      });
    });
  }
}

function startAssignment(assignmentId) {
  resetRecordedClips();
  const hw = getUnifiedAssignmentsList().find((a) => a.id === assignmentId);
  if (!hw) return;

  if (store.studentSubmissionsMap[assignmentId] || hw.status === "submitted" || hw.status === "verified") {
    notify("You have already submitted this assignment.", "info");
    renderAssignmentsList();
    return;
  }

  if (isPastDeadline(hw.dueDate, 24)) {
    notify("The 24-hour late submission window for this assignment has closed.", "error");
    renderAssignmentsList();
    return;
  }

  document.getElementById("hw-list-view")?.classList.add("hidden");
  document.getElementById("hw-analysis-view")?.classList.add("hidden");
  document.getElementById("hw-runner-view")?.classList.remove("hidden");

  document.getElementById("runner-title").textContent = hw.title;
  document.getElementById("runner-due-badge").textContent = `Due: ${formatDueDate(hw.dueDate)}`;

  renderTaskRunnerWorkspace({
    task: hw,
    leftPane: document.getElementById("runner-prompt-pane"),
    rightPane: document.getElementById("runner-work-pane"),
    collectionName: hw.isDynamic ? "customAssignments" : null,
    onComplete: (openReceipt) => {
      if (openReceipt) openAnalysisPage(hw.id);
      else showHomeworkListView();
    }
  });
}

async function startPunishmentRunner(taskId) {
  resetRecordedClips();
  const snap = await getDoc(doc(db, "punishments", taskId));
  if (!snap.exists()) return;
  const raw = snap.data();

  let instructions = "";
  if (raw.skill === "speaking") instructions = `${raw.details?.questions || ""}\n\n${raw.details?.notes || ""}`;
  else if (raw.skill === "grammar" || raw.skill === "other") instructions = raw.details?.instructions || "";
  else if (raw.skill === "listening" || raw.skill === "reading") {
    instructions = `Complete ${raw.details?.testCount || 1} test set(s). Take a screenshot of your result.`;
  }

  const task = {
    id: raw.id,
    title: raw.reason,
    skill: raw.skill,
    dueDate: raw.dueDate,
    isDynamic: true,
    totalQuestions: (raw.details?.testCount || 1) * 40,
    instructions: instructions.trim(),
    promptText: raw.details?.promptText || raw.reason,
    isTask1: raw.details?.taskType === "task1",
    details: raw.details
  };

  document.getElementById("student-punishments-container")?.classList.add("hidden");
  document.getElementById("punishment-runner-view")?.classList.remove("hidden");
  document.getElementById("punishment-runner-title").textContent = raw.reason;
  document.getElementById("punishment-runner-due").textContent = `Due: ${formatDueDate(raw.dueDate)}`;

  renderTaskRunnerWorkspace({
    task,
    leftPane: document.getElementById("pun-runner-left"),
    rightPane: document.getElementById("pun-runner-right"),
    collectionName: "punishments",
    onComplete: () => {
      document.getElementById("back-to-punishments-btn")?.click();
    }
  });
}

function openAnalysisPage(assignmentId) {
  const hw = getUnifiedAssignmentsList().find((a) => a.id === assignmentId);
  const sub = store.studentSubmissionsMap[assignmentId];
  if (!hw || !sub) return;

  document.getElementById("hw-list-view")?.classList.add("hidden");
  document.getElementById("hw-runner-view")?.classList.add("hidden");
  document.getElementById("hw-analysis-view")?.classList.remove("hidden");

  document.getElementById("analysis-title").textContent = `${hw.title} — Submission`;
  const pill = document.getElementById("analysis-status-pill");
  pill.textContent = sub.isLate ? "Submitted Late" : "Submitted On Time";
  pill.className = sub.isLate ? "badge badge-red" : "badge badge-green";

  const pct = Math.round((sub.rawScore / sub.totalQuestions) * 100);
  document.getElementById("ana-raw-score").textContent = `${sub.rawScore} / ${sub.totalQuestions}`;
  document.getElementById("ana-band-score").textContent = sub.bandScore ? `Band ${sub.bandScore}` : "Practice Drill";
  document.getElementById("ana-accuracy").textContent = `${pct}%`;

  const allImgs = Array.isArray(sub.screenshotUrls) ? sub.screenshotUrls : sub.screenshotUrl ? [sub.screenshotUrl] : [];
  document.getElementById("ana-screenshot-box").innerHTML =
    allImgs.length > 0
      ? allImgs
          .map(
            (url) =>
              `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${escapeHtml(url)}" alt="Result Screenshot" style="width:100%;border-radius:8px;border:1px solid var(--border);margin-bottom:8px;" /></a>`
          )
          .join("")
      : `<p class="muted">No screenshot attached.</p>`;

  const logged = Object.entries(sub.mistakeCounts || {}).filter(([, v]) => v > 0);
  document.getElementById("ana-type-breakdown").innerHTML =
    logged.length > 0
      ? logged
          .map(
            ([type, count]) => `
        <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">
          <strong>${escapeHtml(MISTAKE_LABELS[type] || type)}</strong>
          <span class="badge badge-red">${count} mistake${count > 1 ? "s" : ""}</span>
        </div>`
          )
          .join("")
      : `<p class="muted">No specific question-type mistakes logged for this test.</p>`;
}

export function renderStudentPunishmentsList() {
  const container = document.getElementById("student-punishments-container");
  if (!container) return;

  const pendingCount = store.cachedStudentPunishments.filter((t) => t.status !== "verified" && t.status !== "submitted").length;
  document.getElementById("nav-pun-badge").textContent = pendingCount;

  if (store.cachedStudentPunishments.length === 0) {
    container.innerHTML = `<p class="muted center" style="padding:32px 0;">🎉 You have no active punishments or extra tasks!</p>`;
    return;
  }

  container.innerHTML = store.cachedStudentPunishments
    .map((t) => {
      let detailStr = "";
      if (t.skill === "listening" || t.skill === "reading") detailStr = `${t.details.testCount || 1} test set(s)`;
      else if (t.skill === "speaking") detailStr = t.details.notes || "Speaking practice";
      else detailStr = t.details.instructions || t.details.promptText || "";

      const statusBadge =
        t.status === "verified"
          ? `<span class="badge badge-green">Completed & Verified</span>`
          : t.status === "submitted"
            ? `<span class="badge badge-blue">Submitted (Pending Review)</span>`
            : `<span class="badge badge-red">Pending Due ${formatDueDate(t.dueDate)}</span>`;

      const actionBtn =
        t.status === "verified" || t.status === "submitted"
          ? `<span class="muted" style="font-size:13px;">${t.status === "verified" ? "Completed" : "Submitted"}</span>`
          : `<button type="button" class="btn btn-primary btn-sm" data-action="start-punishment" data-id="${escapeHtml(t.id)}">Complete</button>`;

      return `
      <div class="hw-item">
        <div style="flex:1;">
          <span class="role-pill">${escapeHtml(t.skill.toUpperCase())}</span>
          <strong>${escapeHtml(t.reason)}</strong>
          <div style="font-size:13px;color:var(--text);margin-top:4px;">Instructions: ${escapeHtml(detailStr)}</div>
          <div class="hw-meta" style="margin-top:6px;"><span>Deadline: ${formatDueDate(t.dueDate)}</span>${statusBadge}</div>
        </div>
        <div>${actionBtn}</div>
      </div>`;
    })
    .join("");
}

function renderResourcesList(cat) {
  const container = document.getElementById("resources-grid-container");
  if (!container) return;
  const filtered = cat === "all" ? RESOURCES : RESOURCES.filter((r) => r.category === cat);

  if (filtered.length === 0) {
    container.innerHTML = `<p class="muted center">No resources added in this category yet.</p>`;
    return;
  }

  container.innerHTML = filtered
    .map((res) => {
      const embedHtml = res.youtubeId
        ? `<div style="margin-top:12px;border-radius:8px;overflow:hidden;max-width:560px;">
             <iframe width="100%" height="260" src="https://www.youtube.com/embed/${escapeHtml(res.youtubeId)}" title="${escapeHtml(res.title)}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
           </div>`
        : "";

      return `
      <div class="hw-item" style="flex-direction:column;align-items:stretch;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
          <div>
            <span class="badge badge-blue" style="margin-bottom:6px;">${escapeHtml(res.category.toUpperCase())}</span>
            ${res.duration ? `<span class="role-pill" style="margin-left:6px;">⏱ ${escapeHtml(res.duration)}</span>` : ""}
            <h3 style="margin-top:6px;">${escapeHtml(res.title)}</h3>
          </div>
          ${res.url ? `<a href="${escapeHtml(res.url)}" target="_blank" rel="noopener" class="btn btn-outline btn-sm">Open Link ↗</a>` : ""}
        </div>
        ${embedHtml}
        ${res.instructions ? `<div class="feedback-callout" style="white-space:pre-line;margin-top:12px;"><strong>How to Practice:</strong>\n${escapeHtml(res.instructions)}</div>` : ""}
      </div>`;
    })
    .join("");
}

export async function renderStatisticsPage() {
  await ensureStudentStatsDataLoaded();
  const subsArr = Object.values(store.studentSubmissionsMap);

  studentChartInstance = await buildScoreChart("student-score-chart", subsArr, store.studentMocksList, studentChartInstance);
  groupCompareChartInstance = await buildGroupCompareChart(
    "group-compare-chart",
    store.studentMocksList,
    store.allGroupMocks,
    groupCompareChartInstance
  );

  renderMistakeBars(
    "dash-permanent-mistakes",
    store.currentStudentProfile.permanentMistakes || {},
    "No question-type mistakes logged yet.",
    "var(--danger)"
  );

  const groupMistakeTotals = {};
  store.allGroupUsers.forEach((u) => {
    Object.entries(u.permanentMistakes || {}).forEach(([type, val]) => {
      const count = val.wrong || 0;
      if (count > 0) groupMistakeTotals[type] = (groupMistakeTotals[type] || 0) + count;
    });
  });

  renderMistakeBars("group-common-mistakes", groupMistakeTotals, "No group mistake data logged yet.", "var(--warning)");

  const yesterday = getTodayStr(-1);
  const rankedStudents = store.allGroupUsers
    .map((u) => {
      const st = u.ankiStats || {};
      const liveStreak = st.lastReviewedDate && st.lastReviewedDate >= yesterday ? st.streak || 0 : 0;
      return { studentId: u.studentId, fullName: u.fullName, streak: liveStreak, totalReviewed: st.totalReviewed || 0 };
    })
    .sort((a, b) => b.streak - a.streak || b.totalReviewed - a.totalReviewed);

  document.getElementById("effort-leaderboard-tbody").innerHTML = rankedStudents
    .map((s, idx) => {
      const isMe = s.studentId === store.currentStudentId;
      const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `#${idx + 1}`;
      return `
      <tr style="${isMe ? "background:#eff6ff;" : ""}">
        <td><strong>${medal}</strong></td>
        <td>${escapeHtml(s.fullName)} ${isMe ? `<span class="badge badge-blue" style="margin-left:4px;">You</span>` : ""}</td>
        <td>🔥 ${s.streak} days</td>
        <td>${s.totalReviewed} cards</td>
      </tr>`;
    })
    .join("");

  const feedbackItems = subsArr.filter((sub) => sub.teacherFeedback || sub.status === "graded");
  const fbContainer = document.getElementById("teacher-feedback-feed");

  if (feedbackItems.length === 0) {
    fbContainer.innerHTML = `<p class="muted">No teacher feedback yet. Once your teacher reviews your submissions, comments will appear here.</p>`;
  } else {
    const unified = getUnifiedAssignmentsList();
    fbContainer.innerHTML = feedbackItems
      .map((sub) => {
        const hw = unified.find((a) => a.id === sub.assignmentId);
        const pun = store.cachedStudentPunishments.find((p) => p.id === sub.assignmentId);
        const skillLabel = sub.skill ? sub.skill.charAt(0).toUpperCase() + sub.skill.slice(1) : "Task";
        const fallbackTitle = sub.assignmentId?.startsWith("PUN_")
          ? `Remedial ${skillLabel} Task`
          : sub.assignmentId?.startsWith("CUSTOMHW_")
            ? `Custom ${skillLabel} Homework`
            : sub.assignmentId;
        const title = sub.assignmentTitle || hw?.title || pun?.reason || fallbackTitle;
        const bandPill = sub.bandScore
          ? `<span class="badge badge-green">Band ${sub.bandScore}</span>`
          : `<span class="badge badge-green">Checked</span>`;
        return `
        <div class="hw-item" style="flex-direction:column;align-items:stretch;padding:14px 16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <strong>${escapeHtml(title)}</strong>
            ${bandPill}
          </div>
          ${
            sub.teacherFeedback
              ? `<div class="feedback-callout" style="margin-top:8px;">${escapeHtml(sub.teacherFeedback)}</div>`
              : `<span class="muted" style="font-size:13px;margin-top:4px;margin-bottom:0;">Verified by teacher (no written note).</span>`
          }
        </div>`;
      })
      .join("");
  }

  const mocksTbody = document.getElementById("student-mocks-tbody");
  if (store.studentMocksList.length === 0) {
    mocksTbody.innerHTML = `<tr><td colspan="7" class="muted center">No mock exam scores recorded yet.</td></tr>`;
  } else {
    mocksTbody.innerHTML = [...store.studentMocksList]
      .reverse()
      .map(
        (m) => `
      <tr>
        <td>${escapeHtml(m.date || "—")}</td>
        <td><strong>${escapeHtml(m.mockTitle)}</strong></td>
        <td>${m.listening}</td>
        <td>${m.reading}</td>
        <td>${m.writing}</td>
        <td>${m.speaking}</td>
        <td><span class="badge badge-blue">Band ${m.overall}</span></td>
      </tr>`
      )
      .join("");
  }
}
