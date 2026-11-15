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
  collection,
  getDocs,
  query,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { VOCAB_DECKS } from "./vocab-data.js";
import { ASSIGNMENTS } from "./assignments-data.js";

const firebaseConfig = {
  apiKey: "AIzaSyDrGjx51H42h6Pkg44RIpZo0vyZApz8SGA",
  authDomain: "zhamil-ielts-hub.firebaseapp.com",
  projectId: "zhamil-ielts-hub",
  storageBucket: "zhamil-ielts-hub.firebasestorage.app",
  messagingSenderId: "101411624698",
  appId: "1:101411624698:web:862eba707513e098c65b43"
};

// Cloudinary Config for Speaking Audio Uploads
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
let studentSubmissionsMap = {}; // assignmentId -> submission doc

// Audio Recorder State
let mediaRecorder = null;
let recordedChunks = [];
let recordedAudioBlob = null;
let recInterval = null;
let recSeconds = 0;

// Date Helpers
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

// Convert percentage accuracy to IELTS Band (approx)
function pctToIeltsBand(correct, total) {
  const pct = (correct / total) * 100;
  if (pct >= 88) return 8.5;
  if (pct >= 82) return 8.0;
  if (pct >= 75) return 7.5;
  if (pct >= 68) return 7.0;
  if (pct >= 58) return 6.5;
  if (pct >= 48) return 6.0;
  if (pct >= 38) return 5.5;
  if (pct >= 28) return 5.0;
  return 4.5;
}

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

// TAB NAVIGATION
document.querySelectorAll(".nav-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const parentNav = tab.parentElement;
    parentNav.querySelectorAll(".nav-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    switchView(tab.dataset.target);

    if (tab.dataset.target === "student-homework") {
      showHomeworkListView();
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

// ==========================================
// TEACHER: ROSTER, HW MATRIX & GRADING QUEUE
// ==========================================
async function loadTeacherData() {
  const [usersSnap, subsSnap] = await Promise.all([
    getDocs(collection(db, "users")),
    getDocs(collection(db, "submissions"))
  ]);

  const students = [];
  usersSnap.forEach((d) => {
    if (d.data().role === "student") students.push(d.data());
  });
  students.sort((a, b) => a.studentId.localeCompare(b.studentId));

  const allSubmissions = [];
  subsSnap.forEach((d) => allSubmissions.push({ docId: d.id, ...d.data() }));

  renderTeacherRoster(students);
  renderTeacherHwMatrix(students, allSubmissions);
  renderTeacherGradingQueue(students, allSubmissions);
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
          <td>🔥 ${stats.streak || 0} days</td>
          <td>${reviewedToday > 0 ? `<span style="color:var(--success);font-weight:600;">${reviewedToday} cards</span>` : `<span class="muted">0 cards</span>`}</td>
          <td>${stats.totalReviewed || 0}</td>
        </tr>
      `;
    })
    .join("");
}

function renderTeacherHwMatrix(students, submissions) {
  const container = document.getElementById("hw-matrix-container");
  if (students.length === 0) {
    container.innerHTML = `<p class="muted center">No students in roster yet.</p>`;
    return;
  }

  const now = new Date();
  const headers = ASSIGNMENTS.map((a) => `<th>${a.id}<br><span style="font-weight:400;font-size:11px;">${a.skill.toUpperCase()}</span></th>`).join("");

  const rows = students.map((s) => {
    const cells = ASSIGNMENTS.map((a) => {
      const sub = submissions.find((item) => item.studentId === s.studentId && item.assignmentId === a.id);
      if (sub) {
        const scoreTxt = sub.bandScore ? ` (${sub.bandScore})` : "";
        if (sub.isLate) return `<td><span class="badge badge-red">Late${scoreTxt}</span></td>`;
        if (sub.status === "graded") return `<td><span class="badge badge-green">Graded${scoreTxt}</span></td>`;
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

  container.innerHTML = `<table><thead><tr><th>Student</th>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderTeacherGradingQueue(students, submissions) {
  const container = document.getElementById("grading-list-container");
  const manualSubs = submissions.filter((s) => s.skill === "writing" || s.skill === "speaking");
  const ungradedCount = manualSubs.filter((s) => s.status !== "graded").length;
  document.getElementById("nav-grade-badge").textContent = ungradedCount;

  if (manualSubs.length === 0) {
    container.innerHTML = `<p class="muted center">No Writing or Speaking submissions yet.</p>`;
    return;
  }

  // Sort ungraded first
  manualSubs.sort((a, b) => (a.status === "graded") - (b.status === "graded"));

  const studentNameMap = {};
  students.forEach((s) => { studentNameMap[s.studentId] = s.fullName; });

  container.innerHTML = manualSubs.map((sub) => {
    const hw = ASSIGNMENTS.find((a) => a.id === sub.assignmentId);
    const title = hw ? hw.title : sub.assignmentId;
    const sName = studentNameMap[sub.studentId] || sub.studentId;
    const statusBadge = sub.status === "graded"
      ? `<span class="badge badge-green">Graded: Band ${sub.bandScore}</span>`
      : `<span class="badge badge-yellow">Needs Grading</span>`;
    const lateBadge = sub.isLate ? `<span class="badge badge-red">Late</span>` : "";

    const contentHtml = sub.skill === "writing"
      ? `<div class="essay-preview">${escapeHtml(sub.essayText || "")}</div><div class="muted" style="font-size:12px;margin-bottom:8px;">Word count: ${sub.wordCount || 0} words</div>`
      : `<div style="margin:12px 0;"><audio controls src="${sub.audioUrl}" style="width:100%;"></audio></div>`;

    return `
      <div class="grade-card">
        <div class="card-header-flex" style="margin-bottom:6px;">
          <div>
            <strong>${sName} (${sub.studentId})</strong> — ${title}
          </div>
          <div style="display:flex;gap:6px;">${lateBadge}${statusBadge}</div>
        </div>
        ${contentHtml}
        <div class="grade-controls-row">
          <div>
            <label>IELTS Band</label>
            <select id="band-${sub.docId}">
              ${["4.5","5.0","5.5","6.0","6.5","7.0","7.5","8.0","8.5"].map((b) =>
                `<option value="${b}" ${String(sub.bandScore) === b ? "selected" : ""}>Band ${b}</option>`
              ).join("")}
            </select>
          </div>
          <div>
            <label>Teacher Feedback</label>
            <input type="text" id="fb-${sub.docId}" placeholder="Write constructive feedback for the student..." value="${escapeHtml(sub.teacherFeedback || "")}" />
          </div>
          <button class="btn btn-primary" onclick="window.saveTeacherGrade('${sub.docId}')">Save Grade</button>
        </div>
      </div>
    `;
  }).join("");
}

window.saveTeacherGrade = async function (docId) {
  const bandVal = Number(document.getElementById(`band-${docId}`).value);
  const fbVal = document.getElementById(`fb-${docId}`).value.trim();

  await updateDoc(doc(db, "submissions", docId), {
    bandScore: bandVal,
    teacherFeedback: fbVal,
    status: "graded",
    gradedAt: serverTimestamp()
  });

  alert("Grade & feedback saved!");
  loadTeacherData();
};

document.getElementById("refresh-roster-btn").addEventListener("click", loadTeacherData);
document.getElementById("refresh-matrix-btn").addEventListener("click", loadTeacherData);
document.getElementById("refresh-grading-btn").addEventListener("click", loadTeacherData);

// ==========================================
// STUDENT: INITIALIZATION & ANKI ENGINE
// ==========================================
function getAllVocabCards() {
  const all = [];
  VOCAB_DECKS.forEach((deck) => {
    deck.cards.forEach((c) => all.push({ ...c, deckTitle: deck.title }));
  });
  return all;
}

async function initStudentData() {
  const [userSnap, progSnap, subsSnap] = await Promise.all([
    getDoc(doc(db, "users", currentStudentId)),
    getDocs(query(collection(db, "ankiProgress"), where("studentId", "==", currentStudentId))),
    getDocs(query(collection(db, "submissions"), where("studentId", "==", currentStudentId)))
  ]);

  currentStudentProfile = userSnap.exists()
    ? userSnap.data()
    : { fullName: currentStudentId, ankiStats: {}, permanentMistakes: {} };

  document.getElementById("user-display-name").textContent = currentStudentProfile.fullName;
  document.getElementById("welcome-student-name").textContent = currentStudentProfile.fullName;

  ankiProgressMap = {};
  progSnap.forEach((d) => { ankiProgressMap[d.data().cardId] = d.data(); });

  studentSubmissionsMap = {};
  subsSnap.forEach((d) => { studentSubmissionsMap[d.data().assignmentId] = d.data(); });

  bonusMode = false;
  buildAnkiQueue();
  updateDashboardUI();
  renderAssignmentsList();
}

function buildAnkiQueue() {
  const allCards = getAllVocabCards();
  const today = getTodayStr();
  ankiQueue = bonusMode
    ? [...allCards]
    : allCards.filter((card) => !ankiProgressMap[card.id] || ankiProgressMap[card.id].nextReviewDate <= today);
  renderNextAnkiCard();
}

function updateDashboardUI() {
  const allCards = getAllVocabCards();
  const seenCount = Object.keys(ankiProgressMap).length;
  const dueCount = ankiQueue.length;
  const stats = currentStudentProfile.ankiStats || {};
  const today = getTodayStr();
  const yesterday = getTodayStr(-1);

  let activeStreak = stats.streak || 0;
  if (stats.lastReviewedDate && stats.lastReviewedDate < yesterday) activeStreak = 0;
  const todayCount = stats.lastReviewedDate === today ? (stats.todayCount || 0) : 0;

  // Pending homework count
  const pendingHw = ASSIGNMENTS.filter((a) => !studentSubmissionsMap[a.id]).length;

  document.getElementById("nav-due-badge").textContent = bonusMode ? 0 : dueCount;
  document.getElementById("nav-hw-badge").textContent = pendingHw;
  document.getElementById("dash-due-count").textContent = bonusMode ? 0 : dueCount;
  document.getElementById("dash-streak-count").textContent = `🔥 ${activeStreak} days`;
  document.getElementById("dash-today-done").textContent = `${todayCount} reviewed today`;
  document.getElementById("dash-hw-pending").textContent = pendingHw;
  document.getElementById("dash-mastered-count").textContent = `${seenCount} / ${allCards.length}`;
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
  subtitle.textContent = bonusMode ? "Bonus Practice Mode" : `${ankiQueue.length} card(s) remaining in today's session`;

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
// STUDENT: HOMEWORK SYSTEM & TEST RUNNERS
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

function renderAssignmentsList() {
  const container = document.getElementById("assignments-list-container");
  const now = new Date();

  container.innerHTML = ASSIGNMENTS.map((hw) => {
    const sub = studentSubmissionsMap[hw.id];
    const isPastDue = now > new Date(hw.dueDate);

    let statusBadge = "";
    let actionBtn = "";
    let feedbackHtml = "";

    if (sub) {
      if (sub.status === "graded") {
        statusBadge = `<span class="badge badge-green">Graded: Band ${sub.bandScore}</span>`;
      } else if (sub.isLate) {
        statusBadge = `<span class="badge badge-red">Submitted Late${sub.bandScore ? ` • Band ${sub.bandScore}` : ""}</span>`;
      } else {
        statusBadge = `<span class="badge badge-blue">Submitted${sub.bandScore ? ` • Band ${sub.bandScore}` : ""}</span>`;
      }

      if (sub.teacherFeedback) {
        feedbackHtml = `<div class="feedback-callout"><strong>Teacher Feedback:</strong> ${escapeHtml(sub.teacherFeedback)}</div>`;
      }

      if (hw.skill === "reading" || hw.skill === "listening") {
        actionBtn = `<button class="btn btn-outline btn-sm" onclick="window.openAnalysisPage('${hw.id}')">View Analysis</button>`;
      } else {
        actionBtn = `<span class="muted" style="font-size:13px;margin:0;">Completed</span>`;
      }
    } else {
      statusBadge = isPastDue
        ? `<span class="badge badge-gray">Missing (Past Due)</span>`
        : `<span class="badge badge-yellow">Due ${formatDueDate(hw.dueDate)}</span>`;

      actionBtn = `<button class="btn btn-primary btn-sm" onclick="window.startAssignment('${hw.id}')">Start Task</button>`;
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

  // 1. READING OR LISTENING RUNNER
  if (hw.skill === "reading" || hw.skill === "listening") {
    leftPane.innerHTML = hw.skill === "reading"
      ? `<h3>${hw.passageTitle}</h3><div class="passage-box">${escapeHtml(hw.passageText)}</div>`
      : `<h3>Listening Audio</h3><p class="muted">Listen carefully and answer all questions on the right.</p><audio controls src="${hw.audioUrl}" style="width:100%;margin-top:12px;"></audio>`;

    const qHtml = hw.questions.map((q) => {
      const inputField = q.inputType === "select"
        ? `<select id="ans-q-${q.num}"><option value="">-- Select Answer --</option>${q.options.map((opt) => `<option value="${opt}">${opt}</option>`).join("")}</select>`
        : `<input type="text" id="ans-q-${q.num}" placeholder="Type your answer..." autocomplete="off" />`;

      return `
        <div class="question-block">
          <span class="q-tag">Q${q.num} • ${q.type}</span>
          <p style="margin-bottom:8px;font-weight:500;">${q.prompt}</p>
          ${inputField}
        </div>
      `;
    }).join("");

    rightPane.innerHTML = `
      <h3>Questions (${hw.questions.length})</h3>
      ${qHtml}
      <button class="btn btn-primary btn-full" style="margin-top:18px;" id="submit-lr-btn">Submit & See Analysis</button>
    `;

    document.getElementById("submit-lr-btn").addEventListener("click", () => submitObjectiveHomework(hw));
  }

  // 2. WRITING RUNNER
  else if (hw.skill === "writing") {
    leftPane.innerHTML = `<h3>Task Prompt</h3><div class="passage-box">${escapeHtml(hw.promptText)}</div>`;
    rightPane.innerHTML = `
      <div class="card-header-flex" style="margin-bottom:8px;">
        <h3>Your Response</h3>
        <span class="role-pill">Words: <strong id="writing-word-count">0</strong> / ${hw.minWords || 250}</span>
      </div>
      <textarea id="writing-essay-input" rows="15" placeholder="Write your essay here..."></textarea>
      <button class="btn btn-primary btn-full" style="margin-top:14px;" id="submit-writing-btn">Submit Essay</button>
    `;

    const textarea = document.getElementById("writing-essay-input");
    textarea.addEventListener("input", () => {
      const words = textarea.value.trim().split(/\s+/).filter(Boolean).length;
      document.getElementById("writing-word-count").textContent = words;
    });

    document.getElementById("submit-writing-btn").addEventListener("click", () => submitWritingHomework(hw));
  }

  // 3. SPEAKING RUNNER (Browser Mic -> Cloudinary)
  else if (hw.skill === "speaking") {
    recordedAudioBlob = null;
    leftPane.innerHTML = `<h3>Speaking Cue Card</h3><div class="passage-box">${escapeHtml(hw.promptText)}</div>`;
    rightPane.innerHTML = `
      <h3>Record Your Response</h3>
      <p class="muted">Click Record, speak clearly into your microphone, preview your audio, and submit.</p>
      <div class="recorder-box">
        <div id="rec-status-label" class="muted" style="margin-bottom:4px;">Ready to record</div>
        <div class="rec-timer" id="rec-timer-display">00:00</div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
          <button class="btn btn-danger" id="btn-start-rec">● Start Recording</button>
          <button class="btn btn-outline hidden" id="btn-stop-rec">■ Stop</button>
        </div>
        <div id="rec-preview-area" class="hidden" style="margin-top:18px;">
          <audio id="rec-audio-preview" controls style="width:100%;margin-bottom:12px;"></audio>
          <button class="btn btn-success btn-full" id="submit-speaking-btn">Upload & Submit Recording</button>
        </div>
      </div>
    `;

    document.getElementById("btn-start-rec").addEventListener("click", startBrowserRecording);
    document.getElementById("btn-stop-rec").addEventListener("click", stopBrowserRecording);
    document.getElementById("submit-speaking-btn").addEventListener("click", () => submitSpeakingHomework(hw));
  }
};

// SUBMIT OBJECTIVE (READING / LISTENING) + PERMANENT MISTAKE TRACKER
async function submitObjectiveHomework(hw) {
  const btn = document.getElementById("submit-lr-btn");
  btn.disabled = true;
  btn.textContent = "Grading & Analyzing...";

  let correctCount = 0;
  const breakdown = [];
  const updatedMistakes = { ...(currentStudentProfile.permanentMistakes || {}) };

  hw.questions.forEach((q) => {
    const rawVal = document.getElementById(`ans-q-${q.num}`).value.trim();
    // Normalize MCQ ("B. Consumers..." -> "B") and case-insensitive text
    const userClean = q.type === "MCQ" ? rawVal.charAt(0).toUpperCase() : rawVal.toLowerCase();
    const keyClean = q.answer.trim().toLowerCase();
    const isCorrect = userClean === keyClean;

    if (isCorrect) correctCount++;

    // Update permanent mistake counter by question type
    if (!updatedMistakes[q.type]) {
      updatedMistakes[q.type] = { wrong: 0, total: 0 };
    }
    updatedMistakes[q.type].total += 1;
    if (!isCorrect) {
      updatedMistakes[q.type].wrong += 1;
    }

    breakdown.push({
      qNum: q.num,
      type: q.type,
      userAns: rawVal || "(Blank)",
      key: q.answer,
      correct: isCorrect
    });
  });

  const bandScore = pctToIeltsBand(correctCount, hw.questions.length);
  const isLate = new Date() > new Date(hw.dueDate);

  const submissionData = {
    assignmentId: hw.id,
    studentId: currentStudentId,
    skill: hw.skill,
    status: "graded",
    isLate,
    submittedAt: serverTimestamp(),
    autoScore: correctCount,
    totalQuestions: hw.questions.length,
    bandScore,
    questionBreakdown: breakdown
  };

  await Promise.all([
    setDoc(doc(db, "submissions", `${hw.id}_${currentStudentId}`), submissionData),
    updateDoc(doc(db, "users", currentStudentId), { permanentMistakes: updatedMistakes })
  ]);

  currentStudentProfile.permanentMistakes = updatedMistakes;
  studentSubmissionsMap[hw.id] = submissionData;
  updateDashboardUI();

  window.openAnalysisPage(hw.id);
}

// POST-TEST ANALYSIS PAGE
window.openAnalysisPage = function (assignmentId) {
  const hw = ASSIGNMENTS.find((a) => a.id === assignmentId);
  const sub = studentSubmissionsMap[assignmentId];
  if (!hw || !sub) return;

  document.getElementById("hw-list-view").classList.add("hidden");
  document.getElementById("hw-runner-view").classList.add("hidden");
  document.getElementById("hw-analysis-view").classList.remove("hidden");

  document.getElementById("analysis-title").textContent = `${hw.title} — Analysis`;
  const pill = document.getElementById("analysis-status-pill");
  pill.textContent = sub.isLate ? "Submitted Late" : "Submitted On Time";
  pill.className = sub.isLate ? "badge badge-red" : "badge badge-green";

  const pct = Math.round((sub.autoScore / sub.totalQuestions) * 100);
  document.getElementById("ana-raw-score").textContent = `${sub.autoScore} / ${sub.totalQuestions}`;
  document.getElementById("ana-band-score").textContent = `Band ${sub.bandScore}`;
  document.getElementById("ana-accuracy").textContent = `${pct}%`;

  // Group breakdown by question type
  const byType = {};
  (sub.questionBreakdown || []).forEach((item) => {
    if (!byType[item.type]) byType[item.type] = { correct: 0, total: 0 };
    byType[item.type].total += 1;
    if (item.correct) byType[item.type].correct += 1;
  });

  document.getElementById("ana-type-breakdown").innerHTML = Object.entries(byType).map(([type, stat]) => {
    const typePct = Math.round((stat.correct / stat.total) * 100);
    return `
      <div class="type-bar-row">
        <div class="type-bar-head">
          <span>${type}</span>
          <span>${stat.correct}/${stat.total} (${typePct}%)</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${typePct}%;background:${typePct < 60 ? "var(--danger)" : "var(--success)"};"></div>
        </div>
      </div>
    `;
  }).join("");

  // Question-by-question table
  document.getElementById("ana-questions-tbody").innerHTML = (sub.questionBreakdown || []).map((q) => `
    <tr>
      <td><strong>Q${q.qNum}</strong></td>
      <td><span class="q-tag">${q.type}</span></td>
      <td>${escapeHtml(q.userAns)}</td>
      <td><strong>${escapeHtml(q.key)}</strong></td>
      <td>${q.correct ? `<span class="badge badge-green">Correct</span>` : `<span class="badge badge-red">Wrong</span>`}</td>
    </tr>
  `).join("");
};

// SUBMIT WRITING
async function submitWritingHomework(hw) {
  const text = document.getElementById("writing-essay-input").value.trim();
  if (!text) return alert("Please write your essay before submitting.");

  const btn = document.getElementById("submit-writing-btn");
  btn.disabled = true;
  btn.textContent = "Submitting...";

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
    wordCount
  };

  await setDoc(doc(db, "submissions", `${hw.id}_${currentStudentId}`), submissionData);
  studentSubmissionsMap[hw.id] = submissionData;
  updateDashboardUI();
  alert("Essay submitted successfully! Your teacher will review and grade it soon.");
  showHomeworkListView();
}

// BROWSER AUDIO RECORDER + CLOUDINARY UPLOAD
async function startBrowserRecording() {
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
      document.getElementById("rec-audio-preview").src = audioUrl;
      document.getElementById("rec-preview-area").classList.remove("hidden");
      stream.getTracks().forEach((track) => track.stop());
    };

    mediaRecorder.start();
    recSeconds = 0;
    document.getElementById("rec-status-label").innerHTML = `<span class="rec-dot"></span> Recording in progress...`;
    document.getElementById("btn-start-rec").classList.add("hidden");
    document.getElementById("btn-stop-rec").classList.remove("hidden");
    document.getElementById("rec-preview-area").classList.add("hidden");

    recInterval = setInterval(() => {
      recSeconds++;
      const mins = String(Math.floor(recSeconds / 60)).padStart(2, "0");
      const secs = String(recSeconds % 60).padStart(2, "0");
      document.getElementById("rec-timer-display").textContent = `${mins}:${secs}`;
    }, 1000);
  } catch (err) {
    alert("Microphone access denied. Please allow microphone permissions in your browser.");
  }
}

function stopBrowserRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  clearInterval(recInterval);
  document.getElementById("rec-status-label").textContent = "Recording captured — listen below or re-record";
  document.getElementById("btn-stop-rec").classList.add("hidden");
  document.getElementById("btn-start-rec").textContent = "↻ Re-record";
  document.getElementById("btn-start-rec").classList.remove("hidden");
}

function stopActiveRecordingCleanup() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  clearInterval(recInterval);
}

async function submitSpeakingHomework(hw) {
  if (!recordedAudioBlob) return alert("Please record your speaking answer first.");

  const btn = document.getElementById("submit-speaking-btn");
  btn.disabled = true;
  btn.textContent = "Uploading audio to cloud...";

  try {
    const formData = new FormData();
    formData.append("file", recordedAudioBlob, `${hw.id}_${currentStudentId}.webm`);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

    // Cloudinary uses /video/upload for audio files
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
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
