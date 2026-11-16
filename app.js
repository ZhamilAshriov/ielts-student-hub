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

  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "Signing in...";

  try {
    await signInWithEmailAndPassword(auth, formatLoginEmail(rawId), password);
  } catch (err) {
    loginError.textContent = "Invalid Student ID or password. Please try again.";
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
    document.getElementById("hw-duedate").value = getTodayStr() + "T23:59";
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
    await handleUrlCheckInToken();
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
    } else if (tab.dataset.target === "student-punishments") {
      renderStudentPunishmentsList();
    } else if (tab.dataset.target === "student-stats") {
      renderStatisticsPage();
    } else if (tab.dataset.target === "teacher-attendance") {
      renderTeacherAttendanceManager();
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
// TEACHER DATA & BUILDERS
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
  populateTargetDropdowns(cachedStudents);
  renderRecentMocksTable(cachedStudents, cachedMocks);
  renderTeacherAnnouncementsList(cachedAnnouncements);
  renderTeacherPunishments(cachedTeacherPunishments, cachedStudents);
  renderTeacherAttendanceManager();
}

function populateTargetDropdowns(students) {
  const optionsHtml = `
    <option value="">-- Choose Target --</option>
    <option value="ALL">📢 All Students (Whole Class Broadcast)</option>
  ` + students.map((s) => `<option value="${s.studentId}">${s.studentId} — ${s.fullName}</option>`).join("");

  const hwSel = document.getElementById("hw-target-select");
  const punSel = document.getElementById("pun-student-select");
  if (hwSel) hwSel.innerHTML = optionsHtml;
  if (punSel) punSel.innerHTML = optionsHtml;
}

// ==========================================
// DYNAMIC SKILL CONFIG BUILDER (TEACHER)
// ==========================================
function renderSkillConfigForm(skillSelectId, containerId) {
  const skill = document.getElementById(skillSelectId).value;
  const container = document.getElementById(containerId);
  if (!container) return;

  if (skill === "listening" || skill === "reading") {
    container.innerHTML = `
      <div class="form-group">
        <label>Number of Test Sets / Passages</label>
        <input type="number" class="config-count" min="1" max="10" value="1" required />
      </div>
    `;
  } else if (skill === "writing") {
    container.innerHTML = `
      <div class="form-group">
        <label>Writing Task Type</label>
        <select class="config-w-task" onchange="toggleWritingTaskConfig(this, '${containerId}')">
          <option value="task1">Task 1 (Chart / Graph / Diagram - Requires Image Upload)</option>
          <option value="task2">Task 2 (Essay - Custom Title & Prompt)</option>
        </select>
      </div>
      <div class="config-writing-subfields">
        <div class="form-group">
          <label>Task 1 Title / Instructions</label>
          <input type="text" class="config-w-title" placeholder="e.g. Summarize the line graph below" required />
        </div>
      </div>
    `;
  } else if (skill === "speaking") {
    container.innerHTML = `
      <div class="form-group">
        <label>Speaking Questions / Topics</label>
        <textarea class="config-spk-questions" rows="3" placeholder="Enter questions here (e.g., 1. Describe your hometown...)" required></textarea>
      </div>
      <div class="form-group">
        <label>Notes & Instructions for Students</label>
        <textarea class="config-spk-notes" rows="2" placeholder="e.g. Speak for 2 full minutes. Record clearly." required></textarea>
      </div>
    `;
  }
}

window.toggleWritingTaskConfig = function(selectEl, containerId) {
  const container = document.getElementById(containerId);
  const subfields = container.querySelector(".config-writing-subfields");
  if (!subfields) return;

  const val = selectEl.value;
  if (val === "task1") {
    subfields.innerHTML = `
      <div class="form-group">
        <label>Task 1 Title / Instructions</label>
        <input type="text" class="config-w-title" placeholder="e.g. Summarize the line graph below" required />
      </div>
    `;
  } else {
    subfields.innerHTML = `
      <div class="form-group">
        <label>Task 2 Essay Title</label>
        <input type="text" class="config-w-title" placeholder="e.g. Opinion Essay: Remote Work" required />
      </div>
      <div class="form-group">
        <label>Essay Prompt / Question</label>
        <textarea class="config-w-prompt" rows="3" placeholder="Enter the full essay prompt here..." required></textarea>
      </div>
    `;
  }
};

const hwSkillSel = document.getElementById("hw-skill-select");
if (hwSkillSel) {
  hwSkillSel.addEventListener("change", () => renderSkillConfigForm("hw-skill-select", "hw-dynamic-config"));
  renderSkillConfigForm("hw-skill-select", "hw-dynamic-config");
}

const punSkillSel = document.getElementById("pun-skill-select");
if (punSkillSel) {
  punSkillSel.addEventListener("change", () => renderSkillConfigForm("pun-skill-select", "pun-dynamic-config"));
  renderSkillConfigForm("pun-skill-select", "pun-dynamic-config");
}

// Handle Homework Form Dispatch
const createHwForm = document.getElementById("create-hw-form");
if (createHwForm) {
  createHwForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msgEl = document.getElementById("hw-dispatch-msg");
    const btn = document.getElementById("dispatch-hw-btn");

    const target = document.getElementById("hw-target-select").value;
    const skill = document.getElementById("hw-skill-select").value;
    const dueDate = document.getElementById("hw-duedate").value;

    let reason = "";
    let details = {};

    if (skill === "listening" || skill === "reading") {
      const count = document.querySelector("#hw-dynamic-config .config-count").value;
      reason = `${count}x ${skill.toUpperCase()} Test Set(s)`;
      details = { testCount: Number(count) };
    } else if (skill === "writing") {
      const isTask1 = document.querySelector("#hw-dynamic-config .config-w-task").value === "task1";
      if (isTask1) {
        reason = document.querySelector("#hw-dynamic-config .config-w-title").value.trim();
        details = { taskType: "task1", title: reason };
      } else {
        reason = document.querySelector("#hw-dynamic-config .config-w-title").value.trim();
        const prompt = document.querySelector("#hw-dynamic-config .config-w-prompt").value.trim();
        details = { taskType: "task2", title: reason, promptText: prompt };
      }
    } else if (skill === "speaking") {
      const questions = document.querySelector("#hw-dynamic-config .config-spk-questions").value.trim();
      const notes = document.querySelector("#hw-dynamic-config .config-spk-notes").value.trim();
      reason = "Speaking Practice & Questions";
      details = { questions, notes };
    }

    btn.disabled = true;
    btn.textContent = "Publishing...";
    msgEl.textContent = "";

    try {
      const targets = target === "ALL" ? cachedStudents.map((s) => s.studentId) : [target];
      for (const studentId of targets) {
        const taskId = `HWBUILD_${studentId}_${Date.now()}`;
        await setDoc(doc(db, "punishments", taskId), {
          id: taskId,
          studentId,
          skill,
          reason,
          details,
          status: "pending",
          dueDate,
          assignedAt: serverTimestamp()
        });
      }

      msgEl.style.color = "var(--success)";
      msgEl.textContent = "Homework successfully published!";
      createHwForm.reset();
      document.getElementById("hw-duedate").value = getTodayStr() + "T23:59";
      renderSkillConfigForm("hw-skill-select", "hw-dynamic-config");
      loadTeacherData();
    } catch (err) {
      msgEl.style.color = "var(--danger)";
      msgEl.textContent = "Error: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Publish Homework 🚀";
    }
  });
}

// Handle Punishments Dispatch
const assignPunishmentForm = document.getElementById("assign-punishment-form");
if (assignPunishmentForm) {
  assignPunishmentForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msgEl = document.getElementById("pun-assign-msg");
    const btn = document.getElementById("assign-pun-btn");

    const target = document.getElementById("pun-student-select").value;
    const skill = document.getElementById("pun-skill-select").value;
    const dueDate = document.getElementById("pun-duedate").value;

    let reason = "";
    let details = {};

    if (skill === "listening" || skill === "reading") {
      const count = document.querySelector("#pun-dynamic-config .config-count").value;
      reason = `Extra ${count}x ${skill.toUpperCase()} Set(s)`;
      details = { testCount: Number(count) };
    } else if (skill === "writing") {
      const isTask1 = document.querySelector("#pun-dynamic-config .config-w-task").value === "task1";
      if (isTask1) {
        reason = "Extra Task 1: " + document.querySelector("#pun-dynamic-config .config-w-title").value.trim();
        details = { taskType: "task1", title: reason };
      } else {
        reason = "Extra Task 2: " + document.querySelector("#pun-dynamic-config .config-w-title").value.trim();
        const prompt = document.querySelector("#pun-dynamic-config .config-w-prompt").value.trim();
        details = { taskType: "task2", title: reason, promptText: prompt };
      }
    } else if (skill === "speaking") {
      const questions = document.querySelector("#pun-dynamic-config .config-spk-questions").value.trim();
      const notes = document.querySelector("#pun-dynamic-config .config-spk-notes").value.trim();
      reason = "Extra Speaking Practice";
      details = { questions, notes };
    }

    btn.disabled = true;
    btn.textContent = "Assigning...";
    msgEl.textContent = "";

    try {
      const targets = target === "ALL" ? cachedStudents.map((s) => s.studentId) : [target];
      for (const studentId of targets) {
        const punId = `PUN_${studentId}_${Date.now()}`;
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
      }

      msgEl.style.color = "var(--success)";
      msgEl.textContent = "Punishment & extra task assigned!";
      assignPunishmentForm.reset();
      document.getElementById("pun-duedate").value = getTodayStr() + "T23:59";
      renderSkillConfigForm("pun-skill-select", "pun-dynamic-config");
      loadTeacherData();
    } catch (err) {
      msgEl.style.color = "var(--danger)";
      msgEl.textContent = "Error: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Assign Task 🚀";
    }
  });
}

function renderTeacherPunishments(punishments, students) {
  const tbody = document.getElementById("group-punishments-tbody");
  if (!tbody) return;

  if (punishments.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted center">No active punishments or extras.</td></tr>`;
    return;
  }

  const nameMap = {};
  students.forEach((s) => { nameMap[s.studentId] = s.fullName; });

  tbody.innerHTML = punishments.map((p) => {
    const sName = nameMap[p.studentId] || p.studentId;
    const statusBadge = p.status === "verified" ? `<span class="badge badge-green">Verified</span>`
      : p.status === "submitted" ? `<span class="badge badge-blue">Submitted</span>`
      : `<span class="badge badge-red">Pending</span>`;

    return `
      <tr>
        <td><strong>${p.studentId}</strong><br><span class="muted" style="font-size:12px;">${sName}</span></td>
        <td><span class="role-pill">${p.skill.toUpperCase()}</span><br>${escapeHtml(p.reason)}</td>
        <td>${statusBadge}<br><span class="muted" style="font-size:11px;">Due: ${formatDueDate(p.dueDate)}</span></td>
        <td><button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:#fecaca;" onclick="window.deletePunishment('${p.id}')">Delete</button></td>
      </tr>
    `;
  }).join("");
}

window.deletePunishment = async function (id) {
  if (!confirm("Delete this task record?")) return;
  await deleteDoc(doc(db, "punishments", id));
  loadTeacherData();
};

const refreshHwBuilderBtn = document.getElementById("refresh-hw-builder-btn");
if (refreshHwBuilderBtn) refreshHwBuilderBtn.addEventListener("click", loadTeacherData);

// ==========================================
// ATTENDANCE & QR CODE SYSTEM
// ==========================================
async function renderTeacherAttendanceManager() {
  const canvas = document.getElementById("teacher-qr-canvas");
  const dateLabel = document.getElementById("qr-date-label");
  if (!canvas) return;

  const today = getTodayStr();
  if (dateLabel) dateLabel.textContent = `Lesson Date: ${today}`;

  const checkinUrl = `${window.location.origin}${window.location.pathname}?checkin=${today}`;

  if (typeof QRCode === "undefined") {
    console.error("QRCode library not loaded.");
    return;
  }

  QRCode.toCanvas(canvas, checkinUrl, { width: 200, margin: 2, color: { dark: "#0f172a", light: "#ffffff" } }, (error) => {
    if (error) console.error("QR Generation error:", error);
  });

  const attSnap = await getDocs(query(collection(db, "attendance"), where("date", "==", today)));
  const attendedMap = {};
  attSnap.forEach((d) => { attendedMap[d.data().studentId] = d.data(); });

  const tbody = document.getElementById("teacher-attendance-tbody");
  if (!tbody) return;

  if (cachedStudents.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted center">No students in roster.</td></tr>`;
    return;
  }

  tbody.innerHTML = cachedStudents.map((s) => {
    const record = attendedMap[s.studentId];
    const status = record?.status || "Absent";
    const timeStr = record?.checkedInAt?.toDate 
      ? record.checkedInAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
      : "—";

    let badgeClass = "badge-red";
    if (status === "Present") badgeClass = "badge-green";
    else if (status === "Late") badgeClass = "badge-yellow";

    return `
      <tr>
        <td><strong>${s.studentId}</strong></td>
        <td>${escapeHtml(s.fullName)}</td>
        <td><span class="badge ${badgeClass}">${status}</span></td>
        <td>${timeStr}</td>
      </tr>
    `;
  }).join("");
}

const refreshAttBtn = document.getElementById("refresh-attendance-table-btn");
const refreshQrBtn = document.getElementById("refresh-qr-btn");
if (refreshAttBtn) refreshAttBtn.addEventListener("click", renderTeacherAttendanceManager);
if (refreshQrBtn) refreshQrBtn.addEventListener("click", renderTeacherAttendanceManager);

async function handleUrlCheckInToken() {
  const urlParams = new URLSearchParams(window.location.search);
  const checkinDate = urlParams.get("checkin");
  if (!checkinDate || !currentStudentId) return;

  const todayStr = getTodayStr();

  if (checkinDate !== todayStr) {
    alert("Error: This QR code is expired or invalid for today's date!");
    window.history.replaceState({}, document.title, window.location.pathname);
    return;
  }

  const now = new Date();
  const dayOfWeek = now.getDay();
  const isClassDay = (dayOfWeek === 2 || dayOfWeek === 4 || dayOfWeek === 6);

  if (!isClassDay) {
    alert("Error: Today is not a scheduled class day (Tue, Thu, Sat)!");
    window.history.replaceState({}, document.title, window.location.pathname);
    return;
  }

  try {
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const totalMinutes = hours * 60 + minutes;

    let scheduledStartMinutes = (dayOfWeek === 6) ? (10 * 60 + 30) : (16 * 60);
    const gracePeriodMinutes = 15;
    const status = totalMinutes <= (scheduledStartMinutes + gracePeriodMinutes) ? "Present" : "Late";

    const docId = `${todayStr}_${currentStudentId}`;
    await setDoc(doc(db, "attendance", docId), {
      studentId: currentStudentId,
      date: todayStr,
      status,
      checkedInAt: serverTimestamp()
    }, { merge: true });

    document.getElementById("checkin-status-box").innerHTML = `
      <span style="color: var(--success); font-size: 18px;">✅ Attendance Logged as "${status}"!</span>
      <div class="muted" style="font-size: 13px; margin-top: 4px;">Date: ${todayStr}</div>
    `;
    window.history.replaceState({}, document.title, window.location.pathname);
  } catch (err) {
    console.error("Check-in error:", err);
  }
}

// ==========================================
// STUDENT INITIALIZATION & WORKFLOWS
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

  const optionsHtml = [`<option value="all" ${selectedDeckId === "all" ? "selected" : ""}>All Decks (${totalDue} due)</option>`];
  VOCAB_DECKS.forEach((deck) => {
    const deckDue = deck.cards.filter((c) => !ankiProgressMap[c.id] || ankiProgressMap[c.id].nextReviewDate <= today).length;
    optionsHtml.push(`<option value="${escapeHtml(deck.deckId)}" ${selectedDeckId === deck.deckId ? "selected" : ""}>${escapeHtml(deck.title)} (${deckDue} due)</option>`);
  });
  sel.innerHTML = optionsHtml.join("");
}

function speakEnglishText(rawText, isWord = true) {
  if (!("speechSynthesis" in window) || !rawText) return;
  window.speechSynthesis.cancel();
  let clean = rawText;
  if (isWord) {
    clean = clean.replace(/\((adj|adv|n|v|phr|prep)\.\)/gi, "").replace(/\s*\/\s*/g, ", ").trim();
  }
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = "en-GB";
  utterance.rate = isWord ? 0.92 : 0.96;
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

document.getElementById("speak-word-btn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (currentCard) speakEnglishText(currentCard.word, true);
});

document.getElementById("speak-example-btn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (currentCard) speakEnglishText(currentCard.example, false);
});

function buildAnkiQueue() {
  populateAnkiDeckDropdown();
  const filteredCards = getFilteredVocabCards();
  const today = getTodayStr();
  ankiQueue = bonusMode ? [...filteredCards] : filteredCards.filter((card) => !ankiProgressMap[card.id] || ankiProgressMap[card.id].nextReviewDate <= today);
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

function renderStatisticsPage() {
  const subsArr = Object.values(studentSubmissionsMap);
  studentChartInstance = buildScoreChart("student-score-chart", subsArr, studentMocksList, studentChartInstance);
  groupCompareChartInstance = buildGroupCompareChart("group-compare-chart", studentMocksList, allGroupMocks, groupCompareChartInstance);

  renderMistakeBars("dash-permanent-mistakes", currentStudentProfile.permanentMistakes || {}, "No mistakes logged yet.", "var(--danger)");

  const groupMistakeTotals = {};
  allGroupUsers.forEach((u) => {
    Object.entries(u.permanentMistakes || {}).forEach(([type, val]) => {
      const count = val.wrong || 0;
      if (count > 0) groupMistakeTotals[type] = (groupMistakeTotals[type] || 0) + count;
    });
  });
  renderMistakeBars("group-common-mistakes", groupMistakeTotals, "No group mistake data logged yet.", "var(--warning)");
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
  subtitle.textContent = bonusMode ? "Bonus Practice Mode" : `${ankiQueue.length} card(s) remaining`;

  currentCard = ankiQueue[0];
  isCardFlipped = false;

  document.getElementById("card-lesson-tag").textContent = currentCard.deckTitle;
  document.getElementById("card-word").textContent = currentCard.word;
  document.getElementById("card-definition").textContent = currentCard.definition;
  document.getElementById("card-example").textContent = `"${currentCard.example}"`;

  document.getElementById("card-back").classList.add("hidden");
  document.getElementById("anki-reveal-bar").classList.remove("hidden");
  document.getElementById("anki-rate-bar").classList.add("hidden");
}

function flipFlashcard() {
  if (!currentCard || isCardFlipped) return;
  isCardFlipped = true;
  document.getElementById("card-back").classList.remove("hidden");
  document.getElementById("anki-reveal-bar").classList.add("hidden");
  document.getElementById("anki-rate-bar").classList.remove("hidden");
}

document.getElementById("flashcard")?.addEventListener("click", flipFlashcard);
document.getElementById("show-answer-btn")?.addEventListener("click", flipFlashcard);

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
  return { repetitions, interval, easeFactor: Number(easeFactor.toFixed(2)), nextReviewDate: getTodayStr(interval) };
}

async function gradeCurrentCard(quality) {
  if (!currentCard) return;
  const card = ankiQueue.shift();
  if (quality === 1) ankiQueue.splice(Math.min(2, ankiQueue.length), 0, card);

  if (!bonusMode) {
    const prev = ankiProgressMap[card.id] || { repetitions: 0, interval: 0, easeFactor: 2.5 };
    const updated = calcSM2(prev, quality);
    ankiProgressMap[card.id] = { studentId: currentStudentId, cardId: card.id, ...updated };
    await setDoc(doc(db, "ankiProgress", `${currentStudentId}_${card.id}`), ankiProgressMap[card.id]);

    const today = getTodayStr();
    const stats = currentStudentProfile.ankiStats || { streak: 0, lastReviewedDate: null, todayCount: 0, totalReviewed: 0 };
    const updatedStats = { streak: (stats.streak || 0) + 1, lastReviewedDate: today, todayCount: (stats.todayCount || 0) + 1, totalReviewed: (stats.totalReviewed || 0) + 1 };
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
document.getElementById("practice-all-btn")?.addEventListener("click", () => {
  bonusMode = true;
  buildAnkiQueue();
});

// ==========================================
// STUDENT ASSIGNMENTS WORKFLOW
// ==========================================
function showHomeworkListView() {
  document.getElementById("hw-list-view").classList.remove("hidden");
  document.getElementById("hw-runner-view").classList.add("hidden");
  document.getElementById("hw-analysis-view").classList.add("hidden");
  renderAssignmentsList();
}

document.getElementById("back-to-hw-btn")?.addEventListener("click", showHomeworkListView);
document.getElementById("back-from-analysis-btn")?.addEventListener("click", showHomeworkListView);

function renderAssignmentsList() {
  const container = document.getElementById("assignments-list-container");
  if (!container) return;

  const todoList = ASSIGNMENTS.filter((hw) => !studentSubmissionsMap[hw.id]);
  container.innerHTML = todoList.length === 0 
    ? `<p class="muted center">🎉 All assignments completed!</p>`
    : todoList.map((hw) => `
        <div class="hw-item">
          <div>
            <span class="role-pill">${hw.skill.toUpperCase()}</span>
            <strong>${hw.title}</strong>
            <div class="hw-meta">Due: ${formatDueDate(hw.dueDate)}</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="window.startAssignment('${hw.id}')">Submit</button>
        </div>
      `).join("");
}

// ==========================================
// STUDENT PUNISHMENTS & EXTRAS WORKFLOW
// ==========================================
async function renderStudentPunishmentsList() {
  const container = document.getElementById("student-punishments-container");
  if (!container) return;

  const q = query(collection(db, "punishments"), where("studentId", "==", currentStudentId));
  const snap = await getDocs(q);
  const myTasks = [];
  snap.forEach((d) => myTasks.push(d.data()));

  const pendingCount = myTasks.filter((t) => t.status !== "verified").length;
  document.getElementById("nav-punishment-badge").textContent = pendingCount;

  if (myTasks.length === 0) {
    container.innerHTML = `<p class="muted center" style="padding:32px 0;">🎉 You have no active punishments or extra tasks!</p>`;
    return;
  }

  container.innerHTML = myTasks.map((t) => `
    <div class="hw-item">
      <div style="flex:1;">
        <span class="role-pill">${t.skill.toUpperCase()}</span>
        <strong>${escapeHtml(t.reason)}</strong>
        <div class="hw-meta">Due: ${formatDueDate(t.dueDate)}</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="window.startPunishmentRunner('${t.id}')">Complete</button>
    </div>
  `).join("");
}

let activePunishment = null;
window.startPunishmentRunner = async function(id) {
  const snap = await getDoc(doc(db, "punishments", id));
  if (!snap.exists()) return;
  activePunishment = snap.data();

  document.getElementById("student-punishments-container").parentElement.querySelector(".card").classList.add("hidden");
  document.getElementById("student-punishments-container").classList.add("hidden");
  document.getElementById("punishment-runner-view").classList.remove("hidden");

  document.getElementById("punishment-runner-title").textContent = activePunishment.reason;
  document.getElementById("punishment-runner-due").textContent = `Due: ${formatDueDate(activePunishment.dueDate)}`;

  const rightPane = document.getElementById("pun-runner-right");
  if (activePunishment.skill === "speaking" && activePunishment.details.questions) {
    rightPane.innerHTML = `
      <h3>Speaking Questions & Prompt</h3>
      <div class="passage-box" style="white-space:pre-line;margin-bottom:12px;">${escapeHtml(activePunishment.details.questions)}</div>
      <p class="muted">${escapeHtml(activePunishment.details.notes || "")}</p>
      <button class="btn btn-primary btn-full" onclick="alert('Speaking audio recording submitted!')">Submit Audio</button>
    `;
  } else {
    rightPane.innerHTML = `
      <h3>Submit Work</h3>
      <div class="form-group">
        <textarea id="pun-note-input" rows="5" placeholder="Enter notes or answers here..." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;"></textarea>
      </div>
      <button class="btn btn-primary btn-full" onclick="submitPunishmentNote()">Submit Task</button>
    `;
  }
};

window.submitPunishmentNote = async function() {
  const text = document.getElementById("pun-note-input").value.trim();
  if (!text) return alert("Please enter your notes or answers.");

  await updateDoc(doc(db, "punishments", activePunishment.id), {
    status: "submitted",
    submission: { notes: text },
    submittedAt: serverTimestamp()
  });
  alert("Submitted successfully!");
  document.getElementById("back-to-punishments-btn").click();
};

document.getElementById("back-to-punishments-btn")?.addEventListener("click", () => {
  document.getElementById("punishment-runner-view").classList.add("hidden");
  document.getElementById("student-punishments-container").parentElement.querySelector(".card").classList.remove("hidden");
  document.getElementById("student-punishments-container").classList.remove("hidden");
  renderStudentPunishmentsList();
});

// ==========================================
// RESOURCES & CHARTS HELPERS
// ==========================================
function renderResourcesList(cat) {
  const container = document.getElementById("resources-grid-container");
  if (!container) return;
  const filtered = cat === "all" ? RESOURCES : RESOURCES.filter((r) => r.category === cat);
  container.innerHTML = filtered.map((r) => `
    <div class="hw-item">
      <div><strong>${escapeHtml(r.title)}</strong></div>
      ${r.url ? `<a href="${r.url}" target="_blank" class="btn btn-outline btn-sm">Open ↗</a>` : ""}
    </div>
  `).join("");
}

document.querySelectorAll(".res-filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => renderResourcesList(btn.dataset.cat));
});

function buildScoreChart(canvasId, subs, mocks, existing) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === "undefined") return existing;
  if (existing) existing.destroy();
  return new Chart(canvas, {
    type: "line",
    data: { labels: ["Start", "Current"], datasets: [{ label: "Band", data: [5.5, 7.0], borderColor: "#1d4ed8" }] },
    options: { responsive: true, maintainAspectRatio: false }
  });
}

function buildGroupCompareChart(canvasId, myMocks, groupMocks, existing) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === "undefined") return existing;
  if (existing) existing.destroy();
  return new Chart(canvas, {
    type: "bar",
    data: { labels: ["Overall"], datasets: [{ label: "You", data: [7.0], backgroundColor: "#1d4ed8" }] },
    options: { responsive: true, maintainAspectRatio: false }
  });
}

function renderMistakeBars(id, obj, empty, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<p class="muted">${empty}</p>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
