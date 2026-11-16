import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { VOCAB_DECKS } from "./vocab-data.js";
import { ASSIGNMENTS } from "./assignments-data.js";
import { RESOURCES } from "./resources-data.js";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

const firebaseConfig = {
  apiKey: "AIzaSyDrGjx51H42h6Pkg44RIpZo0vyZApz8SGA",
  authDomain: "zhamil-ielts-hub.firebaseapp.com",
  projectId: "zhamil-ielts-hub",
  storageBucket: "zhamil-ielts-hub.firebasestorage.app",
  messagingSenderId: "101411624698",
  appId: "1:101411624698:web:862eba707513e098c65b43"
};

const CLOUDINARY_CLOUD_NAME = "b9izjowd";
const CLOUDINARY_UPLOAD_PRESET = "ielts_speaking";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const secondaryApp = initializeApp(firebaseConfig, "SecondaryAccountCreator");
const secondaryAuth = getAuth(secondaryApp);

const DOMAIN = "@zhamil-hub.local";
const TEACHER_EMAIL = "teacher" + DOMAIN;

// Student Session State
let currentStudentId = null;
let currentStudentProfile = null;
let ankiProgressMap = {};
let ankiQueue = [];
let currentCard = null;
let isCardFlipped = false;
let bonusMode = false;
let selectedDeckId = "all";
let studentSubmissionsMap = {};
let studentMocksList = [];
let allGroupUsers = [];
let allGroupMocks = [];
let cachedAnnouncements = [];

// Chart Instances
let studentChartInstance = null;
let groupCompareChartInstance = null;
let inspectorChartInstance = null;

// Cached Teacher Data
let cachedStudents = [];
let cachedSubmissions = [];
let cachedMocks = [];
let cachedTeacherPunishments = [];

// Audio Recorder State
let mediaRecorder = null;
let recordedChunks = [];
let recordedAudioBlob = null;
let recInterval = null;
let recSeconds = 0;

function rawToIeltsBand(raw, total = 40) {
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

function calcOverallIelts(l, r, w, s) {
  const avg = (Number(l) + Number(r) + Number(w) + Number(s)) / 4;
  return Math.round(avg * 2) / 2;
}

function getTodayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDueDate(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatLoginEmail(rawId) {
  const clean = rawId.trim().toLowerCase();
  return clean.includes("@") ? clean : clean + DOMAIN;
}

function sortAnnouncementsList(list) {
  return [...list].sort((a, b) => {
    if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
    const tA = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAtMs || 0);
    const tB = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAtMs || 0);
    return tB - tA;
  });
}

function formatAnnouncementDate(ann) {
  if (ann.createdAt?.toDate) {
    return ann.createdAt.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  return ann.dateLabel || "Recent";
}

function getAnnouncementBadgeClass(tag) {
  if (tag === "URGENT") return "badge-red";
  if (tag === "MOCK EXAM") return "badge-blue";
  if (tag === "NEW MATERIAL") return "badge-green";
  return "badge-gray";
}

const MISTAKE_LABELS = {
  TFNG: "True / False / Not Given",
  YNNG: "Yes / No / Not Given",
  MATCHING_HEADINGS: "Matching Headings",
  MCQ: "Multiple Choice",
  GAP_FILL: "Summary / Note / Table Completion",
  MATCHING_INFO: "Matching Information / Features",
  MATCHING: "Listening: Matching",
  MAP_DIAGRAM: "Listening: Plan, Map, or Diagram",
  FORM_NOTE_TABLE_SUMMARY: "Listening: Form / Note / Table / Summary",
  SENTENCE_COMPLETION: "Listening: Sentence Completion",
  SHORT_ANSWER: "Listening: Short-Answer Questions"
};

// ==========================================
// AUTHENTICATION & ROUTING
// ==========================================
const loginView = document.getElementById("login-view");
const appShell = document.getElementById("app-shell");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  const rawId = document.getElementById("login-id").value;
  const password = document.getElementById("login-password").value;
  const btn = document.getElementById("login-btn");

  btn.disabled = true;
  btn.textContent = "Signing in...";

  try {
    await signInWithEmailAndPassword(auth, formatLoginEmail(rawId), password);
  } catch (err) {
    loginError.textContent = "Invalid Student ID or password. Please try again.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign In";
  }
});

document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    loginView.classList.remove("hidden");
    appShell.classList.add("hidden");
    currentStudentId = null;
    return;
  }

  loginView.classList.add("hidden");
  appShell.classList.remove("hidden");

  const isTeacher = user.email.toLowerCase() === TEACHER_EMAIL;

  if (isTeacher) {
    document.getElementById("role-badge").textContent = "Teacher Admin";
    document.getElementById("user-display-name").textContent = "Zhamil";
    document.getElementById("teacher-nav").classList.remove("hidden");
    document.getElementById("student-nav").classList.add("hidden");
    document.getElementById("mock-date-input").value = getTodayStr();
    document.getElementById("pun-duedate").value = getTodayStr() + "T23:59";
    switchView("teacher-roster");
    loadTeacherData();
  } else {
    currentStudentId = user.email.split("@")[0].toUpperCase();
    document.getElementById("role-badge").textContent = currentStudentId;
    document.getElementById("student-nav").classList.remove("hidden");
    document.getElementById("teacher-nav").classList.add("hidden");
    switchView("student-dashboard");
    await initStudentData();
  }
});

document.querySelectorAll(".nav-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const parentNav = tab.parentElement;
    parentNav.querySelectorAll(".nav-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    switchView(tab.dataset.target);

    if (tab.dataset.target === "student-homework") {
      showHomeworkListView();
    } else if (tab.dataset.target === "student-stats") {
      renderStatisticsPage();
    } else if (tab.dataset.target === "student-punishments") {
      renderStudentPunishmentsList();
    }
  });
});

function switchView(targetId) {
  document.querySelectorAll(".view-section").forEach((sec) => sec.classList.add("hidden"));
  const target = document.getElementById(targetId);
  if (target) target.classList.remove("hidden");
}

document.getElementById("dash-start-anki-btn").addEventListener("click", () => {
  document.querySelector('[data-target="student-anki"]').click();
});
document.getElementById("dash-go-hw-btn").addEventListener("click", () => {
  document.querySelector('[data-target="student-homework"]').click();
});
document.getElementById("dash-go-stats-btn").addEventListener("click", () => {
  document.querySelector('[data-target="student-stats"]').click();
});

// ==========================================
// TEACHER: ROSTER, MATRIX, GRADING, MOCKS, ANNOUNCEMENTS & PUNISHMENTS
// ==========================================
async function loadTeacherData() {
  const [usersSnap, subsSnap, mocksSnap, annSnap, punSnap] = await Promise.all([
    getDocs(collection(db, "users")),
    getDocs(collection(db, "submissions")),
    getDocs(collection(db, "mockScores")),
    getDocs(collection(db, "announcements")),
    getDocs(collection(db, "punishments"))
  ]);

  cachedStudents = [];
  usersSnap.forEach((d) => {
    if (d.data().role === "student") cachedStudents.push(d.data());
  });
  cachedStudents.sort((a, b) => a.studentId.localeCompare(b.studentId));

  cachedSubmissions = [];
  subsSnap.forEach((d) => cachedSubmissions.push({ docId: d.id, ...d.data() }));

  cachedMocks = [];
  mocksSnap.forEach((d) => cachedMocks.push({ docId: d.id, ...d.data() }));
  cachedMocks.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const rawAnns = [];
  annSnap.forEach((d) => rawAnns.push({ docId: d.id, ...d.data() }));
  cachedAnnouncements = sortAnnouncementsList(rawAnns);

  cachedTeacherPunishments = [];
  punSnap.forEach((d) => cachedTeacherPunishments.push(d.data()));
  cachedTeacherPunishments.sort((a, b) => (b.dueDate || "").localeCompare(a.dueDate || ""));

  renderTeacherRoster(cachedStudents);
  renderTeacherHwMatrix(cachedStudents, cachedSubmissions);
  renderTeacherGradingQueue(cachedStudents, cachedSubmissions);
  populateMockStudentDropdown(cachedStudents);
  populatePunishmentStudentDropdown(cachedStudents);
  renderRecentMocksTable(cachedStudents, cachedMocks);
  renderTeacherAnnouncementsList(cachedAnnouncements);
  renderTeacherPunishments(cachedTeacherPunishments, cachedStudents);
}

const createStudentForm = document.getElementById("create-student-form");
createStudentForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msgEl = document.getElementById("create-student-msg");
  const btn = document.getElementById("create-student-btn");

  const fullName = document.getElementById("new-student-name").value.trim();
  const studentId = document.getElementById("new-student-id").value.trim().toUpperCase();
  const password = document.getElementById("new-student-pass").value;

  msgEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Creating...";

  try {
    const email = studentId.toLowerCase() + DOMAIN;
    await createUserWithEmailAndPassword(secondaryAuth, email, password);
    await signOut(secondaryAuth);

    await setDoc(doc(db, "users", studentId), {
      studentId,
      fullName,
      role: "student",
      createdAt: serverTimestamp(),
      ankiStats: { streak: 0, lastReviewedDate: null, todayCount: 0, totalReviewed: 0 },
      permanentMistakes: {}
    });

    msgEl.style.color = "var(--success)";
    msgEl.textContent = `Account created! Login ID: ${studentId} | Password: ${password}`;
    createStudentForm.reset();
    loadTeacherData();
  } catch (err) {
    msgEl.style.color = "var(--danger)";
    msgEl.textContent = err.code === "auth/email-already-in-use"
      ? `Student ID "${studentId}" already exists.`
      : `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Account";
  }
});

const announcementForm = document.getElementById("announcement-form");
if (announcementForm) {
  announcementForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msgEl = document.getElementById("ann-post-msg");
    const btn = document.getElementById("post-ann-btn");

    const title = document.getElementById("ann-title").value.trim();
    const tag = document.getElementById("ann-tag").value;
    const body = document.getElementById("ann-body").value.trim();
    const pinned = document.getElementById("ann-pinned").checked;

    btn.disabled = true;
    btn.textContent = "Publishing...";
    msgEl.textContent = "";

    try {
      const docId = `ANN_${Date.now()}`;
      await setDoc(doc(db, "announcements", docId), {
        title,
        tag,
        body,
        pinned,
        dateLabel: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        createdAtMs: Date.now(),
        createdAt: serverTimestamp()
      });

      msgEl.style.color = "var(--success)";
      msgEl.textContent = "Announcement published to all student dashboards!";
      announcementForm.reset();
      loadTeacherData();
    } catch (err) {
      msgEl.style.color = "var(--danger)";
      msgEl.textContent = "Error publishing announcement: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Publish Announcement";
    }
  });
}

function renderTeacherAnnouncementsList(list) {
  const container = document.getElementById("teacher-ann-list");
  if (!container) return;

  if (list.length === 0) {
    container.innerHTML = `<p class="muted center">No announcements published yet.</p>`;
    return;
  }

  container.innerHTML = list.map((ann) => `
    <div class="hw-item" style="flex-direction:column;align-items:stretch;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div>
          ${ann.pinned ? `<span class="badge badge-yellow" style="margin-right:4px;">📌 Pinned</span>` : ""}
          <span class="badge ${getAnnouncementBadgeClass(ann.tag)}">${escapeHtml(ann.tag || "GENERAL")}</span>
          <span class="muted" style="font-size:12px;margin-left:6px;">${formatAnnouncementDate(ann)}</span>
          <h3 style="margin-top:6px;">${escapeHtml(ann.title)}</h3>
        </div>
        <button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:#fecaca;" onclick="window.deleteAnnouncement('${ann.docId}')">Delete</button>
      </div>
      <p style="font-size:14px;white-space:pre-line;margin-top:8px;margin-bottom:0;color:var(--text);">${escapeHtml(ann.body)}</p>
    </div>
  `).join("");
}

window.deleteAnnouncement = async function (docId) {
  if (!confirm("Delete this announcement?")) return;
  await deleteDoc(doc(db, "announcements", docId));
  loadTeacherData();
};

const refreshAnnBtn = document.getElementById("refresh-ann-btn");
if (refreshAnnBtn) refreshAnnBtn.addEventListener("click", loadTeacherData);

function renderTeacherRoster(students) {
  const tbody = document.getElementById("roster-table-body");
  document.getElementById("student-count").textContent = students.length;

  if (students.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted center">No students created yet.</td></tr>`;
    return;
  }

  const todayStr = getTodayStr();
  tbody.innerHTML = students
    .map((s) => {
      const stats = s.ankiStats || {};
      const reviewedToday = stats.lastReviewedDate === todayStr ? (stats.todayCount || 0) : 0;
      return `
        <tr>
          <td><strong>${s.studentId}</strong></td>
          <td>${s.fullName}</td>
          <td>🔥 ${stats.streak || 0}d</td>
          <td>${reviewedToday > 0 ? `<span style="color:var(--success);font-weight:600;">${reviewedToday}</span>` : `<span class="muted">0</span>`}</td>
          <td><button class="btn btn-outline btn-sm" onclick="window.inspectStudent('${s.studentId}')">Inspect Stats</button></td>
        </tr>
      `;
    })
    .join("");
}

window.inspectStudent = function (studentId) {
  const student = cachedStudents.find((s) => s.studentId === studentId);
  if (!student) return;

  const card = document.getElementById("teacher-inspector-card");
  card.classList.remove("hidden");
  document.getElementById("inspector-student-title").textContent = `${student.fullName} (${student.studentId}) — Performance Profile`;

  const sSubs = cachedSubmissions.filter((sub) => sub.studentId === studentId);
  const sMocks = cachedMocks.filter((m) => m.studentId === studentId);

  inspectorChartInstance = buildScoreChart("inspector-score-chart", sSubs, sMocks, inspectorChartInstance);
  renderMistakeBars("inspector-mistakes-box", student.permanentMistakes || {}, "No mistakes logged yet.");
  card.scrollIntoView({ behavior: "smooth" });
};

document.getElementById("close-inspector-btn").addEventListener("click", () => {
  document.getElementById("teacher-inspector-card").classList.add("hidden");
});

function populateMockStudentDropdown(students) {
  const sel = document.getElementById("mock-student-select");
  const currentVal = sel.value;
  sel.innerHTML = `<option value="">-- Choose Student --</option>` +
    students.map((s) => `<option value="${s.studentId}">${s.studentId} — ${s.fullName}</option>`).join("");
  if (currentVal) sel.value = currentVal;
}

function populatePunishmentStudentDropdown(students) {
  const sel = document.getElementById("pun-student-select");
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = `<option value="">-- Choose Student --</option>` +
    students.map((s) => `<option value="${s.studentId}">${s.studentId} — ${s.fullName}</option>`).join("");
  if (currentVal) sel.value = currentVal;
}

function renderRecentMocksTable(students, mocks) {
  const tbody = document.getElementById("recent-mocks-tbody");
  if (mocks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted center">No mock scores logged yet.</td></tr>`;
    return;
  }

  const nameMap = {};
  students.forEach((s) => { nameMap[s.studentId] = s.fullName; });

  tbody.innerHTML = mocks.map((m) => `
    <tr>
      <td>${m.date || "—"}</td>
      <td><strong>${m.studentId}</strong><br><span class="muted" style="font-size:12px;">${nameMap[m.studentId] || ""}</span></td>
      <td>${escapeHtml(m.mockTitle)}</td>
      <td>${m.listening} / ${m.reading} / ${m.writing} / ${m.speaking}</td>
      <td><span class="badge badge-blue">Band ${m.overall}</span></td>
    </tr>
  `).join("");
}

document.getElementById("mock-score-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msgEl = document.getElementById("mock-save-msg");
  const btn = document.getElementById("save-mock-btn");

  const studentId = document.getElementById("mock-student-select").value;
  const mockTitle = document.getElementById("mock-title-input").value.trim();
  const date = document.getElementById("mock-date-input").value;
  const listening = Number(document.getElementById("mock-l").value);
  const reading = Number(document.getElementById("mock-r").value);
  const writing = Number(document.getElementById("mock-w").value);
  const speaking = Number(document.getElementById("mock-s").value);
  const overall = calcOverallIelts(listening, reading, writing, speaking);

  btn.disabled = true;
  btn.textContent = "Saving...";
  msgEl.textContent = "";

  try {
    const docId = `${date}_${studentId}_${Date.now()}`;
    await setDoc(doc(db, "mockScores", docId), {
      studentId,
      mockTitle,
      date,
      listening,
      reading,
      writing,
      speaking,
      overall,
      createdAt: serverTimestamp()
    });

    msgEl.style.color = "var(--success)";
    msgEl.textContent = `Saved ${mockTitle} for ${studentId} (Overall Band ${overall})!`;
    document.getElementById("mock-score-form").reset();
    document.getElementById("mock-date-input").value = getTodayStr();
    loadTeacherData();
  } catch (err) {
    msgEl.style.color = "var(--danger)";
    msgEl.textContent = "Error saving mock score: " + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Mock Score";
  }
});

let selectedMatrixWeek = "ALL";

function renderTeacherHwMatrix(students, submissions) {
  const container = document.getElementById("hw-matrix-container");
  if (students.length === 0) {
    container.innerHTML = `<p class="muted center">No students in roster yet.</p>`;
    return;
  }

  const weeks = [...new Set(ASSIGNMENTS.map((a) => a.week || "General"))];
  if (selectedMatrixWeek === "ALL" && weeks.length > 0) {
    selectedMatrixWeek = weeks[weeks.length - 1];
  }

  const filteredAssignments = selectedMatrixWeek === "ALL_SHOW"
    ? ASSIGNMENTS
    : ASSIGNMENTS.filter((a) => (a.week || "General") === selectedMatrixWeek);

  const filterBar = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
      <label style="margin:0;white-space:nowrap;">Filter by Week:</label>
      <select id="matrix-week-select" style="max-width:260px;padding:6px 10px;">
        ${weeks.map((w) => `<option value="${escapeHtml(w)}" ${selectedMatrixWeek === w ? "selected" : ""}>${escapeHtml(w)}</option>`).join("")}
        <option value="ALL_SHOW" ${selectedMatrixWeek === "ALL_SHOW" ? "selected" : ""}>Show All Weeks (${ASSIGNMENTS.length})</option>
      </select>
    </div>
  `;

  const now = new Date();
  const headers = filteredAssignments.map((a) => `<th>${a.id}<br><span style="font-weight:400;font-size:11px;">${a.skill.toUpperCase()}</span></th>`).join("");

  const rows = students.map((s) => {
    const cells = filteredAssignments.map((a) => {
      const sub = submissions.find((item) => item.studentId === s.studentId && item.assignmentId === a.id);
      if (sub) {
        const scoreTxt = sub.bandScore ? ` (${sub.bandScore})` : "";
        if (sub.isLate) return `<td><span class="badge badge-red">Late${scoreTxt}</span></td>`;
        if (sub.status === "graded") return `<td><span class="badge badge-green">Verified${scoreTxt}</span></td>`;
        return `<td><span class="badge badge-blue">Submitted${scoreTxt}</span></td>`;
      } else {
        const isPastDue = now > new Date(a.dueDate);
        return isPastDue
          ? `<td><span class="badge badge-gray">Missing</span></td>`
          : `<td><span class="badge badge-yellow">Pending</span></td>`;
      }
    }).join("");

    return `<tr><td><strong>${s.studentId}</strong><br><span class="muted" style="font-size:12px;">${s.fullName}</span></td>${cells}</tr>`;
  }).join("");

  container.innerHTML = `${filterBar}<table><thead><tr><th>Student</th>${headers}</tr></thead><tbody>${rows}</tbody></table>`;

  document.getElementById("matrix-week-select").addEventListener("change", (e) => {
    selectedMatrixWeek = e.target.value;
    renderTeacherHwMatrix(students, submissions);
  });
}

function renderTeacherGradingQueue(students, submissions) {
  const container = document.getElementById("grading-list-container");
  const ungradedCount = submissions.filter((s) => s.status !== "graded").length;
  document.getElementById("nav-grade-badge").textContent = ungradedCount;

  if (submissions.length === 0) {
    container.innerHTML = `<p class="muted center">No homework submissions yet.</p>`;
    return;
  }

  submissions.sort((a, b) => (a.status === "graded") - (b.status === "graded"));

  const studentNameMap = {};
  students.forEach((s) => { studentNameMap[s.studentId] = s.fullName; });

  container.innerHTML = submissions.map((sub) => {
    const hw = ASSIGNMENTS.find((a) => a.id === sub.assignmentId);
    const title = hw ? hw.title : sub.assignmentId;
    const sName = studentNameMap[sub.studentId] || sub.studentId;
    const noBandRequired = sub.skill === "grammar" || sub.isDrill || (hw && hw.isDrill);

    const statusBadge = sub.status === "graded"
      ? `<span class="badge badge-green">${noBandRequired ? "Checked" : `Verified: Band ${sub.bandScore}`}</span>`
      : `<span class="badge badge-yellow">Needs Review</span>`;
    const lateBadge = sub.isLate ? `<span class="badge badge-red">Late</span>` : "";

    let contentHtml = "";
    if (sub.skill === "reading" || sub.skill === "listening") {
      const mistakesSummary = Object.entries(sub.mistakeCounts || {})
        .filter(([, count]) => count > 0)
        .map(([type, count]) => `<span class="q-tag">${MISTAKE_LABELS[type] || type}: ${count} wrong</span>`)
        .join(" ");

      contentHtml = `
        <div style="margin:10px 0;">
          <p style="font-size:14px;margin-bottom:8px;">
            <strong>Reported Score:</strong> ${sub.rawScore} / ${sub.totalQuestions} ${sub.bandScore ? `(Auto Band ${sub.bandScore})` : `(Drill — Weakest Areas Only)`}
          </p>
          ${mistakesSummary ? `<div style="margin-bottom:10px;">${mistakesSummary}</div>` : ""}
          ${sub.screenshotUrl ? `<a href="${sub.screenshotUrl}" target="_blank" rel="noopener"><img src="${sub.screenshotUrl}" alt="Score Screenshot" style="max-width:100%;max-height:280px;border:1px solid var(--border);border-radius:8px;" /></a><div class="muted" style="font-size:12px;margin-top:4px;">Click image to open full size</div>` : ""}
        </div>
      `;
    } else if (sub.skill === "writing") {
      const chartHtml = sub.chartImageUrl
        ? `<div style="margin:10px 0;"><a href="${sub.chartImageUrl}" target="_blank" rel="noopener"><img src="${sub.chartImageUrl}" alt="Task 1 Graph" style="max-width:100%;max-height:260px;border:1px solid var(--border);border-radius:8px;" /></a><div class="muted" style="font-size:12px;margin-top:4px;">Uploaded Graph/Chart (click to enlarge)</div></div>`
        : "";
      contentHtml = `${chartHtml}<div class="essay-preview">${escapeHtml(sub.essayText || "")}</div><div class="muted" style="font-size:12px;margin-bottom:8px;">Word count: ${sub.wordCount || 0} words</div>`;
    } else if (sub.skill === "speaking") {
      contentHtml = `<div style="margin:12px 0;"><audio controls src="${sub.audioUrl}" style="width:100%;"></audio></div>`;
    } else if (sub.skill === "grammar") {
      contentHtml = `
        <div style="margin:10px 0;">
          ${sub.notes ? `<p style="font-size:14px;margin-bottom:8px;"><strong>Student Note:</strong> ${escapeHtml(sub.notes)}</p>` : ""}
          ${sub.screenshotUrl ? `<a href="${sub.screenshotUrl}" target="_blank" rel="noopener"><img src="${sub.screenshotUrl}" alt="Grammar Work" style="max-width:100%;max-height:280px;border:1px solid var(--border);border-radius:8px;" /></a>` : ""}
        </div>
      `;
    }

    const bandSelectorHtml = noBandRequired
      ? `<div><label>Status</label><input type="text" value="${sub.skill === "grammar" ? "Workbook Check" : "Drill Check"}" disabled style="background:#f1f5f9;color:var(--muted);" /><input type="hidden" id="band-${sub.docId}" value="" /></div>`
      : `<div>
          <label>Confirm / Set Band</label>
          <select id="band-${sub.docId}">
            ${["4.0","4.5","5.0","5.5","6.0","6.5","7.0","7.5","8.0","8.5","9.0"].map((b) =>
              `<option value="${b}" ${String(sub.bandScore) === b ? "selected" : ""}>Band ${b}</option>`
            ).join("")}
          </select>
        </div>`;

    return `
      <div class="grade-card">
        <div class="card-header-flex" style="margin-bottom:6px;">
          <div>
            <span class="role-pill" style="margin-right:6px;">${sub.skill.toUpperCase()}</span>
            <strong>${sName} (${sub.studentId})</strong> — ${title}
          </div>
          <div style="display:flex;gap:6px;">${lateBadge}${statusBadge}</div>
        </div>
        ${contentHtml}
        <div class="grade-controls-row">
          ${bandSelectorHtml}
          <div>
            <label>Teacher Feedback</label>
            <input type="text" id="fb-${sub.docId}" placeholder="Leave a comment or feedback..." value="${escapeHtml(sub.teacherFeedback || "")}" />
          </div>
          <button class="btn btn-primary" onclick="window.saveTeacherGrade('${sub.docId}', ${noBandRequired})">Save & Verify</button>
        </div>
      </div>
    `;
  }).join("");
}

window.saveTeacherGrade = async function (docId, noBandRequired = false) {
  const rawBand = document.getElementById(`band-${docId}`).value;
  const fbVal = document.getElementById(`fb-${docId}`).value.trim();

  const updatePayload = {
    teacherFeedback: fbVal,
    status: "graded",
    gradedAt: serverTimestamp()
  };
  if (!noBandRequired && rawBand) {
    updatePayload.bandScore = Number(rawBand);
  }

  await updateDoc(doc(db, "submissions", docId), updatePayload);

  alert("Verified & feedback saved!");
  loadTeacherData();
};

document.getElementById("refresh-roster-btn").addEventListener("click", loadTeacherData);
document.getElementById("refresh-matrix-btn").addEventListener("click", loadTeacherData);
document.getElementById("refresh-grading-btn").addEventListener("click", loadTeacherData);
const refreshPunishmentsBtn = document.getElementById("refresh-punishments-btn");
if (refreshPunishmentsBtn) refreshPunishmentsBtn.addEventListener("click", loadTeacherData);

// ==========================================
// PUNISHMENTS & MAKEUP SYSTEM (TEACHER)
// ==========================================
const punSkillSelect = document.getElementById("pun-skill-select");
if (punSkillSelect) {
  punSkillSelect.addEventListener("change", renderPunishmentConfigInputs);
  renderPunishmentConfigInputs();
}

function renderPunishmentConfigInputs() {
  const skill = document.getElementById("pun-skill-select").value;
  const container = document.getElementById("pun-config-container");
  if (!container) return;

  if (skill === "listening" || skill === "reading") {
    container.innerHTML = `
      <div class="form-group">
        <label for="pun-count">Number of Test Sets / Passages</label>
        <input type="number" id="pun-count" min="1" max="5" value="1" required />
        <small class="muted">e.g., 1 to 2 listening or reading tests</small>
      </div>
    `;
  } else if (skill === "speaking") {
    container.innerHTML = `
      <div class="form-group">
        <label for="pun-spk-part">Speaking Part</label>
        <select id="pun-spk-part">
          <option value="Part 1 (Introduction & Interview)">Part 1 (Introduction & Interview)</option>
          <option value="Part 2 (Long Turn / Cue Card)">Part 2 (Long Turn / Cue Card)</option>
          <option value="Part 3 (Two-Way Discussion)">Part 3 (Two-Way Discussion)</option>
        </select>
      </div>
      <div class="form-group">
        <label for="pun-spk-qty">Number of Questions / Topics</label>
        <select id="pun-spk-qty">
          <option value="10 Questions">10 Questions</option>
          <option value="20 Questions">20 Questions</option>
          <option value="50 Questions">50 Questions</option>
          <option value="100 Questions">100 Questions</option>
        </select>
      </div>
    `;
  } else if (skill === "writing") {
    container.innerHTML = `
      <div class="form-group">
        <label for="pun-wt-task">Writing Task Type</label>
        <select id="pun-wt-task">
          <option value="Task 1: Line Graph">Task 1: Line Graph</option>
          <option value="Task 1: Bar Chart">Task 1: Bar Chart</option>
          <option value="Task 1: Pie Chart">Task 1: Pie Chart</option>
          <option value="Task 1: Table">Task 1: Table</option>
          <option value="Task 1: Process Diagram / Map">Task 1: Process Diagram / Map</option>
          <option value="Task 2: Opinion / Agreement Essay">Task 2: Opinion / Agreement Essay</option>
          <option value="Task 2: Discussion Essay">Task 2: Discussion Essay</option>
          <option value="Task 2: Problem & Solution Essay">Task 2: Problem & Solution Essay</option>
          <option value="Task 2: Advantage & Disadvantage Essay">Task 2: Advantage & Disadvantage Essay</option>
          <option value="Task 2: Two-Part Question Essay">Task 2: Two-Part Question Essay</option>
        </select>
      </div>
    `;
  }
}

const assignPunishmentForm = document.getElementById("assign-punishment-form");
if (assignPunishmentForm) {
  assignPunishmentForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msgEl = document.getElementById("pun-assign-msg");
    const btn = document.getElementById("assign-pun-btn");

    const studentId = document.getElementById("pun-student-select").value;
    const skill = document.getElementById("pun-skill-select").value;
    const reason = document.getElementById("pun-reason").value.trim();
    const dueDate = document.getElementById("pun-duedate").value;

    let details = {};
    if (skill === "listening" || skill === "reading") {
      details.testCount = Number(document.getElementById("pun-count").value);
    } else if (skill === "speaking") {
      details.part = document.getElementById("pun-spk-part").value;
      details.quantity = document.getElementById("pun-spk-qty").value;
    } else if (skill === "writing") {
      details.taskType = document.getElementById("pun-wt-task").value;
    }

    btn.disabled = true;
    btn.textContent = "Assigning...";
    msgEl.textContent = "";

    try {
      const punId = `PUN_${Date.now()}`;
      await setDoc(doc(db, "punishments", punId), {
        id: punId,
        studentId,
        skill,
        reason,
        details,
        status: "pending",
        dueDate,
        assignedAt: serverTimestamp()
      });

      msgEl.style.color = "var(--success)";
      msgEl.textContent = `Punishment successfully assigned to ${studentId}!`;
      assignPunishmentForm.reset();
      renderPunishmentConfigInputs();
      loadTeacherData();
    } catch (err) {
      msgEl.style.color = "var(--danger)";
      msgEl.textContent = "Error assigning punishment: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Assign Punishment";
    }
  });
}

function renderTeacherPunishments(punishments, students) {
  const tbody = document.getElementById("group-punishments-tbody");
  if (!tbody) return;

  if (punishments.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted center">No active punishments assigned.</td></tr>`;
    return;
  }

  const nameMap = {};
  students.forEach((s) => { nameMap[s.studentId] = s.fullName; });

  tbody.innerHTML = punishments.map((p) => {
    const sName = nameMap[p.studentId] || p.studentId;
    let detailStr = "";
    if (p.skill === "listening" || p.skill === "reading") detailStr = `${p.details.testCount} test set(s)`;
    else if (p.skill === "speaking") detailStr = `${p.details.part} (${p.details.quantity})`;
    else if (p.skill === "writing") detailStr = p.details.taskType;

    const statusBadge = p.status === "verified" ? `<span class="badge badge-green">Verified</span>`
      : p.status === "submitted" ? `<span class="badge badge-blue">Submitted</span>`
      : `<span class="badge badge-red">Pending</span>`;

    return `
      <tr>
        <td><strong>${p.studentId}</strong><br><span class="muted" style="font-size:12px;">${sName}</span></td>
        <td><span class="role-pill">${p.skill.toUpperCase()}</span><br>${escapeHtml(p.reason)}</td>
        <td>${escapeHtml(detailStr)}<br><span class="muted" style="font-size:11px;">Due: ${formatDueDate(p.dueDate)}</span></td>
        <td>${statusBadge}</td>
        <td><button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:#fecaca;" onclick="window.deletePunishment('${p.id}')">Delete</button></td>
      </tr>
    `;
  }).join("");
}

window.deletePunishment = async function (punId) {
  if (!confirm("Remove this assigned punishment?")) return;
  await deleteDoc(doc(db, "punishments", punId));
  loadTeacherData();
};

// ==========================================
// SHARED ANALYTICS RENDERERS (CHARTS & MISTAKES)
// ==========================================
function buildScoreChart(canvasId, submissions, mocks, existingChart) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === "undefined") return existingChart;
  if (existingChart) existingChart.destroy();

  const events = [];

  mocks.forEach((m) => {
    events.push({
      sortKey: m.date || "2026-01-01",
      label: m.mockTitle || "Mock Exam",
      listening: m.listening,
      reading: m.reading,
      writing: m.writing,
      speaking: m.speaking,
      overall: m.overall
    });
  });

  submissions.forEach((sub) => {
    const hw = ASSIGNMENTS.find((a) => a.id === sub.assignmentId);
    if (!sub.bandScore || sub.isDrill || (hw && hw.isDrill)) return;
    if ((sub.skill === "reading" || sub.skill === "listening") && Number(sub.totalQuestions) !== 40) return;

    const dateStr = sub.submittedAt?.toDate
      ? sub.submittedAt.toDate().toISOString().split("T")[0]
      : (hw ? hw.dueDate.split("T")[0] : "2026-11-15");

    events.push({
      sortKey: dateStr,
      label: `${sub.assignmentId} (${sub.skill.toUpperCase()})`,
      listening: sub.skill === "listening" ? sub.bandScore : null,
      reading: sub.skill === "reading" ? sub.bandScore : null,
      writing: sub.skill === "writing" ? sub.bandScore : null,
      speaking: sub.skill === "speaking" ? sub.bandScore : null,
      overall: null
    });
  });

  events.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const labels = events.length > 0 ? events.map((e) => e.label) : ["No Scores Yet"];

  return new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Overall (Mock)",
          data: events.map((e) => e.overall),
          borderColor: "#0f172a",
          backgroundColor: "#0f172a",
          borderWidth: 3,
          spanGaps: true,
          tension: 0.25
        },
        {
          label: "Listening",
          data: events.map((e) => e.listening),
          borderColor: "#1d4ed8",
          backgroundColor: "#1d4ed8",
          spanGaps: true,
          tension: 0.25
        },
        {
          label: "Reading",
          data: events.map((e) => e.reading),
          borderColor: "#16a34a",
          backgroundColor: "#16a34a",
          spanGaps: true,
          tension: 0.25
        },
        {
          label: "Writing",
          data: events.map((e) => e.writing),
          borderColor: "#d97706",
          backgroundColor: "#d97706",
          spanGaps: true,
          tension: 0.25
        },
        {
          label: "Speaking",
          data: events.map((e) => e.speaking),
          borderColor: "#dc2626",
          backgroundColor: "#dc2626",
          spanGaps: true,
          tension: 0.25
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { min: 4.0, max: 9.0, ticks: { stepSize: 0.5 } }
      },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } }
      }
    }
  });
}

function buildGroupCompareChart(canvasId, myMocks, groupMocks, existingChart) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === "undefined") return existingChart;
  if (existingChart) existingChart.destroy();

  const latestByStudent = {};
  groupMocks.forEach((m) => {
    const prev = latestByStudent[m.studentId];
    if (!prev || (m.date || "") >= (prev.date || "")) {
      latestByStudent[m.studentId] = m;
    }
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
        {
          label: "You (Latest Mock)",
          data: skills.map((k) => (myLatest ? Number(myLatest[k]) : 0)),
          backgroundColor: "#1d4ed8",
          borderRadius: 6
        },
        {
          label: "Group Average",
          data: skills.map((k) => avgSkill(k)),
          backgroundColor: "#94a3b8",
          borderRadius: 6
        },
        {
          label: "Group Highest",
          data: skills.map((k) => maxSkill(k)),
          backgroundColor: "#16a34a",
          borderRadius: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { min: 4.0, max: 9.0, ticks: { stepSize: 0.5 } }
      },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } }
      }
    }
  });
}

function renderMistakeBars(containerId, mistakesObj, emptyText, barColor = "var(--danger)") {
  const container = document.getElementById(containerId);
  if (!container) return;

  const entries = Object.entries(mistakesObj || {})
    .map(([type, val]) => ({ type, wrong: typeof val === "number" ? val : (val.wrong || 0) }))
    .filter((item) => item.wrong > 0)
    .sort((a, b) => b.wrong - a.wrong);

  if (entries.length === 0) {
    container.innerHTML = `<p class="muted">${emptyText}</p>`;
    return;
  }

  const maxWrong = Math.max(...entries.map((e) => e.wrong), 1);

  container.innerHTML = entries.map((item) => {
    const pct = Math.round((item.wrong / maxWrong) * 100);
    return `
      <div class="type-bar-row">
        <div class="type-bar-head">
          <span>${MISTAKE_LABELS[item.type] || item.type}</span>
          <span style="color:${barColor};">${item.wrong} mistake${item.wrong > 1 ? "s" : ""}</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%;background:${barColor};"></div>
        </div>
      </div>
    `;
  }).join("");
}

// ==========================================
// STUDENT: INITIALIZATION & ANKI ENGINE
// ==========================================
async function initStudentData() {
  const [usersSnap, progSnap, subsSnap, mocksSnap, annSnap] = await Promise.all([
    getDocs(collection(db, "users")),
    getDocs(query(collection(db, "ankiProgress"), where("studentId", "==", currentStudentId))),
    getDocs(query(collection(db, "submissions"), where("studentId", "==", currentStudentId))),
    getDocs(collection(db, "mockScores")),
    getDocs(collection(db, "announcements"))
  ]);

  allGroupUsers = [];
  usersSnap.forEach((d) => {
    if (d.data().role === "student") allGroupUsers.push(d.data());
  });

  const me = allGroupUsers.find((u) => u.studentId === currentStudentId);
  currentStudentProfile = me || { studentId: currentStudentId, fullName: currentStudentId, ankiStats: {}, permanentMistakes: {} };

  document.getElementById("user-display-name").textContent = currentStudentProfile.fullName;
  document.getElementById("welcome-student-name").textContent = currentStudentProfile.fullName;

  ankiProgressMap = {};
  progSnap.forEach((d) => { ankiProgressMap[d.data().cardId] = d.data(); });

  studentSubmissionsMap = {};
  subsSnap.forEach((d) => { studentSubmissionsMap[d.data().assignmentId] = d.data(); });

  allGroupMocks = [];
  mocksSnap.forEach((d) => allGroupMocks.push(d.data()));
  allGroupMocks.sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  studentMocksList = allGroupMocks.filter((m) => m.studentId === currentStudentId);

  const rawAnns = [];
  annSnap.forEach((d) => rawAnns.push({ docId: d.id, ...d.data() }));
  cachedAnnouncements = sortAnnouncementsList(rawAnns);

  bonusMode = false;
  selectedDeckId = "all";
  buildAnkiQueue();
  updateDashboardUI();
  renderStudentAnnouncements(cachedAnnouncements);
  renderAssignmentsList();
  renderResourcesList("all");
  renderStudentPunishmentsList();
}

function renderStudentAnnouncements(list) {
  const container = document.getElementById("student-announcements-feed");
  if (!container) return;

  if (list.length === 0) {
    container.innerHTML = `<p class="muted" style="margin-bottom:0;">No announcements from your teacher yet.</p>`;
    return;
  }

  container.innerHTML = list.map((ann) => `
    <div class="hw-item" style="flex-direction:column;align-items:stretch;${ann.pinned ? "border-left:4px solid var(--primary);background:#f8fafc;" : ""}">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        ${ann.pinned ? `<span class="badge badge-yellow">📌 Pinned</span>` : ""}
        <span class="badge ${getAnnouncementBadgeClass(ann.tag)}">${escapeHtml(ann.tag || "GENERAL")}</span>
        <strong>${escapeHtml(ann.title)}</strong>
        <span class="muted" style="font-size:12px;margin-left:auto;margin-bottom:0;">${formatAnnouncementDate(ann)}</span>
      </div>
      <p style="font-size:14px;white-space:pre-line;margin-top:8px;margin-bottom:0;color:var(--text);line-height:1.55;">${escapeHtml(ann.body)}</p>
    </div>
  `).join("");
}

function getFilteredVocabCards() {
  const all = [];
  VOCAB_DECKS.forEach((deck) => {
    if (selectedDeckId === "all" || deck.deckId === selectedDeckId) {
      deck.cards.forEach((c) => all.push({ ...c, deckId: deck.deckId, deckTitle: deck.title }));
    }
  });
  return all;
}

function getAllDueCountAcrossAllDecks() {
  const today = getTodayStr();
  let totalDue = 0;
  VOCAB_DECKS.forEach((deck) => {
    deck.cards.forEach((card) => {
      if (!ankiProgressMap[card.id] || ankiProgressMap[card.id].nextReviewDate <= today) {
        totalDue++;
      }
    });
  });
  return totalDue;
}

function populateAnkiDeckDropdown() {
  const sel = document.getElementById("anki-deck-select");
  if (!sel) return;
  const today = getTodayStr();

  const totalDue = getAllDueCountAcrossAllDecks();
  const optionsHtml = [
    `<option value="all" ${selectedDeckId === "all" ? "selected" : ""}>All Decks (${totalDue} due)</option>`
  ];

  VOCAB_DECKS.forEach((deck) => {
    const deckDue = deck.cards.filter(
      (c) => !ankiProgressMap[c.id] || ankiProgressMap[c.id].nextReviewDate <= today
    ).length;
    optionsHtml.push(
      `<option value="${escapeHtml(deck.deckId)}" ${selectedDeckId === deck.deckId ? "selected" : ""}>${escapeHtml(deck.title)} (${deckDue} due)</option>`
    );
  });

  sel.innerHTML = optionsHtml.join("");
}

function speakEnglishText(rawText, isWord = true) {
  if (!("speechSynthesis" in window) || !rawText) return;
  window.speechSynthesis.cancel();

  let clean = rawText;
  if (isWord) {
    clean = clean
      .replace(/\((adj|adv|n|v|phr|prep)\.\)/gi, "")
      .replace(/\s*\/\s*/g, ", ")
      .trim();
  }

  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = "en-GB";
  utterance.rate = isWord ? 0.92 : 0.96;

  const voices = window.speechSynthesis.getVoices();
  const preferredVoice =
    voices.find((v) => v.lang.startsWith("en-GB") && v.name.includes("Google")) ||
    voices.find((v) => v.lang.startsWith("en-GB")) ||
    voices.find((v) => v.lang.startsWith("en-"));
  if (preferredVoice) utterance.voice = preferredVoice;

  window.speechSynthesis.speak(utterance);
}

const deckSelectEl = document.getElementById("anki-deck-select");
if (deckSelectEl) {
  deckSelectEl.addEventListener("change", (e) => {
    selectedDeckId = e.target.value;
    bonusMode = false;
    buildAnkiQueue();
  });
}

const speakWordBtn = document.getElementById("speak-word-btn");
if (speakWordBtn) {
  speakWordBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (currentCard) speakEnglishText(currentCard.word, true);
  });
}

const speakExampleBtn = document.getElementById("speak-example-btn");
if (speakExampleBtn) {
  speakExampleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (currentCard) speakEnglishText(currentCard.example, false);
  });
}

function buildAnkiQueue() {
  populateAnkiDeckDropdown();
  const filteredCards = getFilteredVocabCards();
  const today = getTodayStr();
  ankiQueue = bonusMode
    ? [...filteredCards]
    : filteredCards.filter((card) => !ankiProgressMap[card.id] || ankiProgressMap[card.id].nextReviewDate <= today);
  renderNextAnkiCard();
}

function updateDashboardUI() {
  const totalDue = getAllDueCountAcrossAllDecks();
  const stats = currentStudentProfile.ankiStats || {};
  const today = getTodayStr();
  const yesterday = getTodayStr(-1);

  let activeStreak = stats.streak || 0;
  if (stats.lastReviewedDate && stats.lastReviewedDate < yesterday) activeStreak = 0;
  const todayCount = stats.lastReviewedDate === today ? (stats.todayCount || 0) : 0;

  const pendingHw = ASSIGNMENTS.filter((a) => !studentSubmissionsMap[a.id]).length;

  document.getElementById("nav-due-badge").textContent = totalDue;
  document.getElementById("nav-hw-badge").textContent = pendingHw;
  document.getElementById("dash-due-count").textContent = totalDue;
  document.getElementById("dash-streak-count").textContent = `🔥 ${activeStreak} days`;
  document.getElementById("dash-today-done").textContent = `${todayCount} reviewed today`;
  document.getElementById("dash-hw-pending").textContent = pendingHw;

  if (studentMocksList.length > 0) {
    const latest = studentMocksList[studentMocksList.length - 1];
    document.getElementById("dash-latest-band").textContent = `Band ${latest.overall}`;
  } else {
    document.getElementById("dash-latest-band").textContent = "—";
  }
}

// ==========================================
// DEDICATED STATISTICS & GROUP COMPARISON PAGE
// ==========================================
function renderStatisticsPage() {
  const subsArr = Object.values(studentSubmissionsMap);

  studentChartInstance = buildScoreChart("student-score-chart", subsArr, studentMocksList, studentChartInstance);
  groupCompareChartInstance = buildGroupCompareChart("group-compare-chart", studentMocksList, allGroupMocks, groupCompareChartInstance);

  renderMistakeBars(
    "dash-permanent-mistakes",
    currentStudentProfile.permanentMistakes || {},
    "No question-type mistakes logged yet.",
    "var(--danger)"
  );

  const groupMistakeTotals = {};
  allGroupUsers.forEach((u) => {
    Object.entries(u.permanentMistakes || {}).forEach(([type, val]) => {
      const count = val.wrong || 0;
      if (count > 0) {
        groupMistakeTotals[type] = (groupMistakeTotals[type] || 0) + count;
      }
    });
  });

  renderMistakeBars(
    "group-common-mistakes",
    groupMistakeTotals,
    "No group mistake data logged yet.",
    "var(--warning)"
  );

  const yesterday = getTodayStr(-1);
  const rankedStudents = allGroupUsers.map((u) => {
    const st = u.ankiStats || {};
    const liveStreak = (st.lastReviewedDate && st.lastReviewedDate >= yesterday) ? (st.streak || 0) : 0;
    return {
      studentId: u.studentId,
      fullName: u.fullName,
      streak: liveStreak,
      totalReviewed: st.totalReviewed || 0
    };
  }).sort((a, b) => (b.streak - a.streak) || (b.totalReviewed - a.totalReviewed));

  const lbBody = document.getElementById("effort-leaderboard-tbody");
  lbBody.innerHTML = rankedStudents.map((s, idx) => {
    const isMe = s.studentId === currentStudentId;
    const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `#${idx + 1}`;
    return `
      <tr style="${isMe ? "background:#eff6ff;" : ""}">
        <td><strong>${medal}</strong></td>
        <td>${escapeHtml(s.fullName)} ${isMe ? `<span class="badge badge-blue" style="margin-left:4px;">You</span>` : ""}</td>
        <td>🔥 ${s.streak} days</td>
        <td>${s.totalReviewed} cards</td>
      </tr>
    `;
  }).join("");

  const feedbackItems = subsArr.filter((sub) => sub.teacherFeedback || sub.status === "graded");
  const fbContainer = document.getElementById("teacher-feedback-feed");

  if (feedbackItems.length === 0) {
    fbContainer.innerHTML = `<p class="muted">No teacher feedback yet. Once your teacher reviews your submissions, comments will appear here.</p>`;
  } else {
    fbContainer.innerHTML = feedbackItems.map((sub) => {
      const hw = ASSIGNMENTS.find((a) => a.id === sub.assignmentId);
      const title = hw ? hw.title : sub.assignmentId;
      const bandPill = sub.bandScore ? `<span class="badge badge-green">Band ${sub.bandScore}</span>` : `<span class="badge badge-green">Checked</span>`;
      return `
        <div class="hw-item" style="flex-direction:column;align-items:stretch;padding:14px 16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <strong>${escapeHtml(title)}</strong>
            ${bandPill}
          </div>
          ${sub.teacherFeedback
            ? `<div class="feedback-callout" style="margin-top:8px;">${escapeHtml(sub.teacherFeedback)}</div>`
            : `<span class="muted" style="font-size:13px;margin-top:4px;margin-bottom:0;">Verified by teacher (no written note).</span>`}
        </div>
      `;
    }).join("");
  }

  const mocksTbody = document.getElementById("student-mocks-tbody");
  if (studentMocksList.length === 0) {
    mocksTbody.innerHTML = `<tr><td colspan="7" class="muted center">No mock exam scores recorded yet.</td></tr>`;
  } else {
    mocksTbody.innerHTML = [...studentMocksList].reverse().map((m) => `
      <tr>
        <td>${m.date || "—"}</td>
        <td><strong>${escapeHtml(m.mockTitle)}</strong></td>
        <td>${m.listening}</td>
        <td>${m.reading}</td>
        <td>${m.writing}</td>
        <td>${m.speaking}</td>
        <td><span class="badge badge-blue">Band ${m.overall}</span></td>
      </tr>
    `).join("");
  }
}

function renderNextAnkiCard() {
  const stage = document.getElementById("anki-stage");
  const doneState = document.getElementById("anki-done-state");
  const subtitle = document.getElementById("anki-deck-subtitle");

  let newCnt = 0;
  let revCnt = 0;
  ankiQueue.forEach((c) => (!ankiProgressMap[c.id] ? newCnt++ : revCnt++));
  document.getElementById("anki-new-count").textContent = newCnt;
  document.getElementById("anki-review-count").textContent = revCnt;

  if (ankiQueue.length === 0) {
    stage.classList.add("hidden");
    doneState.classList.remove("hidden");
    subtitle.textContent = "Daily goal complete!";
    bonusMode = false;
    updateDashboardUI();
    return;
  }

  stage.classList.remove("hidden");
  doneState.classList.add("hidden");
  subtitle.textContent = bonusMode ? "Bonus Practice Mode" : `${ankiQueue.length} card(s) remaining in this session`;

  currentCard = ankiQueue[0];
  isCardFlipped = false;

  document.getElementById("card-lesson-tag").textContent = currentCard.deckTitle;
  document.getElementById("card-word").textContent = currentCard.word;
  document.getElementById("card-definition").textContent = currentCard.definition;
  document.getElementById("card-example").textContent = `"${currentCard.example}"`;

  document.getElementById("card-back").classList.add("hidden");
  document.getElementById("anki-reveal-bar").classList.remove("hidden");
  document.getElementById("anki-rate-bar").classList.add("hidden");

  const prev = ankiProgressMap[currentCard.id] || { repetitions: 0, interval: 0, easeFactor: 2.5 };
  const goodDays = calcSM2(prev, 3).interval;
  const easyDays = calcSM2(prev, 4).interval;
  document.getElementById("lbl-hard").textContent = "1 day";
  document.getElementById("lbl-good").textContent = `${goodDays} day${goodDays > 1 ? "s" : ""}`;
  document.getElementById("lbl-easy").textContent = `${easyDays} day${easyDays > 1 ? "s" : ""}`;
}

function flipFlashcard() {
  if (!currentCard || isCardFlipped) return;
  isCardFlipped = true;
  document.getElementById("card-back").classList.remove("hidden");
  document.getElementById("anki-reveal-bar").classList.add("hidden");
  document.getElementById("anki-rate-bar").classList.remove("hidden");
}

document.getElementById("flashcard").addEventListener("click", flipFlashcard);
document.getElementById("show-answer-btn").addEventListener("click", flipFlashcard);

document.addEventListener("keydown", (e) => {
  const ankiSection = document.getElementById("student-anki");
  if (ankiSection.classList.contains("hidden") || !currentCard) return;

  if (e.code === "Space") {
    e.preventDefault();
    flipFlashcard();
  } else if (e.key.toLowerCase() === "r") {
    e.preventDefault();
    speakEnglishText(currentCard.word, true);
  } else if (isCardFlipped && ["1", "2", "3", "4"].includes(e.key)) {
    gradeCurrentCard(Number(e.key));
  }
});

function calcSM2(prev, quality) {
  let repetitions = prev.repetitions || 0;
  let interval = prev.interval || 0;
  let easeFactor = prev.easeFactor || 2.5;

  if (quality === 1) {
    repetitions = 0;
    interval = 0;
  } else if (quality === 2) {
    repetitions = Math.max(1, repetitions);
    interval = 1;
    easeFactor = Math.max(1.3, easeFactor - 0.15);
  } else if (quality === 3) {
    if (repetitions === 0) interval = 1;
    else if (repetitions === 1) interval = 6;
    else interval = Math.round(interval * easeFactor);
    repetitions += 1;
  } else if (quality === 4) {
    if (repetitions === 0) interval = 4;
    else if (repetitions === 1) interval = 8;
    else interval = Math.round(interval * easeFactor * 1.3);
    repetitions += 1;
    easeFactor += 0.15;
  }

  return {
    repetitions,
    interval,
    easeFactor: Number(easeFactor.toFixed(2)),
    nextReviewDate: getTodayStr(interval)
  };
}

async function gradeCurrentCard(quality) {
  if (!currentCard) return;
  const card = ankiQueue.shift();

  if (quality === 1) {
    const insertIdx = Math.min(2, ankiQueue.length);
    ankiQueue.splice(insertIdx, 0, card);
  }

  if (!bonusMode) {
    const prev = ankiProgressMap[card.id] || { repetitions: 0, interval: 0, easeFactor: 2.5 };
    const updated = calcSM2(prev, quality);
    ankiProgressMap[card.id] = { studentId: currentStudentId, cardId: card.id, ...updated };

    await setDoc(doc(db, "ankiProgress", `${currentStudentId}_${card.id}`), ankiProgressMap[card.id]);

    const today = getTodayStr();
    const yesterday = getTodayStr(-1);
    const stats = currentStudentProfile.ankiStats || { streak: 0, lastReviewedDate: null, todayCount: 0, totalReviewed: 0 };

    let newStreak = stats.streak || 0;
    let newTodayCount = 1;

    if (stats.lastReviewedDate === today) {
      newTodayCount = (stats.todayCount || 0) + 1;
      if (newStreak === 0) newStreak = 1;
    } else if (stats.lastReviewedDate === yesterday) {
      newStreak += 1;
    } else {
      newStreak = 1;
    }

    const updatedStats = {
      streak: newStreak,
      lastReviewedDate: today,
      todayCount: newTodayCount,
      totalReviewed: (stats.totalReviewed || 0) + 1
    };
    currentStudentProfile.ankiStats = updatedStats;

    await updateDoc(doc(db, "users", currentStudentId), { ankiStats: updatedStats });
  }

  populateAnkiDeckDropdown();
  updateDashboardUI();
  renderNextAnkiCard();
}

document.querySelectorAll(".rate-btn").forEach((btn) => {
  btn.addEventListener("click", () => gradeCurrentCard(Number(btn.dataset.quality)));
});
document.getElementById("practice-all-btn").addEventListener("click", () => {
  bonusMode = true;
  buildAnkiQueue();
});

// ==========================================
// STUDENT: HOMEWORK SYSTEM
// ==========================================
function showHomeworkListView() {
  stopActiveRecordingCleanup();
  document.getElementById("hw-list-view").classList.remove("hidden");
  document.getElementById("hw-runner-view").classList.add("hidden");
  document.getElementById("hw-analysis-view").classList.add("hidden");
  renderAssignmentsList();
}

document.getElementById("back-to-hw-btn").addEventListener("click", showHomeworkListView);
document.getElementById("back-from-analysis-btn").addEventListener("click", showHomeworkListView);

let hwViewFilter = "todo";

function renderAssignmentsList() {
  const container = document.getElementById("assignments-list-container");
  const now = new Date();

  const todoList = ASSIGNMENTS.filter((hw) => !studentSubmissionsMap[hw.id]);
  const doneList = ASSIGNMENTS.filter((hw) => !!studentSubmissionsMap[hw.id]);

  const filterControls = `
    <div style="display:flex;gap:8px;margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:12px;">
      <button class="btn ${hwViewFilter === "todo" ? "btn-primary" : "btn-outline"} btn-sm" id="btn-hw-todo">
        To Do (${todoList.length})
      </button>
      <button class="btn ${hwViewFilter === "completed" ? "btn-primary" : "btn-outline"} btn-sm" id="btn-hw-done">
        Completed & Graded (${doneList.length})
      </button>
    </div>
  `;

  const activeList = hwViewFilter === "todo" ? todoList : doneList;

  if (activeList.length === 0) {
    container.innerHTML = filterControls + (hwViewFilter === "todo"
      ? `<p class="muted center" style="padding:24px 0;">🎉 All assignments completed! Switch to "Completed & Graded" to view your past work.</p>`
      : `<p class="muted center" style="padding:24px 0;">No completed assignments yet.</p>`);
    attachHwFilterListeners();
    return;
  }

  const grouped = {};
  activeList.forEach((hw) => {
    const wk = hw.week || "Current Assignments";
    if (!grouped[wk]) grouped[wk] = [];
    grouped[wk].push(hw);
  });

  const groupsHtml = Object.entries(grouped).map(([weekTitle, items]) => {
    const cardsHtml = items.map((hw) => {
      const sub = studentSubmissionsMap[hw.id];
      const isPastDue = now > new Date(hw.dueDate);

      let statusBadge = "";
      let actionBtn = "";
      let feedbackHtml = "";

      if (sub) {
        if (sub.status === "graded") {
          statusBadge = sub.bandScore
            ? `<span class="badge badge-green">Verified: Band ${sub.bandScore}</span>`
            : `<span class="badge badge-green">Checked by Teacher</span>`;
        } else if (sub.isLate) {
          statusBadge = `<span class="badge badge-red">Submitted Late${sub.bandScore ? ` • Band ${sub.bandScore}` : ""}</span>`;
        } else {
          statusBadge = `<span class="badge badge-blue">Submitted${sub.bandScore ? ` • Band ${sub.bandScore}` : ""}</span>`;
        }

        if (sub.teacherFeedback) {
          feedbackHtml = `<div class="feedback-callout"><strong>Teacher Feedback:</strong> ${escapeHtml(sub.teacherFeedback)}</div>`;
        }

        if (hw.skill === "reading" || hw.skill === "listening") {
          actionBtn = `<button class="btn btn-outline btn-sm" onclick="window.openAnalysisPage('${hw.id}')">View Receipt</button>`;
        } else {
          actionBtn = `<span class="muted" style="font-size:13px;margin:0;">Submitted</span>`;
        }
      } else {
        statusBadge = isPastDue
          ? `<span class="badge badge-gray">Missing (Past Due)</span>`
          : `<span class="badge badge-yellow">Due ${formatDueDate(hw.dueDate)}</span>`;

        actionBtn = `<button class="btn btn-primary btn-sm" onclick="window.startAssignment('${hw.id}')">Submit Homework</button>`;
      }

      return `
        <div class="hw-item">
          <div style="flex:1;min-width:240px;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span class="role-pill">${hw.skill.toUpperCase()}</span>
              <strong>${hw.title}</strong>
            </div>
            <div class="hw-meta">
              <span>Deadline: ${formatDueDate(hw.dueDate)}</span>
              ${statusBadge}
            </div>
            ${feedbackHtml}
          </div>
          <div>${actionBtn}</div>
        </div>
      `;
    }).join("");

    return `
      <div style="margin-bottom:18px;">
        <h3 style="font-size:14px;color:var(--primary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">${escapeHtml(weekTitle)}</h3>
        <div style="display:flex;flex-direction:column;gap:12px;">${cardsHtml}</div>
      </div>
    `;
  }).join("");

  container.innerHTML = filterControls + groupsHtml;
  attachHwFilterListeners();
}

function attachHwFilterListeners() {
  const todoBtn = document.getElementById("btn-hw-todo");
  const doneBtn = document.getElementById("btn-hw-done");
  if (todoBtn) todoBtn.addEventListener("click", () => { hwViewFilter = "todo"; renderAssignmentsList(); });
  if (doneBtn) doneBtn.addEventListener("click", () => { hwViewFilter = "completed"; renderAssignmentsList(); });
}

window.startAssignment = function (assignmentId) {
  const hw = ASSIGNMENTS.find((a) => a.id === assignmentId);
  if (!hw) return;

  document.getElementById("hw-list-view").classList.add("hidden");
  document.getElementById("hw-analysis-view").classList.add("hidden");
  document.getElementById("hw-runner-view").classList.remove("hidden");

  document.getElementById("runner-title").textContent = hw.title;
  document.getElementById("runner-due-badge").textContent = `Due: ${formatDueDate(hw.dueDate)}`;

  const leftPane = document.getElementById("runner-prompt-pane");
  const rightPane = document.getElementById("runner-work-pane");

  if (hw.skill === "reading" || hw.skill === "listening") {
    const isDrill = Boolean(hw.isDrill);

    if (isDrill) {
      const drillTypes = hw.drillTypes || [
        { key: "TFNG", label: "True / False / Not Given" },
        { key: "YNNG", label: "Yes / No / Not Given" }
      ];

      leftPane.innerHTML = `
        <h3>Drill Instructions</h3>
        <p class="passage-box" style="margin-bottom:16px;">${escapeHtml(hw.instructions || "Complete the assigned drill, take a screenshot of your result, and enter your correct answers out of total questions for each section below.")}</p>
        <div style="background:#f8fafc;border:1px solid var(--border);padding:14px;border-radius:8px;font-size:13px;">
          <strong>How this works:</strong><br/>
          Enter how many questions you got right and how many total questions you completed for each question type. Mistakes are automatically calculated and added to your weakness profile.
        </div>
      `;

      const drillRowsHtml = drillTypes.map((item) => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;">
          <span style="font-size:14px;font-weight:600;">${item.label}</span>
          <div style="display:flex;align-items:center;gap:8px;">
            <input type="number" class="drill-correct-input" data-type="${item.key}" min="0" placeholder="Correct" style="width:84px;padding:6px 8px;text-align:center;" required />
            <span style="font-weight:700;color:var(--muted);">/</span>
            <input type="number" class="drill-total-input" data-type="${item.key}" min="0" placeholder="Total" style="width:84px;padding:6px 8px;text-align:center;" required />
          </div>
        </div>
      `).join("");

      rightPane.innerHTML = `
        <h3>Submit Drill Score & Screenshot</h3>
        <div class="form-group">
          <label for="lr-screenshot-file">Upload Result Screenshot (PNG / JPG)</label>
          <input type="file" id="lr-screenshot-file" accept="image/*" required />
        </div>

        <div class="form-group">
          <label>Score Breakdown (Correct / Total Questions)</label>
          <div style="border:1px solid var(--border);border-radius:8px;padding:2px 14px;">
            ${drillRowsHtml}
          </div>
        </div>

        <button class="btn btn-primary btn-full" id="submit-lr-btn">Upload Screenshot & Submit Drill</button>
      `;

      document.getElementById("submit-lr-btn").addEventListener("click", () => submitScreenshotHomework(hw));
    } else {
      const totalQ = hw.totalQuestions || 40;
      const mistakeTypes = hw.skill === "reading"
        ? [
            { key: "TFNG", label: "True / False / Not Given" },
            { key: "YNNG", label: "Yes / No / Not Given" },
            { key: "MATCHING_HEADINGS", label: "Matching Headings" },
            { key: "MCQ", label: "Multiple Choice" },
            { key: "GAP_FILL", label: "Summary / Note / Table Completion" },
            { key: "MATCHING_INFO", label: "Matching Information / Features" }
          ]
        : [
            { key: "MCQ", label: "Multiple Choice (Single & Multiple-Answer)" },
            { key: "MATCHING", label: "Matching" },
            { key: "MAP_DIAGRAM", label: "Plan, Map, or Diagram Labelling" },
            { key: "FORM_NOTE_TABLE_SUMMARY", label: "Form, Note, Table, Flow-Chart, or Summary Completion" },
            { key: "SENTENCE_COMPLETION", label: "Sentence Completion" },
            { key: "SHORT_ANSWER", label: "Short-Answer Questions" }
          ];

      leftPane.innerHTML = `
        <h3>Instructions</h3>
        <p class="passage-box" style="margin-bottom:16px;">${escapeHtml(hw.instructions || "Complete the assigned test, take a screenshot of your final score screen, and submit your score below.")}</p>
        <div style="background:#f8fafc;border:1px solid var(--border);padding:14px;border-radius:8px;font-size:13px;">
          <strong>How to log your mistakes:</strong><br/>
          Count how many questions you missed in each category and enter the number on the right (leave 0 if none). This builds your permanent IELTS weakness profile!
        </div>
      `;

      const mistakeInputsHtml = mistakeTypes.map((item) => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);">
          <span style="font-size:13px;font-weight:600;line-height:1.35;">${item.label}</span>
          <input type="number" class="mistake-type-input" data-type="${item.key}" min="0" max="${totalQ}" value="0" style="width:72px;flex-shrink:0;padding:6px 8px;text-align:center;" />
        </div>
      `).join("");

      rightPane.innerHTML = `
        <h3>Submit Score & Screenshot</h3>
        <div class="form-group">
          <label for="lr-raw-score">Your Correct Answers (out of ${totalQ})</label>
          <input type="number" id="lr-raw-score" min="0" max="${totalQ}" placeholder="e.g., 27" required />
        </div>

        <div class="form-group">
          <label for="lr-screenshot-file">Upload Result Screenshot (PNG / JPG)</label>
          <input type="file" id="lr-screenshot-file" accept="image/*" required />
        </div>

        <div class="form-group">
          <label>Mistakes by Question Type</label>
          <div style="border:1px solid var(--border);border-radius:8px;padding:2px 12px;">
            ${mistakeInputsHtml}
          </div>
        </div>

        <button class="btn btn-primary btn-full" id="submit-lr-btn">Upload Screenshot & Submit Score</button>
      `;

      document.getElementById("submit-lr-btn").addEventListener("click", () => submitScreenshotHomework(hw));
    }
  } else if (hw.skill === "writing") {
    leftPane.innerHTML = `
      <h3>Writing Prompt & Guidelines</h3>
      <div class="passage-box" style="white-space:pre-line;margin-bottom:16px;">${escapeHtml(hw.promptText || hw.instructions)}</div>
    `;

    const chartUploadHtml = hw.id === "HW-05" ? `
      <div class="form-group">
        <label for="writing-chart-file">Upload Line Graph / Chart Image (Required)</label>
        <input type="file" id="writing-chart-file" accept="image/*" required />
      </div>
    ` : "";

    rightPane.innerHTML = `
      <h3>Your Essay / Report Response</h3>
      ${chartUploadHtml}
      <div class="form-group">
        <label for="writing-essay-input">Type your response here (min ${hw.minWords || 150} words)</label>
        <textarea id="writing-essay-input" rows="12" placeholder="Start writing your report or essay here..." style="width:100%;padding:10px;font-family:inherit;font-size:14px;border:1px solid var(--border);border-radius:8px;"></textarea>
      </div>
      <button class="btn btn-primary btn-full" id="submit-writing-btn">Submit Writing</button>
    `;

    document.getElementById("submit-writing-btn").addEventListener("click", () => submitWritingHomework(hw));
  } else if (hw.skill === "speaking") {
    leftPane.innerHTML = `
      <h3>Speaking Instructions</h3>
      <p class="passage-box" style="white-space:pre-line;margin-bottom:16px;">${escapeHtml(hw.instructions)}</p>
      <div style="background:#f8fafc;border:1px solid var(--border);padding:14px;border-radius:8px;font-size:13px;">
        <strong>Recording Tips:</strong><br/>
        Find a quiet room, click "Start Recording", speak clearly into your microphone, and listen to your playback before submitting.
      </div>
    `;

    rightPane.innerHTML = `
      <h3>Record Speaking Response</h3>
      <div style="text-align:center;padding:24px 0;">
        <div id="rec-status-label" style="font-weight:600;margin-bottom:12px;">Ready to record</div>
        <div id="rec-timer-display" style="font-size:32px;font-weight:700;font-family:monospace;margin-bottom:16px;">00:00</div>
        <div style="display:flex;justify-content:center;gap:12px;margin-bottom:20px;">
          <button class="btn btn-primary" id="btn-start-rec" onclick="startBrowserRecording()">🔴 Start Recording</button>
          <button class="btn btn-outline hidden" id="btn-stop-rec" onclick="stopBrowserRecording()" style="color:var(--danger);border-color:#fecaca;">⏹ Stop Recording</button>
        </div>
        <div id="rec-preview-area" class="hidden" style="margin-top:16px;">
          <audio id="rec-audio-preview" controls style="width:100%;"></audio>
        </div>
      </div>
      <button class="btn btn-primary btn-full" id="submit-speaking-btn" onclick="submitSpeakingHomework(hw)">Upload & Submit Recording</button>
    `;
  } else if (hw.skill === "grammar") {
    leftPane.innerHTML = `
      <h3>Grammar Workbook Instructions</h3>
      <p class="passage-box" style="white-space:pre-line;margin-bottom:16px;">${escapeHtml(hw.instructions)}</p>
    `;

    rightPane.innerHTML = `
      <h3>Upload Completed Pages</h3>
      <div class="form-group">
        <label for="gram-file">Workbook Photo / Screenshot</label>
        <input type="file" id="gram-file" accept="image/*" required />
      </div>
      <div class="form-group">
        <label for="gram-notes">Student Notes / Questions (Optional)</label>
        <input type="text" id="gram-notes" placeholder="e.g., Had trouble with exercise 4..." />
      </div>
      <button class="btn btn-primary btn-full" id="submit-gram-btn">Upload & Submit Grammar Homework</button>
    `;

    document.getElementById("submit-gram-btn").addEventListener("click", () => submitGrammarHomework(hw));
  }
};

async function submitScreenshotHomework(hw) {
  const isDrill = Boolean(hw.isDrill);
  const fileInput = document.getElementById("lr-screenshot-file");
  const file = fileInput.files[0];

  if (!file) {
    return alert("Please attach a screenshot of your test result.");
  }

  let rawVal = 0;
  let totalQ = hw.totalQuestions || 40;
  const mistakeCounts = {};
  const drillBreakdown = {};
  const updatedMistakes = { ...(currentStudentProfile.permanentMistakes || {}) };

  if (isDrill) {
    let sumCorrect = 0;
    let sumTotal = 0;
    const correctInputs = document.querySelectorAll(".drill-correct-input");

    for (const cInp of correctInputs) {
      const type = cInp.dataset.type;
      const tInp = document.querySelector(`.drill-total-input[data-type="${type}"]`);
      const label = MISTAKE_LABELS[type] || type;

      if (cInp.value === "" || tInp.value === "") {
        return alert(`Please enter both Correct and Total questions for ${label}.`);
      }

      const correctNum = Number(cInp.value);
      const totalNum = Number(tInp.value);

      if (isNaN(correctNum) || isNaN(totalNum) || correctNum < 0 || totalNum < 0 || correctNum > totalNum) {
        return alert(`Invalid numbers for ${label}: Correct (${correctNum}) cannot exceed Total (${totalNum}).`);
      }

      const wrongNum = totalNum - correctNum;
      sumCorrect += correctNum;
      sumTotal += totalNum;
      drillBreakdown[type] = { correct: correctNum, total: totalNum };
      mistakeCounts[type] = wrongNum;

      if (wrongNum > 0) {
        if (!updatedMistakes[type]) updatedMistakes[type] = { wrong: 0 };
        updatedMistakes[type].wrong = (updatedMistakes[type].wrong || 0) + wrongNum;
      }
    }

    if (sumTotal === 0) {
      return alert("Total questions across sections must be greater than 0.");
    }

    rawVal = sumCorrect;
    totalQ = sumTotal;
  } else {
    rawVal = Number(document.getElementById("lr-raw-score").value);
    if (isNaN(rawVal) || document.getElementById("lr-raw-score").value === "" || rawVal < 0 || rawVal > totalQ) {
      return alert(`Please enter a valid score between 0 and ${totalQ}.`);
    }

    document.querySelectorAll(".mistake-type-input").forEach((inp) => {
      const type = inp.dataset.type;
      const wrongNum = Math.max(0, Number(inp.value) || 0);
      mistakeCounts[type] = wrongNum;

      if (wrongNum > 0) {
        if (!updatedMistakes[type]) updatedMistakes[type] = { wrong: 0 };
        updatedMistakes[type].wrong = (updatedMistakes[type].wrong || 0) + wrongNum;
      }
    });
  }

  const btn = document.getElementById("submit-lr-btn");
  btn.disabled = true;
  btn.textContent = "Uploading screenshot...";

  try {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
      method: "POST",
      body: formData
    });
    const data = await res.json();
    if (!data.secure_url) throw new Error(data.error?.message || "Screenshot upload failed");

    const isRealPracticeTest = !isDrill && totalQ === 40;
    const bandScore = isRealPracticeTest ? rawToIeltsBand(rawVal, 40) : null;
    const isLate = new Date() > new Date(hw.dueDate);

    const submissionData = {
      assignmentId: hw.id,
      studentId: currentStudentId,
      skill: hw.skill,
      isDrill: !isRealPracticeTest,
      status: "submitted",
      isLate,
      submittedAt: serverTimestamp(),
      rawScore: rawVal,
      totalQuestions: totalQ,
      bandScore,
      screenshotUrl: data.secure_url,
      mistakeCounts,
      drillBreakdown
    };

    await Promise.all([
      setDoc(doc(db, "submissions", `${hw.id}_${currentStudentId}`), submissionData),
      updateDoc(doc(db, "users", currentStudentId), { permanentMistakes: updatedMistakes })
    ]);

    currentStudentProfile.permanentMistakes = updatedMistakes;
    studentSubmissionsMap[hw.id] = submissionData;
    updateDashboardUI();
    window.openAnalysisPage(hw.id);
  } catch (err) {
    alert("Upload error: " + err.message);
    btn.disabled = false;
    btn.textContent = isDrill ? "Upload Screenshot & Submit Drill" : "Upload Screenshot & Submit Score";
  }
}

window.openAnalysisPage = function (assignmentId) {
  const hw = ASSIGNMENTS.find((a) => a.id === assignmentId);
  const sub = studentSubmissionsMap[assignmentId];
  if (!hw || !sub) return;

  document.getElementById("hw-list-view").classList.add("hidden");
  document.getElementById("hw-runner-view").classList.add("hidden");
  document.getElementById("hw-analysis-view").classList.remove("hidden");

  document.getElementById("analysis-title").textContent = `${hw.title} — Submission`;
  const pill = document.getElementById("analysis-status-pill");
  pill.textContent = sub.isLate ? "Submitted Late" : "Submitted On Time";
  pill.className = sub.isLate ? "badge badge-red" : "badge badge-green";

  const pct = Math.round((sub.rawScore / sub.totalQuestions) * 100);
  document.getElementById("ana-raw-score").textContent = `${sub.rawScore} / ${sub.totalQuestions}`;
  document.getElementById("ana-band-score").textContent = sub.bandScore
    ? `Band ${sub.bandScore}`
    : "Practice Drill";
  document.getElementById("ana-accuracy").textContent = `${pct}%`;

  document.getElementById("ana-screenshot-box").innerHTML = sub.screenshotUrl
    ? `<a href="${sub.screenshotUrl}" target="_blank"><img src="${sub.screenshotUrl}" alt="Result Screenshot" style="width:100%;border-radius:8px;border:1px solid var(--border);" /></a>`
    : `<p class="muted">No screenshot attached.</p>`;

  const logged = Object.entries(sub.mistakeCounts || {}).filter(([, v]) => v > 0);
  document.getElementById("ana-type-breakdown").innerHTML = logged.length > 0
    ? logged.map(([type, count]) => `
        <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">
          <strong>${MISTAKE_LABELS[type] || type}</strong>
          <span class="badge badge-red">${count} mistake${count > 1 ? "s" : ""}</span>
        </div>
      `).join("")
    : `<p class="muted">No specific question-type mistakes logged for this test.</p>`;
};

async function submitWritingHomework(hw) {
  const text = document.getElementById("writing-essay-input").value.trim();
  const chartFile = document.getElementById("writing-chart-file")?.files[0];

  if (!text) return alert("Please write your essay or report before submitting.");
  if (hw.id === "HW-05" && !chartFile) {
    return alert("Please upload an image of the line graph you wrote about.");
  }

  const btn = document.getElementById("submit-writing-btn");
  btn.disabled = true;
  btn.textContent = chartFile ? "Uploading graph & submitting..." : "Submitting...";

  try {
    let chartImageUrl = null;
    if (chartFile) {
      const formData = new FormData();
      formData.append("file", chartFile);
      formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

      const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
        method: "POST",
        body: formData
      });
      const data = await res.json();
      if (!data.secure_url) throw new Error(data.error?.message || "Chart image upload failed");
      chartImageUrl = data.secure_url;
    }

    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const isLate = new Date() > new Date(hw.dueDate);

    const submissionData = {
      assignmentId: hw.id,
      studentId: currentStudentId,
      skill: "writing",
      status: "submitted",
      isLate,
      submittedAt: serverTimestamp(),
      essayText: text,
      wordCount,
      chartImageUrl
    };

    await setDoc(doc(db, "submissions", `${hw.id}_${currentStudentId}`), submissionData);
    studentSubmissionsMap[hw.id] = submissionData;
    updateDashboardUI();
    alert("Writing submitted successfully! Your teacher will review and grade it soon.");
    showHomeworkListView();
  } catch (err) {
    alert("Submission error: " + err.message);
    btn.disabled = false;
    btn.textContent = "Submit Writing";
  }
}

window.startBrowserRecording = async function () {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      recordedAudioBlob = new Blob(recordedChunks, { type: "audio/webm" });
      const audioUrl = URL.createObjectURL(recordedAudioBlob);
      const audioPrev = document.getElementById("rec-audio-preview");
      if (audioPrev) audioPrev.src = audioUrl;
      const previewArea = document.getElementById("rec-preview-area");
      if (previewArea) previewArea.classList.remove("hidden");
      stream.getTracks().forEach((track) => track.stop());
    };

    mediaRecorder.start();
    recSeconds = 0;
    const statusLabel = document.getElementById("rec-status-label");
    if (statusLabel) statusLabel.innerHTML = `<span class="rec-dot"></span> Recording in progress...`;
    const startBtn = document.getElementById("btn-start-rec");
    if (startBtn) startBtn.classList.add("hidden");
    const stopBtn = document.getElementById("btn-stop-rec");
    if (stopBtn) stopBtn.classList.remove("hidden");
    const previewArea = document.getElementById("rec-preview-area");
    if (previewArea) previewArea.classList.add("hidden");

    recInterval = setInterval(() => {
      recSeconds++;
      const mins = String(Math.floor(recSeconds / 60)).padStart(2, "0");
      const secs = String(recSeconds % 60).padStart(2, "0");
      const timerDisplay = document.getElementById("rec-timer-display");
      if (timerDisplay) timerDisplay.textContent = `${mins}:${secs}`;
    }, 1000);
  } catch (err) {
    alert("Microphone access denied. Please allow microphone permissions in your browser.");
  }
};

window.stopBrowserRecording = function () {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  clearInterval(recInterval);
  const statusLabel = document.getElementById("rec-status-label");
  if (statusLabel) statusLabel.textContent = "Recording captured — listen below or re-record";
  const stopBtn = document.getElementById("btn-stop-rec");
  if (stopBtn) stopBtn.classList.add("hidden");
  const startBtn = document.getElementById("btn-start-rec");
  if (startBtn) {
    startBtn.textContent = "↻ Re-record";
    startBtn.classList.remove("hidden");
  }
};

function stopActiveRecordingCleanup() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  clearInterval(recInterval);
}

window.submitSpeakingHomework = async function (hw) {
  if (!recordedAudioBlob) return alert("Please record your speaking answer first.");

  const btn = document.getElementById("submit-speaking-btn");
  btn.disabled = true;
  btn.textContent = "Uploading audio to cloud...";

  try {
    const formData = new FormData();
    formData.append("file", recordedAudioBlob, `${hw.id}_${currentStudentId}.webm`);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/video/upload`, {
      method: "POST",
      body: formData
    });
    const data = await res.json();
    if (!data.secure_url) throw new Error(data.error?.message || "Upload failed");

    const isLate = new Date() > new Date(hw.dueDate);
    const submissionData = {
      assignmentId: hw.id,
      studentId: currentStudentId,
      skill: "speaking",
      status: "submitted",
      isLate,
      submittedAt: serverTimestamp(),
      audioUrl: data.secure_url
    };

    await setDoc(doc(db, "submissions", `${hw.id}_${currentStudentId}`), submissionData);
    studentSubmissionsMap[hw.id] = submissionData;
    updateDashboardUI();
    alert("Speaking recording uploaded! Your teacher will listen and grade it soon.");
    showHomeworkListView();
  } catch (err) {
    alert("Audio upload error: " + err.message);
    btn.disabled = false;
    btn.textContent = "Upload & Submit Recording";
  }
};

async function submitGrammarHomework(hw) {
  const file = document.getElementById("gram-file").files[0];
  const notes = document.getElementById("gram-notes").value.trim();
  if (!file) return alert("Please select a photo or screenshot of your completed grammar pages.");

  const btn = document.getElementById("submit-gram-btn");
  btn.disabled = true;
  btn.textContent = "Uploading image...";

  try {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
      method: "POST",
      body: formData
    });
    const data = await res.json();
    if (!data.secure_url) throw new Error(data.error?.message || "Image upload failed");

    const isLate = new Date() > new Date(hw.dueDate);
    const submissionData = {
      assignmentId: hw.id,
      studentId: currentStudentId,
      skill: "grammar",
      status: "submitted",
      isLate,
      submittedAt: serverTimestamp(),
      screenshotUrl: data.secure_url,
      notes
    };

    await setDoc(doc(db, "submissions", `${hw.id}_${currentStudentId}`), submissionData);
    studentSubmissionsMap[hw.id] = submissionData;
    updateDashboardUI();
    alert("Grammar homework uploaded!");
    showHomeworkListView();
  } catch (err) {
    alert("Upload error: " + err.message);
    btn.disabled = false;
    btn.textContent = "Upload & Submit Grammar Homework";
  }
}

// ==========================================
// STUDENT PUNISHMENTS & EXTRAS WORKFLOW
// ==========================================
async function renderStudentPunishmentsList() {
  const container = document.getElementById("student-punishments-container");
  if (!container) return;

  const q = query(collection(db, "punishments"), where("studentId", "==", currentStudentId));
  const snap = await getDocs(q);
  const myPunishments = [];
  snap.forEach((d) => myPunishments.push(d.data()));

  const pendingCount = myPunishments.filter((p) => p.status !== "verified").length;
  const badgeEl = document.getElementById("nav-punishment-badge");
  if (badgeEl) badgeEl.textContent = pendingCount;

  if (myPunishments.length === 0) {
    container.innerHTML = `<p class="muted center" style="padding:32px 0;">🎉 You have no active punishments or extra practice assignments!</p>`;
    return;
  }

  container.innerHTML = myPunishments.map((p) => {
    let detailStr = "";
    if (p.skill === "listening" || p.skill === "reading") detailStr = `${p.details.testCount} test set(s)`;
    else if (p.skill === "speaking") detailStr = `${p.details.part} — ${p.details.quantity}`;
    else if (p.skill === "writing") detailStr = p.details.taskType;

    const statusBadge = p.status === "verified" ? `<span class="badge badge-green">Completed & Verified</span>`
      : p.status === "submitted" ? `<span class="badge badge-blue">Submitted (Pending Review)</span>`
      : `<span class="badge badge-red">Pending Due ${formatDueDate(p.dueDate)}</span>`;

    const actionBtn = p.status === "verified"
      ? `<span class="muted" style="font-size:13px;">Cleared</span>`
      : `<button class="btn btn-primary btn-sm" onclick="window.startPunishmentRunner('${p.id}')">Complete & Submit</button>`;

    return `
      <div class="hw-item">
        <div style="flex:1;">
          <span class="role-pill">${p.skill.toUpperCase()}</span>
          <strong>${escapeHtml(p.reason)}</strong>
          <div style="font-size:13px;color:var(--text);margin-top:4px;">Requirements: ${escapeHtml(detailStr)}</div>
          <div class="hw-meta" style="margin-top:6px;"><span>Deadline: ${formatDueDate(p.dueDate)}</span>${statusBadge}</div>
        </div>
        <div>${actionBtn}</div>
      </div>
    `;
  }).join("");
}

let activePunishment = null;

window.startPunishmentRunner = async function (punId) {
  const snap = await getDoc(doc(db, "punishments", punId));
  if (!snap.exists()) return;
  activePunishment = snap.data();

  const containerCard = document.getElementById("student-punishments-container")?.parentElement?.querySelector(".card");
  if (containerCard) containerCard.classList.add("hidden");
  const cont = document.getElementById("student-punishments-container");
  if (cont) cont.classList.add("hidden");
  const runnerView = document.getElementById("punishment-runner-view");
  if (runnerView) runnerView.classList.remove("hidden");

  const titleEl = document.getElementById("punishment-runner-title");
  if (titleEl) titleEl.textContent = activePunishment.reason;
  const dueEl = document.getElementById("punishment-runner-due");
  if (dueEl) dueEl.textContent = `Due: ${formatDueDate(activePunishment.dueDate)}`;

  const leftPane = document.getElementById("pun-runner-left");
  const rightPane = document.getElementById("pun-runner-right");

  if (leftPane) {
    leftPane.innerHTML = `
      <h3>Punishment Instructions</h3>
      <p class="passage-box">Complete your assigned ${activePunishment.skill.toUpperCase()} practice requirement and submit your proof below.</p>
      <div style="background:#f8fafc;border:1px solid var(--border);padding:14px;border-radius:8px;font-size:13px;margin-top:12px;">
        <strong>Requirements:</strong><br/>
        ${activePunishment.skill === "listening" || activePunishment.skill === "reading" ? `Complete ${activePunishment.details.testCount} test set(s) and upload your score screenshot.` : ""}
        ${activePunishment.skill === "speaking" ? `Record your answers for ${activePunishment.details.part} (${activePunishment.details.quantity}).` : ""}
        ${activePunishment.skill === "writing" ? `Write your essay for: ${activePunishment.details.taskType} (min 150 words for Task 1, min 250 words for Task 2).` : ""}
      </div>
    `;
  }

  if (rightPane) {
    if (activePunishment.skill === "listening" || activePunishment.skill === "reading") {
      rightPane.innerHTML = `
        <h3>Submit Score & Screenshot</h3>
        <div class="form-group">
          <label for="pun-lr-score">Correct Answers / Score Summary</label>
          <input type="text" id="pun-lr-score" placeholder="e.g., 34 / 40" required />
        </div>
        <div class="form-group">
          <label for="pun-lr-file">Result Screenshot (PNG / JPG)</label>
          <input type="file" id="pun-lr-file" accept="image/*" required />
        </div>
        <button class="btn btn-primary btn-full" id="submit-pun-lr-btn">Submit Punishment Proof</button>
      `;
      document.getElementById("submit-pun-lr-btn").addEventListener("click", submitPunishmentScreenshot);
    } else if (activePunishment.skill === "speaking") {
      rightPane.innerHTML = `
        <h3>Record Speaking Answer</h3>
        <div style="text-align:center;padding:24px 0;">
          <div id="rec-status-label" style="font-weight:600;margin-bottom:12px;">Ready to record</div>
          <div id="rec-timer-display" style="font-size:32px;font-weight:700;font-family:monospace;margin-bottom:16px;">00:00</div>
          <div style="display:flex;justify-content:center;gap:12px;margin-bottom:20px;">
            <button class="btn btn-primary" id="btn-start-rec" onclick="startBrowserRecording()">🔴 Start Recording</button>
            <button class="btn btn-outline hidden" id="btn-stop-rec" onclick="stopBrowserRecording()" style="color:var(--danger);border-color:#fecaca;">⏹ Stop Recording</button>
          </div>
          <div id="rec-preview-area" class="hidden" style="margin-top:16px;">
            <audio id="rec-audio-preview" controls style="width:100%;"></audio>
          </div>
        </div>
        <button class="btn btn-primary btn-full" onclick="submitPunishmentAudio()">Upload & Submit Speaking</button>
      `;
    } else if (activePunishment.skill === "writing") {
      rightPane.innerHTML = `
        <h3>Submit Essay Response</h3>
        <div class="form-group">
          <label for="pun-writing-input">Type your essay / report here</label>
          <textarea id="pun-writing-input" rows="10" placeholder="Type your response..." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;"></textarea>
        </div>
        <button class="btn btn-primary btn-full" onclick="submitPunishmentWriting()">Submit Writing</button>
      `;
    }
  }
};

const backPunBtn = document.getElementById("back-to-punishments-btn");
if (backPunBtn) {
  backPunBtn.addEventListener("click", () => {
    document.getElementById("punishment-runner-view").classList.add("hidden");
    const containerCard = document.getElementById("student-punishments-container")?.parentElement?.querySelector(".card");
    if (containerCard) containerCard.classList.remove("hidden");
    const cont = document.getElementById("student-punishments-container");
    if (cont) cont.classList.remove("hidden");
    renderStudentPunishmentsList();
  });
}

async function submitPunishmentScreenshot() {
  const fileInput = document.getElementById("pun-lr-file");
  const file = fileInput.files[0];
  const scoreText = document.getElementById("pun-lr-score").value.trim();
  if (!file || !scoreText) return alert("Please enter your score and attach a screenshot.");

  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, { method: "POST", body: formData });
  const data = await res.json();
  if (!data.secure_url) return alert("Upload failed.");

  await updateDoc(doc(db, "punishments", activePunishment.id), {
    status: "submitted",
    submission: { scoreText, screenshotUrl: data.secure_url },
    submittedAt: serverTimestamp()
  });

  alert("Punishment submitted successfully!");
  document.getElementById("back-to-punishments-btn").click();
}

async function submitPunishmentWriting() {
  const text = document.getElementById("pun-writing-input").value.trim();
  if (!text) return alert("Please write your essay.");

  await updateDoc(doc(db, "punishments", activePunishment.id), {
    status: "submitted",
    submission: { essayText: text, wordCount: text.split(/\s+/).length },
    submittedAt: serverTimestamp()
  });

  alert("Punishment submitted successfully!");
  document.getElementById("back-to-punishments-btn").click();
}

window.submitPunishmentAudio = async function () {
  if (!recordedAudioBlob) return alert("Please record your audio first.");

  const formData = new FormData();
  formData.append("file", recordedAudioBlob, `pun_${activePunishment.id}.webm`);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/video/upload`, { method: "POST", body: formData });
  const data = await res.json();
  if (!data.secure_url) return alert("Audio upload failed.");

  await updateDoc(doc(db, "punishments", activePunishment.id), {
    status: "submitted",
    submission: { audioUrl: data.secure_url },
    submittedAt: serverTimestamp()
  });

  alert("Speaking punishment submitted!");
  document.getElementById("back-to-punishments-btn").click();
};

// ==========================================
// STUDENT: CURATED PRACTICE RESOURCES
// ==========================================
function renderResourcesList(categoryFilter = "all") {
  const container = document.getElementById("resources-grid-container");
  if (!container) return;

  const filtered = categoryFilter === "all"
    ? RESOURCES
    : RESOURCES.filter((r) => r.category === categoryFilter);

  if (filtered.length === 0) {
    container.innerHTML = `<p class="muted center">No resources added in this category yet.</p>`;
    return;
  }

  const catLabels = {
    shadowing: "SHADOWING",
    listening: "ACTIVE LISTENING",
    reading: "ACTIVE READING"
  };

  container.innerHTML = filtered.map((res) => {
    const embedHtml = res.youtubeId
      ? `<div style="margin-top:12px;border-radius:8px;overflow:hidden;max-width:560px;">
           <iframe width="100%" height="260" src="https://www.youtube.com/embed/${res.youtubeId}" title="${escapeHtml(res.title)}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
         </div>`
      : "";

    return `
      <div class="hw-item" style="flex-direction:column;align-items:stretch;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
          <div>
            <span class="badge badge-blue" style="margin-bottom:6px;">${catLabels[res.category] || res.category.toUpperCase()}</span>
            ${res.duration ? `<span class="role-pill" style="margin-left:6px;">⏱ ${escapeHtml(res.duration)}</span>` : ""}
            <h3 style="margin-top:6px;">${escapeHtml(res.title)}</h3>
          </div>
          ${res.url ? `<a href="${res.url}" target="_blank" rel="noopener" class="btn btn-outline btn-sm">Open Link ↗</a>` : ""}
        </div>
        ${embedHtml}
        ${res.instructions ? `<div class="feedback-callout" style="white-space:pre-line;margin-top:12px;"><strong>How to Practice:</strong>\n${escapeHtml(res.instructions)}</div>` : ""}
      </div>
    `;
  }).join("");
}

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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
