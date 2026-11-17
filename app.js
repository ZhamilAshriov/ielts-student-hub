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
const secondaryApp = initializeApp(firebaseConfig, `SecondaryAccountCreator_${Date.now()}`);
const secondaryAuth = getAuth(secondaryApp);
const DOMAIN = "@zhamil-hub.local";
const TEACHER_EMAIL = "teacher" + DOMAIN;

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
let cachedStudentPunishments = [];


let studentChartInstance = null;
let groupCompareChartInstance = null;
let inspectorChartInstance = null;

let cachedStudents = [];
let cachedSubmissions = [];
let cachedMocks = [];
let cachedTeacherHw = [];
let cachedTeacherPunishments = [];

let mediaRecorder = null;
let recordedChunks = [];
let recordedAudioBlob = null;
let recInterval = null;
let recSeconds = 0;

let activeDynamicTask = null;
let activeDynamicCollection = null;

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
  if (ann.createdAt?.toDate) return ann.createdAt.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return ann.dateLabel || "Recent";
}

function getAnnouncementBadgeClass(tag) {
  if (tag === "URGENT") return "badge-red";
  if (tag === "MOCK EXAM") return "badge-blue";
  if (tag === "NEW MATERIAL") return "badge-green";
  return "badge-gray";
}

const MISTAKE_LABELS = {
  MCQ: "Reading: Multiple Choice", TFNG: "True / False / Not Given", YNNG: "Yes / No / Not Given",
  MATCHING_HEADINGS: "Matching Headings", MATCHING_INFO: "Matching Information", MATCHING_FEATURES: "Matching Features",
  MATCHING_SENTENCE_ENDINGS: "Matching Sentence Endings", SENTENCE_COMPLETION: "Reading: Sentence Completion",
  SUMMARY_COMPLETION: "Summary Completion", NOTE_COMPLETION: "Note Completion", TABLE_COMPLETION: "Table Completion",
  FLOW_CHART_COMPLETION: "Flow-chart Completion", DIAGRAM_LABELLING: "Diagram Labelling", SHORT_ANSWER: "Reading: Short-Answer Questions",
  L_MCQ: "Listening: Multiple Choice", MATCHING: "Listening: Matching", MAP_DIAGRAM: "Listening: Plan, Map, or Diagram", 
  FORM_NOTE_TABLE_SUMMARY: "Listening: Form / Note / Table / Summary", L_SENTENCE_COMPLETION: "Listening: Sentence Completion", L_SHORT_ANSWER: "Listening: Short-Answer Questions"
};

// ==========================================
// AUTHENTICATION & ROUTING
// ==========================================
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

  const timeoutId = setTimeout(() => {
    btn.disabled = false;
    btn.textContent = "Sign In";
    loginError.textContent = "Connection timed out. Please check your network.";
  }, 10000);

  try {
    await signInWithEmailAndPassword(auth, formatLoginEmail(rawId), password);
    
    // FIX: Clear the timeout so it doesn't trigger 10 seconds later
    clearTimeout(timeoutId); 
    
    // FIX: Reset the button state so it works again if the user logs out
    btn.disabled = false;
    btn.textContent = "Sign In";
  } catch (err) {
    clearTimeout(timeoutId);
    loginError.textContent = "Invalid Student ID or password. Please try again.";
    btn.disabled = false;
    btn.textContent = "Sign In";
  }
});

document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    document.getElementById("login-view").classList.remove("hidden");
    document.getElementById("app-shell").classList.add("hidden");
    currentStudentId = null;
    return;
  }
  document.getElementById("login-view").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");

  if (user.email.toLowerCase() === TEACHER_EMAIL) {
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
    tab.parentElement.querySelectorAll(".nav-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    switchView(tab.dataset.target);

    if (tab.dataset.target === "student-homework") showHomeworkListView();
    else if (tab.dataset.target === "student-punishments") renderStudentPunishmentsList();
    else if (tab.dataset.target === "student-stats") renderStatisticsPage();
    else if (tab.dataset.target === "teacher-attendance") renderTeacherAttendanceManager();
  });
});

function switchView(targetId) {
  document.querySelectorAll(".view-section").forEach((sec) => sec.classList.add("hidden"));
  const target = document.getElementById(targetId);
  if (target) target.classList.remove("hidden");
}

document.getElementById("dash-start-anki-btn")?.addEventListener("click", () => document.querySelector('[data-target="student-anki"]').click());
document.getElementById("dash-go-hw-btn")?.addEventListener("click", () => document.querySelector('[data-target="student-homework"]').click());
document.getElementById("dash-go-stats-btn")?.addEventListener("click", () => document.querySelector('[data-target="student-stats"]').click());

// ==========================================
// TEACHER: DATA & DISPATCHERS
// ==========================================
async function loadTeacherData() {
  const [usersSnap, subsSnap, mocksSnap, annSnap, customHwSnap, punSnap] = await Promise.all([
    getDocs(collection(db, "users")),
    getDocs(collection(db, "submissions")),
    getDocs(collection(db, "mockScores")),
    getDocs(collection(db, "announcements")),
    getDocs(collection(db, "customAssignments")),
    getDocs(collection(db, "punishments"))
  ]);

  cachedStudents = [];
  usersSnap.forEach((d) => { if (d.data().role === "student") cachedStudents.push(d.data()); });
  cachedStudents.sort((a, b) => a.studentId.localeCompare(b.studentId));

  cachedSubmissions = [];
  subsSnap.forEach((d) => cachedSubmissions.push({ docId: d.id, ...d.data() }));

  cachedMocks = [];
  mocksSnap.forEach((d) => cachedMocks.push({ docId: d.id, ...d.data() }));
  cachedMocks.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const rawAnns = [];
  annSnap.forEach((d) => rawAnns.push({ docId: d.id, ...d.data() }));
  cachedAnnouncements = sortAnnouncementsList(rawAnns);

  cachedTeacherHw = [];
  customHwSnap.forEach((d) => cachedTeacherHw.push(d.data()));
  cachedTeacherHw.sort((a, b) => (b.dueDate || "").localeCompare(a.dueDate || ""));

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
  renderTeacherCustomHw(cachedTeacherHw, cachedStudents);
  renderTeacherPunishments(cachedTeacherPunishments, cachedStudents);
  renderTeacherAttendanceManager();
}

function populateTargetDropdowns(students) {
  const optionsHtml = `<option value="">-- Choose Target --</option><option value="ALL">📢 All Students (Whole Class Broadcast)</option>` + 
    students.map((s) => `<option value="${s.studentId}">${s.studentId} — ${s.fullName}</option>`).join("");
  const hwSel = document.getElementById("hw-target-select");
  const punSel = document.getElementById("pun-target-select");
  if (hwSel) hwSel.innerHTML = optionsHtml;
  if (punSel) punSel.innerHTML = optionsHtml;
}

function renderSkillConfigForm(skillSelectId, containerId) {
  const skill = document.getElementById(skillSelectId).value;
  const container = document.getElementById(containerId);
  if (!container) return;

  if (skill === "listening" || skill === "reading") {
    container.innerHTML = `
      <div class="form-group"><label>Number of Test Sets / Passages</label><input type="number" class="config-count" min="1" max="10" value="1" required /></div>`;
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
        <div class="form-group"><label>Task 1 Title / Instructions</label><input type="text" class="config-w-title" placeholder="e.g. Summarize the line graph below" required /></div>
      </div>
    `;
  } else if (skill === "speaking") {
    container.innerHTML = `
      <div class="form-group"><label>Speaking Questions / Topics</label><textarea class="config-spk-questions" rows="3" placeholder="Enter questions here..." required></textarea></div>
      <div class="form-group"><label>Notes & Instructions for Students</label><textarea class="config-spk-notes" rows="2" placeholder="e.g. Speak for 2 full minutes. Record clearly." required></textarea></div>
    `;
  } else if (skill === "grammar") {
    container.innerHTML = `
      <div class="form-group"><label>Grammar Instructions / Title</label><input type="text" class="config-g-title" placeholder="e.g. Grammar Book: Sections 1-6" required /></div>
      <div class="form-group"><label>Detailed Notes for Students</label><textarea class="config-g-notes" rows="2" placeholder="e.g. Complete exercises and upload a clear photo."></textarea></div>
    `;
  } else if (skill === "other") {
    container.innerHTML = `
      <div class="form-group"><label>Task Title / Topic</label><input type="text" class="config-o-title" placeholder="e.g. Vocabulary Workbook Unit 3" required /></div>
      <div class="form-group"><label>Task Instructions</label><textarea class="config-o-notes" rows="2" placeholder="e.g. Write your answers in the response box..."></textarea></div>
    `;
  }
}

window.toggleWritingTaskConfig = function(selectEl, containerId) {
  const container = document.getElementById(containerId);
  const subfields = container.querySelector(".config-writing-subfields");
  if (!subfields) return;

  if (selectEl.value === "task1") {
    subfields.innerHTML = `<div class="form-group"><label>Task 1 Title / Instructions</label><input type="text" class="config-w-title" placeholder="e.g. Summarize the line graph below" required /></div>`;
  } else {
    subfields.innerHTML = `
      <div class="form-group"><label>Task 2 Essay Title</label><input type="text" class="config-w-title" placeholder="e.g. Opinion Essay: Remote Work" required /></div>
      <div class="form-group"><label>Essay Prompt / Question</label><textarea class="config-w-prompt" rows="3" placeholder="Enter the full essay prompt here..." required></textarea></div>
    `;
  }
};

const hwSkillSel = document.getElementById("hw-skill-select");
if (hwSkillSel) {
  hwSkillSel.addEventListener("change", () => renderSkillConfigForm("hw-skill-select", "hw-config-container"));
  renderSkillConfigForm("hw-skill-select", "hw-config-container");
}

const punSkillSel = document.getElementById("pun-skill-select");
if (punSkillSel) {
  punSkillSel.addEventListener("change", () => renderSkillConfigForm("pun-skill-select", "pun-config-container"));
  renderSkillConfigForm("pun-skill-select", "pun-config-container");
}

function extractDynamicFormDetails(skill, containerId) {
  const container = document.getElementById(containerId);
  let title = "";
  let details = {};

  if (skill === "listening" || skill === "reading") {
    const count = container.querySelector(".config-count").value;
    title = `${count}x ${skill.toUpperCase()} Test Set(s)`;
    details = { testCount: Number(count) };
  } else if (skill === "writing") {
    const isTask1 = container.querySelector(".config-w-task").value === "task1";
    title = container.querySelector(".config-w-title").value.trim();
    if (isTask1) {
      details = { taskType: "task1", title };
    } else {
      const promptText = container.querySelector(".config-w-prompt").value.trim();
      details = { taskType: "task2", title, promptText };
    }
  } else if (skill === "speaking") {
    const questions = container.querySelector(".config-spk-questions").value.trim();
    const notes = container.querySelector(".config-spk-notes").value.trim();
    title = "Speaking Practice & Questions";
    details = { questions, notes };
  } else if (skill === "grammar") {
    title = container.querySelector(".config-g-title").value.trim();
    const notes = container.querySelector(".config-g-notes").value.trim();
    details = { instructions: notes };
  } else if (skill === "other") {
    title = container.querySelector(".config-o-title").value.trim();
    const notes = container.querySelector(".config-o-notes").value.trim();
    details = { instructions: notes };
  }
  return { title, details };
}

const assignHwForm = document.getElementById("assign-hw-form");
if (assignHwForm) {
  assignHwForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("assign-hw-btn");
    const msgEl = document.getElementById("hw-assign-msg");

    const target = document.getElementById("hw-target-select").value;
    const skill = document.getElementById("hw-skill-select").value;
    const dueDate = document.getElementById("hw-duedate").value;
    const { title, details } = extractDynamicFormDetails(skill, "hw-config-container");

    btn.disabled = true;
    btn.textContent = "Publishing...";
    msgEl.textContent = "";

    try {
      let activeWeek = "Current Assignments";
      if (typeof ASSIGNMENTS !== 'undefined' && ASSIGNMENTS.length > 0) {
        const upcoming = ASSIGNMENTS.find(a => new Date(a.dueDate) >= new Date());
        activeWeek = upcoming ? upcoming.week : ASSIGNMENTS[ASSIGNMENTS.length - 1].week;
      }

      const targets = target === "ALL" ? cachedStudents.map((s) => s.studentId) : [target];
      for (const studentId of targets) {
        const taskId = `CUSTOMHW_${studentId}_${Date.now()}`;
        await setDoc(doc(db, "customAssignments", taskId), {
          id: taskId, studentId, skill, title, details, dueDate, week: activeWeek, status: "pending", createdAt: serverTimestamp()
        });
      }

      msgEl.style.color = "var(--success)";
      msgEl.textContent = target === "ALL" ? "Successfully broadcasted homework!" : `Assigned to ${target}!`;
      assignHwForm.reset();
      document.getElementById("hw-duedate").value = getTodayStr() + "T23:59";
      renderSkillConfigForm("hw-skill-select", "hw-config-container");
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

const assignPunForm = document.getElementById("assign-pun-form");
if (assignPunForm) {
  assignPunForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("assign-pun-btn");
    const msgEl = document.getElementById("pun-assign-msg");

    const target = document.getElementById("pun-target-select").value;
    const skill = document.getElementById("pun-skill-select").value;
    const dueDate = document.getElementById("pun-duedate").value;
    
    let { title, details } = extractDynamicFormDetails(skill, "pun-config-container");
    title = `Extra/Remedial: ${title}`;

    btn.disabled = true;
    btn.textContent = "Assigning...";
    msgEl.textContent = "";

    try {
      const targets = target === "ALL" ? cachedStudents.map((s) => s.studentId) : [target];
      for (const studentId of targets) {
        const taskId = `PUN_${studentId}_${Date.now()}`;
        await setDoc(doc(db, "punishments", taskId), {
          id: taskId, studentId, skill, reason: title, details, status: "pending", dueDate, assignedAt: serverTimestamp()
        });
      }

      msgEl.style.color = "var(--success)";
      msgEl.textContent = target === "ALL" ? "Successfully assigned punishments!" : `Assigned punishment to ${target}!`;
      assignPunForm.reset();
      document.getElementById("pun-duedate").value = getTodayStr() + "T23:59";
      renderSkillConfigForm("pun-skill-select", "pun-config-container");
      loadTeacherData();
    } catch (err) {
      msgEl.style.color = "var(--danger)";
      msgEl.textContent = "Error: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Assign Punishment 🚀";
    }
  });
}

function renderTeacherCustomHw(tasks, students) {
  const tbody = document.getElementById("group-hw-tbody");
  if (!tbody) return;
  if (tasks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted center">No active custom homework.</td></tr>`;
    return;
  }
  const nameMap = {};
  students.forEach((s) => { nameMap[s.studentId] = s.fullName; });

  tbody.innerHTML = tasks.map((t) => {
    const sName = nameMap[t.studentId] || t.studentId;
    const statusBadge = t.status === "verified" ? `<span class="badge badge-green">Verified</span>` : t.status === "submitted" ? `<span class="badge badge-blue">Submitted</span>` : `<span class="badge badge-red">Pending</span>`;
    let actionBtn = `<button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:#fecaca;" onclick="window.deleteDynamicTask('${t.id}', 'customAssignments')">Delete</button>`;

    return `
      <tr>
        <td><strong>${t.studentId}</strong><br><span class="muted" style="font-size:12px;">${sName}</span></td>
        <td><span class="role-pill">${t.skill.toUpperCase()}</span><br>${escapeHtml(t.title)}</td>
        <td>${statusBadge}<br><span class="muted" style="font-size:11px;">Due: ${formatDueDate(t.dueDate)}</span></td>
        <td>${actionBtn}</td>
      </tr>
    `;
  }).join("");
}

function renderTeacherPunishments(tasks, students) {
  const tbody = document.getElementById("group-pun-tbody");
  if (!tbody) return;
  if (tasks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted center">No active punishments.</td></tr>`;
    return;
  }
  const nameMap = {};
  students.forEach((s) => { nameMap[s.studentId] = s.fullName; });

  tbody.innerHTML = tasks.map((t) => {
    const sName = nameMap[t.studentId] || t.studentId;
    const statusBadge = t.status === "verified" ? `<span class="badge badge-green">Verified</span>` : t.status === "submitted" ? `<span class="badge badge-blue">Submitted</span>` : `<span class="badge badge-red">Pending</span>`;
    let actionBtn = `<button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:#fecaca;" onclick="window.deleteDynamicTask('${t.id}', 'punishments')">Delete</button>`;

    return `
      <tr>
        <td><strong>${t.studentId}</strong><br><span class="muted" style="font-size:12px;">${sName}</span></td>
        <td><span class="role-pill">${t.skill.toUpperCase()}</span><br>${escapeHtml(t.reason)}</td>
        <td>${statusBadge}<br><span class="muted" style="font-size:11px;">Due: ${formatDueDate(t.dueDate)}</span></td>
        <td>${actionBtn}</td>
      </tr>
    `;
  }).join("");
}

window.deleteDynamicTask = async function(id, collectionName) {
  if (!confirm("Delete this assigned record?")) return;
  await deleteDoc(doc(db, collectionName, id));
  loadTeacherData();
};

document.getElementById("refresh-hw-btn")?.addEventListener("click", loadTeacherData);
document.getElementById("refresh-pun-btn")?.addEventListener("click", loadTeacherData);


// ==========================================
// Roster, Mock & Announcement Handlers
// ==========================================
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
      studentId, fullName, role: "student", createdAt: serverTimestamp(),
      ankiStats: { streak: 0, lastReviewedDate: null, todayCount: 0, totalReviewed: 0 },
      permanentMistakes: {}
    });

    msgEl.style.color = "var(--success)";
    msgEl.textContent = `Account created! Login ID: ${studentId} | Password: ${password}`;
    createStudentForm.reset();
    loadTeacherData();
  } catch (err) {
    msgEl.style.color = "var(--danger)";
    msgEl.textContent = err.code === "auth/email-already-in-use" ? `Student ID "${studentId}" already exists.` : `Error: ${err.message}`;
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
        title, tag, body, pinned,
        dateLabel: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        createdAtMs: Date.now(), createdAt: serverTimestamp()
      });
      msgEl.style.color = "var(--success)";
      msgEl.textContent = "Announcement published!";
      announcementForm.reset();
      loadTeacherData();
    } catch (err) {
      msgEl.style.color = "var(--danger)";
      msgEl.textContent = "Error: " + err.message;
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
document.getElementById("refresh-ann-btn")?.addEventListener("click", loadTeacherData);

function renderTeacherRoster(students) {
  const tbody = document.getElementById("roster-table-body");
  document.getElementById("student-count").textContent = students.length;
  if (students.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted center">No students created yet.</td></tr>`;
    return;
  }
  const todayStr = getTodayStr();
  tbody.innerHTML = students.map((s) => {
    const stats = s.ankiStats || {};
    const reviewedToday = stats.lastReviewedDate === todayStr ? (stats.todayCount || 0) : 0;
    return `
      <tr>
        <td><strong>${s.studentId}</strong></td>
        <td>${escapeHtml(s.fullName)}</td>
        <td>🔥 ${stats.streak || 0}d</td>
        <td>${reviewedToday > 0 ? `<span style="color:var(--success);font-weight:600;">${reviewedToday}</span>` : `<span class="muted">0</span>`}</td>
        <td><button class="btn btn-outline btn-sm" onclick="window.inspectStudent('${s.studentId}')">Inspect Stats</button></td>
      </tr>
    `;
  }).join("");
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
document.getElementById("close-inspector-btn")?.addEventListener("click", () => {
  document.getElementById("teacher-inspector-card").classList.add("hidden");
});

function populateMockStudentDropdown(students) {
  const sel = document.getElementById("mock-student-select");
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

document.getElementById("mock-score-form")?.addEventListener("submit", async (e) => {
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
      studentId, mockTitle, date, listening, reading, writing, speaking, overall,
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

function renderTeacherHwMatrix(students, submissions) {
  const container = document.getElementById("hw-matrix-container");
  if (students.length === 0) {
    container.innerHTML = `<p class="muted center">No students in roster yet.</p>`;
    return;
  }

  const now = new Date();
  // Check both syllabus assignments AND your dynamically assigned custom tasks
  const allAssignments = [
    ...ASSIGNMENTS,
    ...cachedTeacherHw.map(t => ({ id: t.id, title: t.title || t.reason, skill: t.skill, dueDate: t.dueDate }))
  ];

  const delinquentRecords = [];

  students.forEach(s => {
    const issues = [];
    allAssignments.forEach(a => {
      const sub = submissions.find(item => item.studentId === s.studentId && item.assignmentId === a.id);
      const isPastDue = now > new Date(a.dueDate);
      
      if (!sub && isPastDue) {
        issues.push(`<div style="margin-bottom:8px; display:flex; align-items:center; gap:8px;"><span class="badge badge-red">Missing</span> <span><strong>${escapeHtml(a.title)}</strong> <span class="muted" style="font-size:12px;">(Due: ${formatDueDate(a.dueDate)})</span></span></div>`);
      } else if (sub && sub.isLate) {
        issues.push(`<div style="margin-bottom:8px; display:flex; align-items:center; gap:8px;"><span class="badge badge-yellow">Late</span> <span><strong>${escapeHtml(a.title)}</strong> <span class="muted" style="font-size:12px;">(Submitted: ${sub.submittedAt?.toDate ? formatDueDate(sub.submittedAt.toDate().toISOString()) : 'Late'})</span></span></div>`);
      }
    });

    if (issues.length > 0) {
      delinquentRecords.push({ student: s, issues });
    }
  });

  if (delinquentRecords.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding: 40px 20px; border: 1px dashed var(--border); border-radius: 8px;">
        <div style="font-size:32px; margin-bottom:12px;">🎉</div>
        <h3 style="margin-bottom:8px;">All Caught Up!</h3>
        <p class="muted">Every student has submitted all past-due assignments on time.</p>
      </div>
    `;
    return;
  }

  const rows = delinquentRecords.map(record => `
    <div class="grade-card" style="margin-bottom:16px;">
      <div style="font-weight:600; font-size:15px; margin-bottom:12px; border-bottom:1px solid var(--border); padding-bottom:8px; color:var(--primary);">
        ${escapeHtml(record.student.fullName)} <span class="muted" style="font-size:13px; font-weight:400;">(${record.student.studentId})</span>
      </div>
      <div>${record.issues.join("")}</div>
    </div>
  `).join("");

  container.innerHTML = `
    <div style="margin-bottom:16px;">
      <p class="muted" style="font-size:14px; margin:0;">Showing students who have missing (past-due) assignments or submitted late.</p>
    </div>
    ${rows}
  `;
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
    const isCustom = sub.assignmentId.startsWith("CUSTOMHW_") || sub.assignmentId.startsWith("PUN_");
    const hw = isCustom ? { title: "Dynamic Task", isDrill: false } : ASSIGNMENTS.find((a) => a.id === sub.assignmentId);
    const title = isCustom ? (sub.skill.toUpperCase() + " Submission") : (hw ? hw.title : sub.assignmentId);
    const sName = studentNameMap[sub.studentId] || sub.studentId;
    const noBandRequired = sub.skill === "grammar" || sub.skill === "other" || sub.isDrill || (hw && hw.isDrill);

    const statusBadge = sub.status === "graded"
      ? `<span class="badge badge-green">${noBandRequired ? "Checked" : `Verified: Band ${sub.bandScore}`}</span>`
      : `<span class="badge badge-yellow">Needs Review</span>`;
    const lateBadge = sub.isLate ? `<span class="badge badge-red">Late</span>` : "";

    let contentHtml = "";
    
    // Safely handle both single and multiple image arrays
    const allScreenshots = Array.isArray(sub.screenshotUrls) ? sub.screenshotUrls : (sub.screenshotUrl ? [sub.screenshotUrl] : []);
    const imgHtml = allScreenshots.map(url => `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Attached Work" style="max-height:220px;border:1px solid var(--border);border-radius:8px;margin:0 8px 8px 0;display:inline-block;" /></a>`).join("");

    const allCharts = Array.isArray(sub.chartImageUrls) ? sub.chartImageUrls : (sub.chartImageUrl ? [sub.chartImageUrl] : []);
    const chartImgHtml = allCharts.map(url => `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Task 1 Chart" style="max-height:220px;border:1px solid var(--border);border-radius:8px;margin:0 8px 8px 0;display:inline-block;" /></a>`).join("");

    if (sub.skill === "reading" || sub.skill === "listening") {
      const mistakesSummary = Object.entries(sub.mistakeCounts || {}).filter(([, count]) => count > 0).map(([type, count]) => `<span class="q-tag">${MISTAKE_LABELS[type] || type}: ${count} wrong</span>`).join(" ");
      contentHtml = `
        <div style="margin:10px 0;">
          <p style="font-size:14px;margin-bottom:8px;"><strong>Reported Score:</strong> ${sub.rawScore} / ${sub.totalQuestions} ${sub.bandScore ? `(Auto Band ${sub.bandScore})` : `(Drill — Weakest Areas Only)`}</p>
          ${mistakesSummary ? `<div style="margin-bottom:10px;">${mistakesSummary}</div>` : ""}
          <div style="display:flex;flex-wrap:wrap;">${imgHtml}</div>
        </div>
      `;
    } else if (sub.skill === "writing") {
      contentHtml = `<div style="display:flex;flex-wrap:wrap;margin:10px 0;">${chartImgHtml}</div><div class="essay-preview">${escapeHtml(sub.essayText || "")}</div>`;
    } else if (sub.skill === "speaking") {
      contentHtml = `<div style="margin:12px 0;"><audio controls src="${sub.audioUrl}" style="width:100%;"></audio></div>`;
    } else if (sub.skill === "grammar") {
      contentHtml = `
        <div style="margin:10px 0;">
          ${sub.notes ? `<p style="font-size:14px;margin-bottom:8px;"><strong>Student Note:</strong> ${escapeHtml(sub.notes)}</p>` : ""}
          <div style="display:flex;flex-wrap:wrap;">${imgHtml}</div>
        </div>
      `;
    } else if (sub.skill === "other") {
      contentHtml = `
        <div style="margin:10px 0;">
          <p style="font-size:14px;white-space:pre-line;margin-bottom:8px;">${escapeHtml(sub.notes || sub.responseText || "")}</p>
          <div style="display:flex;flex-wrap:wrap;">${imgHtml}</div>
        </div>
      `;
    }

    const bandSelectorHtml = noBandRequired
      ? `<div><label>Status</label><input type="text" value="Completion Check" disabled style="background:#f1f5f9;color:var(--muted);" /><input type="hidden" id="band-${sub.docId}" value="" /></div>`
      : `<div><label>Confirm / Set Band</label><select id="band-${sub.docId}">${["4.0","4.5","5.0","5.5","6.0","6.5","7.0","7.5","8.0","8.5","9.0"].map((b) => `<option value="${b}" ${String(sub.bandScore) === b ? "selected" : ""}>Band ${b}</option>`).join("")}</select></div>`;

    return `
      <div class="grade-card">
        <div class="card-header-flex" style="margin-bottom:6px;">
          <div><span class="role-pill" style="margin-right:6px;">${sub.skill.toUpperCase()}</span><strong>${sName} (${sub.studentId})</strong> — ${title}</div>
          <div style="display:flex;gap:6px;">${lateBadge}${statusBadge}</div>
        </div>
        ${contentHtml}
        <div class="grade-controls-row">
          ${bandSelectorHtml}
          <div><label>Teacher Feedback</label><input type="text" id="fb-${sub.docId}" placeholder="Leave a comment or feedback..." value="${escapeHtml(sub.teacherFeedback || "")}" /></div>
          <button class="btn btn-primary" onclick="window.saveTeacherGrade('${sub.docId}', '${sub.assignmentId}', ${noBandRequired})">Save & Verify</button>
        </div>
      </div>
    `;
  }).join("");
}

window.saveTeacherGrade = async function (docId, assignmentId, noBandRequired = false) {
  const rawBand = document.getElementById(`band-${docId}`).value;
  const fbVal = document.getElementById(`fb-${docId}`).value.trim();
  const updatePayload = { teacherFeedback: fbVal, status: "graded", gradedAt: serverTimestamp() };
  if (!noBandRequired && rawBand) updatePayload.bandScore = Number(rawBand);
  await updateDoc(doc(db, "submissions", docId), updatePayload);
  
  if (assignmentId && assignmentId.startsWith("PUN_")) {
    await updateDoc(doc(db, "punishments", assignmentId), { status: "verified" }).catch(()=>console.log("Not a punishment"));
  }

  alert("Verified & feedback saved!");
  loadTeacherData();
};

document.getElementById("refresh-roster-btn")?.addEventListener("click", loadTeacherData);
document.getElementById("refresh-matrix-btn")?.addEventListener("click", loadTeacherData);
document.getElementById("refresh-grading-btn")?.addEventListener("click", loadTeacherData);

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
  if (typeof QRCode !== "undefined") {
    QRCode.toCanvas(canvas, checkinUrl, { width: 200, margin: 2, color: { dark: "#0f172a", light: "#ffffff" } }, (e) => { if(e) console.error(e); });
  }

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
    const timeStr = record?.checkedInAt?.toDate ? record.checkedInAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "—";
    let badgeClass = status === "Present" ? "badge-green" : status === "Late" ? "badge-yellow" : "badge-red";
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

document.getElementById("refresh-attendance-table-btn")?.addEventListener("click", renderTeacherAttendanceManager);
document.getElementById("refresh-qr-btn")?.addEventListener("click", renderTeacherAttendanceManager);

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
    await setDoc(doc(db, "attendance", docId), { studentId: currentStudentId, date: todayStr, status, checkedInAt: serverTimestamp() }, { merge: true });

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
  const [usersSnap, progSnap, subsSnap, mocksSnap, annSnap, hwSnap, punSnap] = await Promise.all([
    getDocs(collection(db, "users")),
    getDocs(query(collection(db, "ankiProgress"), where("studentId", "==", currentStudentId))),
    getDocs(query(collection(db, "submissions"), where("studentId", "==", currentStudentId))),
    getDocs(collection(db, "mockScores")),
    getDocs(collection(db, "announcements")),
    getDocs(collection(db, "customAssignments")),
    getDocs(query(collection(db, "punishments"), where("studentId", "==", currentStudentId)))
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

  cachedTeacherHw = [];
  hwSnap.forEach((d) => {
    const hw = d.data();
    if (hw.studentId === currentStudentId || hw.studentId === "ALL") cachedTeacherHw.push(hw);
  });

  cachedStudentPunishments = [];
  punSnap.forEach((d) => cachedStudentPunishments.push(d.data()));

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
  renderStudentPunishmentsList();
  renderResourcesList("all");
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
    if (selectedDeckId === "all" || deck.deckId === selectedDeckId) deck.cards.forEach((c) => all.push({ ...c, deckId: deck.deckId, deckTitle: deck.title }));
  });
  return all;
}

function getAllDueCountAcrossAllDecks() {
  const today = getTodayStr();
  let totalDue = 0;
  VOCAB_DECKS.forEach((deck) => {
    deck.cards.forEach((card) => { if (!ankiProgressMap[card.id] || ankiProgressMap[card.id].nextReviewDate <= today) totalDue++; });
  });
  return totalDue;
}

function populateAnkiDeckDropdown() {
  const sel = document.getElementById("anki-deck-select");
  if (!sel) return;
  const today = getTodayStr();
  const optionsHtml = [`<option value="all" ${selectedDeckId === "all" ? "selected" : ""}>All Decks (${getAllDueCountAcrossAllDecks()} due)</option>`];
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
  if (isWord) clean = clean.replace(/\((adj|adv|n|v|phr|prep)\.\)/gi, "").replace(/\s*\/\s*/g, ", ").trim();
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = "en-GB";
  utterance.rate = isWord ? 0.92 : 0.96;
  window.speechSynthesis.speak(utterance);
}

document.getElementById("anki-deck-select")?.addEventListener("change", (e) => {
  selectedDeckId = e.target.value;
  bonusMode = false;
  buildAnkiQueue();
});
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

  let fallbackWeek = "Current Assignments";
  if (typeof ASSIGNMENTS !== 'undefined' && ASSIGNMENTS.length > 0) {
    const upcoming = ASSIGNMENTS.find(a => new Date(a.dueDate) >= new Date());
    fallbackWeek = upcoming ? upcoming.week : ASSIGNMENTS[ASSIGNMENTS.length - 1].week;
  }
  const allAssignments = [
    ...ASSIGNMENTS,
    ...cachedTeacherHw.map(t => ({ id: t.id, title: t.title, skill: t.skill, dueDate: t.dueDate, week: t.week || fallbackWeek, isDynamic: true, details: t.details, status: t.status }))
  ];

  const pendingHw = allAssignments.filter((a) => !studentSubmissionsMap[a.id]).length;
  const pendingPuns = cachedStudentPunishments.filter((t) => t.status !== "verified" && t.status !== "submitted").length;

  document.getElementById("nav-due-badge").textContent = totalDue;
  document.getElementById("nav-hw-badge").textContent = pendingHw;
  document.getElementById("nav-pun-badge").textContent = pendingPuns;
  document.getElementById("dash-due-count").textContent = totalDue;
  document.getElementById("dash-streak-count").textContent = `🔥 ${activeStreak} days`;
  document.getElementById("dash-today-done").textContent = `${todayCount} reviewed today`;
  document.getElementById("dash-hw-pending").textContent = pendingHw;

  if (studentMocksList.length > 0) {
    document.getElementById("dash-latest-band").textContent = `Band ${studentMocksList[studentMocksList.length - 1].overall}`;
  } else {
    document.getElementById("dash-latest-band").textContent = "—";
  }
}
// ==========================================
// ANKI ENGINE: RENDERING & GRADING
// ==========================================
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

document.getElementById("flashcard")?.addEventListener("click", flipFlashcard);
document.getElementById("show-answer-btn")?.addEventListener("click", flipFlashcard);

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
document.getElementById("practice-all-btn")?.addEventListener("click", () => {
  bonusMode = true;
  buildAnkiQueue();
});

// ==========================================
// DYNAMIC RUNNER & DISPATCHING (SHARED)
// ==========================================
function getDynamicRunnerHTML(task, type) {
  let rightHtml = "";
  if (task.skill === "listening" || task.skill === "reading") {
    const totalQ = (task.details?.testCount || 1) * 40;
    const mistakeTypes = task.skill === "reading"
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

    const mistakeInputsHtml = mistakeTypes.map((item) => `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);">
        <span style="font-size:13px;font-weight:600;line-height:1.35;">${item.label}</span>
        <input type="number" class="dynamic-mistake-input" data-type="${item.key}" min="0" max="${totalQ}" value="0" style="width:72px;flex-shrink:0;padding:6px 8px;text-align:center;" />
      </div>`).join("");

    rightHtml = `
      <h3>Submit Score & Screenshot</h3>
      <div class="form-group"><label>Your Correct Answers (out of ${totalQ})</label><input type="number" id="dynamic-lr-score" min="0" max="${totalQ}" required /></div>
      <div class="form-group"><label>Result Screenshot (PNG / JPG)</label><input type="file" id="dynamic-lr-file" accept="image/*" multiple required /></div>
      <div class="form-group"><label>Mistakes by Question Type</label><div style="border:1px solid var(--border);border-radius:8px;padding:2px 12px;max-height:300px;overflow-y:auto;">${mistakeInputsHtml}</div></div>
      <button class="btn btn-primary btn-full" onclick="submitDynamicScreenshot(${totalQ})">Upload Screenshot & Submit Proof</button>
    `;
  } else if (task.skill === "speaking") {
    rightHtml = `
      <h3>Record Speaking Answer</h3>
      <div style="text-align:center;padding:24px 0;">
        <div id="rec-status-label" style="font-weight:600;margin-bottom:12px;">Ready to record</div>
        <div id="rec-timer-display" style="font-size:32px;font-weight:700;font-family:monospace;margin-bottom:16px;">00:00</div>
        <div style="display:flex;justify-content:center;gap:12px;margin-bottom:20px;">
          <button class="btn btn-primary" id="btn-start-rec" onclick="startBrowserRecording()">🔴 Start Recording</button>
          <button class="btn btn-outline hidden" id="btn-stop-rec" onclick="stopBrowserRecording()" style="color:var(--danger);border-color:#fecaca;">⏹ Stop Recording</button>
        </div>
        <div id="rec-preview-area" class="hidden" style="margin-top:16px;"><audio id="rec-audio-preview" controls style="width:100%;"></audio></div>
      </div>
      <button class="btn btn-primary btn-full" onclick="submitDynamicAudio()">Upload & Submit Speaking</button>
    `;
  } else if (task.skill === "writing") {
    const isTask1 = task.details?.taskType === "task1";
    const chartHtml = isTask1 ? `<div class="form-group"><label>Upload Line Graph / Chart Image (Required)</label><input type="file" id="dynamic-w-img" accept="image/*" multiple required /></div>` : "";
    rightHtml = `
      <h3>Your Essay / Report Response</h3>
      ${chartHtml}
      <div class="form-group"><label>Type your response here</label><textarea id="dynamic-w-text" rows="12" style="width:100%;padding:12px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:14px;"></textarea></div>
      <button class="btn btn-primary btn-full" onclick="submitDynamicWriting(${isTask1})">Submit Writing</button>
    `;
  } else if (task.skill === "grammar") {
    rightHtml = `
      <h3>Upload Completed Pages</h3>
      <div class="form-group"><label>Workbook Photo / Screenshot</label><input type="file" id="dynamic-gram-file" accept="image/*" multiple required /></div>
      <div class="form-group"><label>Student Notes / Questions (Optional)</label><input type="text" id="dynamic-gram-notes" /></div>
      <button class="btn btn-primary btn-full" onclick="submitDynamicGrammar()">Upload & Submit Homework</button>
    `;
  } else {
    rightHtml = `
      <h3>Submit Task Response</h3>
      <div class="form-group"><label>Attach Photo / Screenshot (Optional)</label><input type="file" id="dynamic-other-file" accept="image/*" multiple /></div>
      <div class="form-group"><label>Type your answer or notes here</label><textarea id="dynamic-response-input" rows="8" style="width:100%;padding:12px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:14px;"></textarea></div>
      <button class="btn btn-primary btn-full" onclick="submitDynamicCustom()">Submit Task</button>
    `;
  }
  return rightHtml;
}

window.startCustomHwRunner = async function (taskId) {
  const snap = await getDoc(doc(db, "customAssignments", taskId));
  if (!snap.exists()) return;
  activeDynamicTask = snap.data();
  activeDynamicCollection = "customAssignments";

  document.getElementById("hw-list-view").classList.add("hidden");
  document.getElementById("hw-runner-view").classList.add("hidden");
  document.getElementById("hw-analysis-view").classList.add("hidden");
  document.getElementById("hw-custom-runner-view").classList.remove("hidden");

  document.getElementById("hw-custom-runner-title").textContent = activeDynamicTask.title || activeDynamicTask.reason;
  document.getElementById("hw-custom-runner-due").textContent = `Due: ${formatDueDate(activeDynamicTask.dueDate)}`;

  let instructionText = `<p class="passage-box" style="margin-bottom:16px;">Complete your assigned ${activeDynamicTask.skill.toUpperCase()} task and submit your work below.</p>`;
  if (activeDynamicTask.skill === "speaking" && activeDynamicTask.details.questions) {
    instructionText = `<div class="passage-box" style="white-space:pre-line;margin-bottom:12px;">${escapeHtml(activeDynamicTask.details.questions)}</div><p class="muted">${escapeHtml(activeDynamicTask.details.notes || "")}</p>`;
  } else if (activeDynamicTask.skill === "writing") {
    instructionText = `<div class="passage-box" style="white-space:pre-line;margin-bottom:16px;">${escapeHtml(activeDynamicTask.details.promptText || activeDynamicTask.details.title)}</div>`;
  } else if (activeDynamicTask.skill === "listening" || activeDynamicTask.skill === "reading") {
    instructionText = `<p class="passage-box" style="margin-bottom:16px;">Complete ${activeDynamicTask.details.testCount || 1} test set(s). Take a screenshot of your result and enter your correct answers.</p>`;
  } else if (activeDynamicTask.skill === "grammar" || activeDynamicTask.skill === "other") {
    instructionText = `<p class="passage-box" style="margin-bottom:16px;white-space:pre-line;">${escapeHtml(activeDynamicTask.details.instructions || "Complete the assigned task.")}</p>`;
  }

  document.getElementById("hw-custom-runner-left").innerHTML = `<h3>Task Instructions</h3>${instructionText}`;
  document.getElementById("hw-custom-runner-right").innerHTML = getDynamicRunnerHTML(activeDynamicTask, "customHw");
};

window.startPunishmentRunner = async function (taskId) {
  const snap = await getDoc(doc(db, "punishments", taskId));
  if (!snap.exists()) return;
  activeDynamicTask = snap.data();
  activeDynamicCollection = "punishments";

  document.getElementById("student-punishments-container").parentElement.classList.add("hidden");
  document.getElementById("student-punishments-container").classList.add("hidden");
  document.getElementById("punishment-runner-view").classList.remove("hidden");

  document.getElementById("punishment-runner-title").textContent = activeDynamicTask.reason;
  document.getElementById("punishment-runner-due").textContent = `Due: ${formatDueDate(activeDynamicTask.dueDate)}`;

  let instructionText = `<p class="passage-box" style="margin-bottom:16px;">Complete your assigned ${activeDynamicTask.skill.toUpperCase()} punishment and submit your work below.</p>`;
  if (activeDynamicTask.skill === "speaking" && activeDynamicTask.details.questions) {
    instructionText = `<div class="passage-box" style="white-space:pre-line;margin-bottom:12px;">${escapeHtml(activeDynamicTask.details.questions)}</div><p class="muted">${escapeHtml(activeDynamicTask.details.notes || "")}</p>`;
  } else if (activeDynamicTask.skill === "writing") {
    instructionText = `<div class="passage-box" style="white-space:pre-line;margin-bottom:16px;">${escapeHtml(activeDynamicTask.details.promptText || activeDynamicTask.details.title)}</div>`;
  } else if (activeDynamicTask.skill === "listening" || activeDynamicTask.skill === "reading") {
    instructionText = `<p class="passage-box" style="margin-bottom:16px;">Complete ${activeDynamicTask.details.testCount || 1} test set(s). Take a screenshot of your result and enter your correct answers.</p>`;
  } else if (activeDynamicTask.skill === "grammar" || activeDynamicTask.skill === "other") {
    instructionText = `<p class="passage-box" style="margin-bottom:16px;white-space:pre-line;">${escapeHtml(activeDynamicTask.details.instructions || "Complete the assigned remedial task.")}</p>`;
  }

  document.getElementById("pun-runner-left").innerHTML = `<h3>Punishment Instructions</h3>${instructionText}`;
  document.getElementById("pun-runner-right").innerHTML = getDynamicRunnerHTML(activeDynamicTask, "punishment");
};

async function uploadMultipleFiles(fileInputId) {
  const files = document.getElementById(fileInputId)?.files;
  if (!files || files.length === 0) return null;
  const urls = [];
  for (let i = 0; i < files.length; i++) {
    const formData = new FormData(); formData.append("file", files[i]); formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, { method: "POST", body: formData });
    const data = await res.json();
    if (data.secure_url) urls.push(data.secure_url);
  }
 return urls.length > 0 ? urls : null;
}

window.submitDynamicScreenshot = async function(totalQ) {
  const fileInput = document.getElementById("dynamic-lr-file");
  const rawScore = Number(document.getElementById("dynamic-lr-score").value);
  if (!fileInput.files.length || isNaN(rawScore)) return alert("Please enter your score and attach a screenshot.");

  const mistakeCounts = {};
  const updatedMistakes = { ...(currentStudentProfile.permanentMistakes || {}) };
  document.querySelectorAll(".dynamic-mistake-input").forEach((inp) => {
    const type = inp.dataset.type;
    const wrongNum = Math.max(0, Number(inp.value) || 0);
    mistakeCounts[type] = wrongNum;
    if (wrongNum > 0) updatedMistakes[type] = { wrong: (updatedMistakes[type]?.wrong || 0) + wrongNum };
  });

  const urls = await uploadMultipleFiles("dynamic-lr-file");
  if (!urls) return alert("Upload failed.");

  await updateDoc(doc(db, "users", currentStudentId), { permanentMistakes: updatedMistakes });
  currentStudentProfile.permanentMistakes = updatedMistakes;

  const submissionData = {
    status: "submitted",
    submission: { scoreText: `${rawScore} / ${totalQ}`, screenshotUrls: urls, mistakeCounts },
    submittedAt: serverTimestamp()
  };

  await setDoc(doc(db, "submissions", `${activeDynamicTask.id}_${currentStudentId}`), {
    assignmentId: activeDynamicTask.id, studentId: currentStudentId, skill: activeDynamicTask.skill, status: "submitted",
    isLate: new Date() > new Date(activeDynamicTask.dueDate), submittedAt: serverTimestamp(),
    rawScore, totalQuestions: totalQ, screenshotUrls: urls, mistakeCounts
  });

  await updateDoc(doc(db, activeDynamicCollection, activeDynamicTask.id), submissionData);

  alert("Task submitted successfully!");
  if (activeDynamicCollection === "customAssignments") {
    studentSubmissionsMap[activeDynamicTask.id] = { status: "submitted" };
    document.getElementById("back-to-hw-custom-btn").click();
  } else {
    const idx = cachedStudentPunishments.findIndex(t => t.id === activeDynamicTask.id);
    if (idx !== -1) cachedStudentPunishments[idx].status = "submitted";
    document.getElementById("back-to-punishments-btn").click();
  }
  updateDashboardUI();
};

window.submitDynamicWriting = async function(isTask1) {
  const text = document.getElementById("dynamic-w-text").value.trim();
  const fileInput = document.getElementById("dynamic-w-img");
  if (!text) return alert("Please type your response.");
  if (isTask1 && !fileInput?.files.length) return alert("Please upload your chart.");

  const urls = await uploadMultipleFiles("dynamic-w-img");

  await setDoc(doc(db, "submissions", `${activeDynamicTask.id}_${currentStudentId}`), {
    assignmentId: activeDynamicTask.id, studentId: currentStudentId, skill: "writing", status: "submitted",
    isLate: new Date() > new Date(activeDynamicTask.dueDate), submittedAt: serverTimestamp(), essayText: text, chartImageUrls: urls
  });

  await updateDoc(doc(db, activeDynamicCollection, activeDynamicTask.id), { status: "submitted", submission: { text, chartImageUrls: urls }, submittedAt: serverTimestamp() });
  
  alert("Writing submitted successfully!");
  if (activeDynamicCollection === "customAssignments") {
    studentSubmissionsMap[activeDynamicTask.id] = { status: "submitted" };
    document.getElementById("back-to-hw-custom-btn").click();
  } else {
    const idx = cachedStudentPunishments.findIndex(t => t.id === activeDynamicTask.id);
    if (idx !== -1) cachedStudentPunishments[idx].status = "submitted";
    document.getElementById("back-to-punishments-btn").click();
  }
  updateDashboardUI();
};

window.submitDynamicAudio = async function () {
  if (!recordedAudioBlob) return alert("Please record your audio first.");
  const formData = new FormData();
  formData.append("file", recordedAudioBlob, `task_${activeDynamicTask.id}.webm`);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/video/upload`, { method: "POST", body: formData });
  const data = await res.json();
  if (!data.secure_url) return alert("Audio upload failed.");

  await setDoc(doc(db, "submissions", `${activeDynamicTask.id}_${currentStudentId}`), {
    assignmentId: activeDynamicTask.id, studentId: currentStudentId, skill: "speaking", status: "submitted",
    isLate: new Date() > new Date(activeDynamicTask.dueDate), submittedAt: serverTimestamp(), audioUrl: data.secure_url
  });

  await updateDoc(doc(db, activeDynamicCollection, activeDynamicTask.id), { status: "submitted", submission: { audioUrl: data.secure_url }, submittedAt: serverTimestamp() });
  
  alert("Speaking task submitted!");
  if (activeDynamicCollection === "customAssignments") {
    studentSubmissionsMap[activeDynamicTask.id] = { status: "submitted" };
    document.getElementById("back-to-hw-custom-btn").click();
  } else {
    const idx = cachedStudentPunishments.findIndex(t => t.id === activeDynamicTask.id);
    if (idx !== -1) cachedStudentPunishments[idx].status = "submitted";
    document.getElementById("back-to-punishments-btn").click();
  }
  updateDashboardUI();
};

window.submitDynamicGrammar = async function() {
  const fileInput = document.getElementById("dynamic-gram-file");
  const notes = document.getElementById("dynamic-gram-notes").value.trim();
  if (!fileInput?.files?.length) return alert("Please upload photos of your workbook.");

  const urls = await uploadMultipleFiles("dynamic-gram-file");

  await setDoc(doc(db, "submissions", `${activeDynamicTask.id}_${currentStudentId}`), {
    assignmentId: activeDynamicTask.id, studentId: currentStudentId, skill: "grammar", status: "submitted",
    isLate: new Date() > new Date(activeDynamicTask.dueDate), submittedAt: serverTimestamp(), screenshotUrls: urls, notes
  });

  await updateDoc(doc(db, activeDynamicCollection, activeDynamicTask.id), { status: "submitted", submission: { screenshotUrls: urls }, submittedAt: serverTimestamp() });
  
  alert("Grammar uploaded successfully!");
  if (activeDynamicCollection === "customAssignments") {
    studentSubmissionsMap[activeDynamicTask.id] = { status: "submitted" };
    document.getElementById("back-to-hw-custom-btn").click();
  } else {
    const idx = cachedStudentPunishments.findIndex(t => t.id === activeDynamicTask.id);
    if (idx !== -1) cachedStudentPunishments[idx].status = "submitted";
    document.getElementById("back-to-punishments-btn").click();
  }
  updateDashboardUI();
};

window.submitDynamicCustom = async function() {
  const text = document.getElementById("dynamic-response-input").value.trim();
  const fileInput = document.getElementById("dynamic-other-file");
  if (!text && !fileInput?.files.length) return alert("Please enter your response or attach files.");

  const urls = await uploadMultipleFiles("dynamic-other-file");

  await setDoc(doc(db, "submissions", `${activeDynamicTask.id}_${currentStudentId}`), {
    assignmentId: activeDynamicTask.id, studentId: currentStudentId, skill: "other", status: "submitted",
    isLate: new Date() > new Date(activeDynamicTask.dueDate), submittedAt: serverTimestamp(), notes: text, screenshotUrls: urls
  });

  await updateDoc(doc(db, activeDynamicCollection, activeDynamicTask.id), { status: "submitted", submission: { responseText: text, screenshotUrls: urls }, submittedAt: serverTimestamp() });
  
  alert("Task submitted successfully!");
  if (activeDynamicCollection === "customAssignments") {
    studentSubmissionsMap[activeDynamicTask.id] = { status: "submitted" };
    document.getElementById("back-to-hw-custom-btn").click();
  } else {
    const idx = cachedStudentPunishments.findIndex(t => t.id === activeDynamicTask.id);
    if (idx !== -1) cachedStudentPunishments[idx].status = "submitted";
    document.getElementById("back-to-punishments-btn").click();
  }
  updateDashboardUI();
};

// ==========================================
// STUDENT ASSIGNMENTS WORKFLOW (UNIFIED ALL)
// ==========================================
function showHomeworkListView() {
  stopActiveRecordingCleanup();
  document.getElementById("hw-list-view").classList.remove("hidden");
  document.getElementById("hw-runner-view").classList.add("hidden");
  document.getElementById("hw-analysis-view").classList.add("hidden");
  renderAssignmentsList();
}

document.getElementById("back-to-hw-btn")?.addEventListener("click", showHomeworkListView);
document.getElementById("back-from-analysis-btn")?.addEventListener("click", showHomeworkListView);

let hwViewFilter = "todo";

function renderAssignmentsList() {
  const container = document.getElementById("assignments-list-container");
  if (!container) return;
  const now = new Date();
  const todoList = [];
  const doneList = [];

  let fallbackWeek = "Current Assignments";
  if (typeof ASSIGNMENTS !== 'undefined' && ASSIGNMENTS.length > 0) {
    const upcoming = ASSIGNMENTS.find(a => new Date(a.dueDate) >= now);
    fallbackWeek = upcoming ? upcoming.week : ASSIGNMENTS[ASSIGNMENTS.length - 1].week;
  }

  const mappedDynamicHw = cachedTeacherHw.map(t => {
    const isTask1 = t.details?.taskType === "task1";
    let instructions = "";
    if (t.skill === "speaking") instructions = (t.details?.questions || "") + "\n\n" + (t.details?.notes || "");
    else if (t.skill === "grammar" || t.skill === "other") instructions = t.details?.instructions || "";
    else if (t.skill === "listening" || t.skill === "reading") instructions = `Complete ${t.details?.testCount || 1} test set(s). Take a screenshot of your result.`;

    let displayWeek = t.week;
    if (!displayWeek || displayWeek === "Custom Assignments" || displayWeek === "Custom Teacher Tasks") displayWeek = fallbackWeek;

    return {
      id: t.id, title: t.title || t.reason, skill: t.skill, dueDate: t.dueDate, week: displayWeek,
      isDynamic: true, totalQuestions: (t.details?.testCount || 1) * 40, instructions: instructions.trim(),
      promptText: t.details?.promptText || t.title, isTask1, details: t.details, status: t.status
    };
  });

  const allAssignments = [...ASSIGNMENTS, ...mappedDynamicHw];

  allAssignments.forEach((hw) => {
    const isSub = studentSubmissionsMap[hw.id] || hw.status === "submitted" || hw.status === "verified";
    if (isSub) doneList.push(hw);
    else todoList.push(hw);
  });

  const filterControls = `
    <div style="display:flex;gap:8px;margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:12px;">
      <button class="btn ${hwViewFilter === "todo" ? "btn-primary" : "btn-outline"} btn-sm" id="btn-hw-todo">To Do (${todoList.length})</button>
      <button class="btn ${hwViewFilter === "completed" ? "btn-primary" : "btn-outline"} btn-sm" id="btn-hw-done">Completed & Graded (${doneList.length})</button>
    </div>
  `;

  const activeList = hwViewFilter === "todo" ? todoList : doneList;
  if (activeList.length === 0) {
    container.innerHTML = filterControls + `<p class="muted center" style="padding:24px 0;">${hwViewFilter === "todo" ? "🎉 All assignments completed!" : "No completed assignments yet."}</p>`;
    document.getElementById("btn-hw-todo")?.addEventListener("click", () => { hwViewFilter = "todo"; renderAssignmentsList(); });
    document.getElementById("btn-hw-done")?.addEventListener("click", () => { hwViewFilter = "completed"; renderAssignmentsList(); });
    return;
  }

  const grouped = {};
  activeList.forEach((hw) => {
    const wk = hw.week || fallbackWeek;
    if (!grouped[wk]) grouped[wk] = [];
    grouped[wk].push(hw);
  });

  const groupsHtml = Object.entries(grouped).map(([weekTitle, items]) => {
    const cardsHtml = items.map((hw) => {
      const sub = studentSubmissionsMap[hw.id];
      const isPastDue = now > new Date(hw.dueDate);
      const isSub = sub || hw.status === "submitted" || hw.status === "verified";
      
      let statusBadge = "";
      let actionBtn = "";
      let feedbackHtml = "";

      if (isSub) {
        if (sub && sub.status === "graded") {
          statusBadge = sub.bandScore ? `<span class="badge badge-green">Verified: Band ${sub.bandScore}</span>` : `<span class="badge badge-green">Checked by Teacher</span>`;
        } else if (sub && sub.isLate) {
          statusBadge = `<span class="badge badge-red">Submitted Late${sub.bandScore ? ` • Band ${sub.bandScore}` : ""}</span>`;
        } else {
          statusBadge = `<span class="badge badge-blue">Submitted${(sub && sub.bandScore) ? ` • Band ${sub.bandScore}` : ""}</span>`;
        }
        if (sub && sub.teacherFeedback) feedbackHtml = `<div class="feedback-callout"><strong>Teacher Feedback:</strong> ${escapeHtml(sub.teacherFeedback)}</div>`;
        if (sub && (hw.skill === "reading" || hw.skill === "listening")) actionBtn = `<button class="btn btn-outline btn-sm" onclick="window.openAnalysisPage('${hw.id}')">View Receipt</button>`;
        else actionBtn = `<span class="muted" style="font-size:13px;margin:0;">Submitted</span>`;
      } else {
        statusBadge = isPastDue ? `<span class="badge badge-gray">Missing (Past Due)</span>` : `<span class="badge badge-yellow">Due ${formatDueDate(hw.dueDate)}</span>`;
        actionBtn = `<button class="btn btn-primary btn-sm" onclick="window.startAssignment('${hw.id}')">Submit</button>`;
      }

      return `
        <div class="hw-item">
          <div style="flex:1;min-width:240px;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span class="role-pill">${hw.skill.toUpperCase()}</span>
              <strong>${escapeHtml(hw.title)}</strong>
            </div>
            <div class="hw-meta"><span>Deadline: ${formatDueDate(hw.dueDate)}</span>${statusBadge}</div>
            ${feedbackHtml}
          </div>
          <div>${actionBtn}</div>
        </div>
      `;
    }).join("");
    return `<div style="margin-bottom:18px;"><h3 style="font-size:14px;color:var(--primary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">${escapeHtml(weekTitle)}</h3><div style="display:flex;flex-direction:column;gap:12px;">${cardsHtml}</div></div>`;
  }).join("");

  container.innerHTML = filterControls + groupsHtml;
  document.getElementById("btn-hw-todo")?.addEventListener("click", () => { hwViewFilter = "todo"; renderAssignmentsList(); });
  document.getElementById("btn-hw-done")?.addEventListener("click", () => { hwViewFilter = "completed"; renderAssignmentsList(); });
}

window.startAssignment = function (assignmentId) {
  let fallbackWeek = "Current Assignments";
  if (typeof ASSIGNMENTS !== 'undefined' && ASSIGNMENTS.length > 0) {
    const upcoming = ASSIGNMENTS.find(a => new Date(a.dueDate) >= new Date());
    fallbackWeek = upcoming ? upcoming.week : ASSIGNMENTS[ASSIGNMENTS.length - 1].week;
  }
  const mappedDynamicHw = cachedTeacherHw.map(t => {
    const isTask1 = t.details?.taskType === "task1";
    let instructions = "";
    if (t.skill === "speaking") instructions = (t.details?.questions || "") + "\n\n" + (t.details?.notes || "");
    else if (t.skill === "grammar" || t.skill === "other") instructions = t.details?.instructions || "";
    else if (t.skill === "listening" || t.skill === "reading") instructions = `Complete ${t.details?.testCount || 1} test set(s). Take a screenshot of your result.`;
    return {
      id: t.id, title: t.title || t.reason, skill: t.skill, dueDate: t.dueDate, week: t.week || fallbackWeek,
      isDynamic: true, totalQuestions: (t.details?.testCount || 1) * 40, instructions: instructions.trim(),
      promptText: t.details?.promptText || t.title, isTask1, details: t.details, status: t.status
    };
  });

  const allAssignments = [...ASSIGNMENTS, ...mappedDynamicHw];
  const hw = allAssignments.find((a) => a.id === assignmentId);
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
      const drillTypes = hw.drillTypes || [{ key: "TFNG", label: "True / False / Not Given" }, { key: "YNNG", label: "Yes / No / Not Given" }];
      leftPane.innerHTML = `<h3>Drill Instructions</h3><p class="passage-box" style="margin-bottom:16px;">${escapeHtml(hw.instructions)}</p>
        <div style="background:#f8fafc;border:1px solid var(--border);padding:14px;border-radius:8px;font-size:13px;"><strong>How this works:</strong><br/>Enter how many questions you got right and total questions for each type.</div>`;
      const drillRowsHtml = drillTypes.map((item) => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;">
          <span style="font-size:14px;font-weight:600;">${item.label}</span>
          <div style="display:flex;align-items:center;gap:8px;">
            <input type="number" class="drill-correct-input" data-type="${item.key}" min="0" placeholder="Correct" style="width:84px;padding:6px 8px;text-align:center;" required />
            <span style="font-weight:700;color:var(--muted);">/</span>
            <input type="number" class="drill-total-input" data-type="${item.key}" min="0" placeholder="Total" style="width:84px;padding:6px 8px;text-align:center;" required />
          </div>
        </div>`).join("");
      rightPane.innerHTML = `<h3>Submit Drill Score</h3><div class="form-group"><label>Upload Result Screenshot</label><input type="file" id="lr-screenshot-file" accept="image/*" multiple required /></div>
        <div class="form-group"><label>Score Breakdown</label><div style="border:1px solid var(--border);border-radius:8px;padding:2px 14px;">${drillRowsHtml}</div></div>
        <button class="btn btn-primary btn-full" id="submit-lr-btn">Upload Screenshot & Submit Drill</button>`;
      document.getElementById("submit-lr-btn").addEventListener("click", () => submitScreenshotHomework(hw));
    } else {
      const totalQ = hw.totalQuestions || 40;
      const mistakeTypes = hw.skill === "reading"
        ? [ { key: "MCQ", label: "Multiple Choice" }, { key: "TFNG", label: "True / False / Not Given" }, { key: "YNNG", label: "Yes / No / Not Given" }, { key: "MATCHING_HEADINGS", label: "Matching Headings" }, { key: "MATCHING_INFO", label: "Matching Information" }, { key: "MATCHING_FEATURES", label: "Matching Features" }, { key: "MATCHING_SENTENCE_ENDINGS", label: "Matching Sentence Endings" }, { key: "SENTENCE_COMPLETION", label: "Sentence Completion" }, { key: "SUMMARY_COMPLETION", label: "Summary Completion" }, { key: "NOTE_COMPLETION", label: "Note Completion" }, { key: "TABLE_COMPLETION", label: "Table Completion" }, { key: "FLOW_CHART_COMPLETION", label: "Flow-chart Completion" }, { key: "DIAGRAM_LABELLING", label: "Diagram Labelling" }, { key: "SHORT_ANSWER", label: "Short-Answer Questions" } ]
        : [ { key: "MCQ", label: "Multiple Choice" }, { key: "MATCHING", label: "Matching" }, { key: "MAP_DIAGRAM", label: "Plan, Map, or Diagram Labelling" }, { key: "FORM_NOTE_TABLE_SUMMARY", label: "Form, Note, Table, Flow-Chart, or Summary Completion" }, { key: "SENTENCE_COMPLETION", label: "Sentence Completion" }, { key: "SHORT_ANSWER", label: "Short-Answer Questions" } ];
      
      leftPane.innerHTML = `<h3>Instructions</h3><p class="passage-box" style="margin-bottom:16px;">${escapeHtml(hw.instructions)}</p>
        <div style="background:#f8fafc;border:1px solid var(--border);padding:14px;border-radius:8px;font-size:13px;"><strong>How to log your mistakes:</strong><br/>Count how many questions you missed in each category.</div>`;
      const mistakeInputsHtml = mistakeTypes.map((item) => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);">
          <span style="font-size:13px;font-weight:600;line-height:1.35;">${item.label}</span>
          <input type="number" class="mistake-type-input" data-type="${item.key}" min="0" max="${totalQ}" value="0" style="width:72px;flex-shrink:0;padding:6px 8px;text-align:center;" />
        </div>`).join("");
      rightPane.innerHTML = `<h3>Submit Score</h3><div class="form-group"><label>Your Correct Answers (out of ${totalQ})</label><input type="number" id="lr-raw-score" min="0" max="${totalQ}" required /></div>
        <div class="form-group"><label>Upload Result Screenshot</label><input type="file" id="lr-screenshot-file" accept="image/*" multiple required /></div>
        <div class="form-group"><label>Mistakes by Question Type</label><div style="border:1px solid var(--border);border-radius:8px;padding:2px 12px;max-height:300px;overflow-y:auto;">${mistakeInputsHtml}</div></div>
        <button class="btn btn-primary btn-full" id="submit-lr-btn">Upload Screenshot & Submit Score</button>`;
      document.getElementById("submit-lr-btn").addEventListener("click", () => submitScreenshotHomework(hw));
    }
  } else if (hw.skill === "writing") {
    const chartHtml = hw.isTask1 || hw.id === "HW-05" ? `<div class="form-group"><label>Upload Line Graph / Chart Image (Required)</label><input type="file" id="writing-chart-file" accept="image/*" multiple required /></div>` : "";
    leftPane.innerHTML = `<h3>Instructions</h3><p class="passage-box" style="margin-bottom:16px;white-space:pre-line;">${escapeHtml(hw.promptText || hw.title)}</p>`;
    rightPane.innerHTML = `<h3>Your Essay / Report Response</h3>
      ${chartHtml}
      <div class="form-group"><label>Type your response here</label><textarea id="writing-essay-input" rows="12" style="width:100%;padding:12px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:14px;"></textarea></div>
      <button class="btn btn-primary btn-full" id="submit-writing-btn">Submit Writing</button>`;
    document.getElementById("submit-writing-btn").addEventListener("click", () => submitWritingHomework(hw));
  } else if (hw.skill === "speaking") {
    leftPane.innerHTML = `<h3>Instructions</h3><p class="passage-box" style="margin-bottom:16px;white-space:pre-line;">${escapeHtml(hw.instructions)}</p>`;
    rightPane.innerHTML = `
      <h3>Record Speaking Answer</h3>
      <div style="text-align:center;padding:24px 0;">
        <div id="rec-status-label" style="font-weight:600;margin-bottom:12px;">Ready to record</div>
        <div id="rec-timer-display" style="font-size:32px;font-weight:700;font-family:monospace;margin-bottom:16px;">00:00</div>
        <div style="display:flex;justify-content:center;gap:12px;margin-bottom:20px;">
          <button class="btn btn-primary" id="btn-start-rec" onclick="startBrowserRecording()">🔴 Start Recording</button>
          <button class="btn btn-outline hidden" id="btn-stop-rec" onclick="stopBrowserRecording()" style="color:var(--danger);border-color:#fecaca;">⏹ Stop Recording</button>
        </div>
        <div id="rec-preview-area" class="hidden" style="margin-top:16px;"><audio id="rec-audio-preview" controls style="width:100%;"></audio></div>
      </div>
      <button class="btn btn-primary btn-full" id="submit-speaking-btn" onclick="submitSpeakingHomework('${hw.id}')">Upload & Submit Speaking</button>
    `;
  } else if (hw.skill === "grammar") {
    leftPane.innerHTML = `<h3>Instructions</h3><p class="passage-box" style="margin-bottom:16px;white-space:pre-line;">${escapeHtml(hw.instructions)}</p>`;
    rightPane.innerHTML = `
      <h3>Upload Completed Pages</h3>
      <div class="form-group"><label>Workbook Photo / Screenshot</label><input type="file" id="gram-file" accept="image/*" multiple required /></div>
      <div class="form-group"><label>Student Notes / Questions (Optional)</label><input type="text" id="gram-notes" /></div>
      <button class="btn btn-primary btn-full" id="submit-gram-btn">Upload & Submit Homework</button>
    `;
    document.getElementById("submit-gram-btn").addEventListener("click", () => submitGrammarHomework(hw));
  } else {
    leftPane.innerHTML = `<h3>Instructions</h3><p class="passage-box" style="margin-bottom:16px;white-space:pre-line;">${escapeHtml(hw.instructions)}</p>`;
    rightPane.innerHTML = `
      <h3>Submit Task Response</h3>
      <div class="form-group"><label>Attach Photo / Screenshot (Optional)</label><input type="file" id="other-file" accept="image/*" multiple /></div>
      <div class="form-group"><label>Type your answer or notes here</label><textarea id="other-notes" rows="8" style="width:100%;padding:12px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:14px;"></textarea></div>
      <button class="btn btn-primary btn-full" id="submit-other-btn">Submit Task</button>
    `;
    document.getElementById("submit-other-btn").addEventListener("click", () => submitOtherHomework(hw));
  }
};

async function submitScreenshotHomework(hw) {
  const isDrill = Boolean(hw.isDrill);
  const fileInput = document.getElementById("lr-screenshot-file");
  if (!fileInput.files.length) return alert("Please attach your result screenshots.");

  let rawVal = 0; let totalQ = hw.totalQuestions || 40;
  const mistakeCounts = {}; const drillBreakdown = {};
  const updatedMistakes = { ...(currentStudentProfile.permanentMistakes || {}) };

  if (isDrill) {
    let sumCorrect = 0; let sumTotal = 0;
    const correctInputs = document.querySelectorAll(".drill-correct-input");
    for (const cInp of correctInputs) {
      const type = cInp.dataset.type;
      const tInp = document.querySelector(`.drill-total-input[data-type="${type}"]`);
      if (cInp.value === "" || tInp.value === "") return alert(`Please enter both Correct and Total for ${MISTAKE_LABELS[type] || type}.`);
      const correctNum = Number(cInp.value); const totalNum = Number(tInp.value);
      if (isNaN(correctNum) || isNaN(totalNum) || correctNum < 0 || totalNum < 0 || correctNum > totalNum) return alert(`Invalid numbers for ${type}.`);
      const wrongNum = totalNum - correctNum;
      sumCorrect += correctNum; sumTotal += totalNum;
      drillBreakdown[type] = { correct: correctNum, total: totalNum };
      mistakeCounts[type] = wrongNum;
      if (wrongNum > 0) updatedMistakes[type] = { wrong: (updatedMistakes[type]?.wrong || 0) + wrongNum };
    }
    if (sumTotal === 0) return alert("Total questions must be greater than 0.");
    rawVal = sumCorrect; totalQ = sumTotal;
  } else {
    rawVal = Number(document.getElementById("lr-raw-score").value);
    if (isNaN(rawVal) || document.getElementById("lr-raw-score").value === "" || rawVal < 0 || rawVal > totalQ) return alert(`Please enter a valid score between 0 and ${totalQ}.`);
    document.querySelectorAll(".mistake-type-input").forEach((inp) => {
      const type = inp.dataset.type; const wrongNum = Math.max(0, Number(inp.value) || 0);
      mistakeCounts[type] = wrongNum;
      if (wrongNum > 0) updatedMistakes[type] = { wrong: (updatedMistakes[type]?.wrong || 0) + wrongNum };
    });
  }

  const btn = document.getElementById("submit-lr-btn");
  btn.disabled = true; btn.textContent = "Uploading screenshots...";

  try {
    const urls = await uploadMultipleFiles("lr-screenshot-file");
    if (!urls) throw new Error("Screenshot upload failed");

    const isRealPracticeTest = !isDrill && totalQ === 40;
    const bandScore = isRealPracticeTest ? rawToIeltsBand(rawVal, 40) : null;
    const isLate = new Date() > new Date(hw.dueDate);
    const submissionData = {
      assignmentId: hw.id, studentId: currentStudentId, skill: hw.skill, isDrill: !isRealPracticeTest, status: "submitted", isLate, submittedAt: serverTimestamp(),
      rawScore: rawVal, totalQuestions: totalQ, bandScore, screenshotUrls: urls, mistakeCounts, drillBreakdown
    };

    if (hw.isDynamic) await updateDoc(doc(db, "customAssignments", hw.id), { status: "submitted" });

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
    btn.disabled = false; btn.textContent = isDrill ? "Upload Screenshot & Submit Drill" : "Upload Screenshot & Submit Score";
  }
}

async function submitWritingHomework(hw) {
  const text = document.getElementById("writing-essay-input").value.trim();
  const fileInput = document.getElementById("writing-chart-file");
  if (!text) return alert("Please write your essay or report before submitting.");
  if ((hw.id === "HW-05" || hw.isTask1) && !fileInput?.files.length) return alert("Please upload an image of the line graph you wrote about.");

  const btn = document.getElementById("submit-writing-btn");
  btn.disabled = true; btn.textContent = "Submitting...";

  try {
    const urls = await uploadMultipleFiles("writing-chart-file");
    const isLate = new Date() > new Date(hw.dueDate);
    const submissionData = {
      assignmentId: hw.id, studentId: currentStudentId, skill: "writing", status: "submitted", isLate, submittedAt: serverTimestamp(),
      essayText: text, wordCount: text.split(/\s+/).filter(Boolean).length, chartImageUrls: urls
    };

    if (hw.isDynamic) await updateDoc(doc(db, "customAssignments", hw.id), { status: "submitted" });
    await setDoc(doc(db, "submissions", `${hw.id}_${currentStudentId}`), submissionData);
    
    studentSubmissionsMap[hw.id] = submissionData;
    updateDashboardUI();
    alert("Writing submitted successfully!");
    showHomeworkListView();
  } catch (err) {
    alert("Submission error: " + err.message);
    btn.disabled = false; btn.textContent = "Submit Writing";
  }
}

async function submitGrammarHomework(hw) {
  const fileInput = document.getElementById("gram-file");
  const notes = document.getElementById("gram-notes").value.trim();
  if (!fileInput.files.length) return alert("Please select photos of your completed grammar pages.");

  const btn = document.getElementById("submit-gram-btn");
  btn.disabled = true; btn.textContent = "Uploading images...";

  try {
    const urls = await uploadMultipleFiles("gram-file");
    if (!urls) throw new Error("Image upload failed");

    const isLate = new Date() > new Date(hw.dueDate);
    const submissionData = {
      assignmentId: hw.id, studentId: currentStudentId, skill: "grammar", status: "submitted", isLate, submittedAt: serverTimestamp(), screenshotUrls: urls, notes
    };

    if (hw.isDynamic) await updateDoc(doc(db, "customAssignments", hw.id), { status: "submitted" });
    await setDoc(doc(db, "submissions", `${hw.id}_${currentStudentId}`), submissionData);
    
    studentSubmissionsMap[hw.id] = submissionData;
    updateDashboardUI();
    alert("Grammar homework uploaded!");
    showHomeworkListView();
  } catch (err) {
    alert("Upload error: " + err.message);
    btn.disabled = false; btn.textContent = "Upload & Submit Grammar Homework";
  }
}

async function submitOtherHomework(hw) {
  const notes = document.getElementById("other-notes").value.trim();
  const fileInput = document.getElementById("other-file");
  if (!notes && !fileInput?.files.length) return alert("Please enter notes or attach a file before submitting.");
  
  const btn = document.getElementById("submit-other-btn");
  btn.disabled = true; btn.textContent = fileInput?.files.length ? "Uploading images..." : "Submitting...";

  try {
    const urls = await uploadMultipleFiles("other-file");
    const isLate = new Date() > new Date(hw.dueDate);
    const submissionData = {
      assignmentId: hw.id, studentId: currentStudentId, skill: "other", status: "submitted", isLate, submittedAt: serverTimestamp(), notes, screenshotUrls: urls
    };

    if (hw.isDynamic) await updateDoc(doc(db, "customAssignments", hw.id), { status: "submitted" });
    await setDoc(doc(db, "submissions", `${hw.id}_${currentStudentId}`), submissionData);
    
    studentSubmissionsMap[hw.id] = submissionData;
    updateDashboardUI();
    alert("Task submitted successfully!");
    showHomeworkListView();
  } catch (err) {
    alert("Submission error: " + err.message);
    btn.disabled = false; btn.textContent = "Submit Task";
  }
}

window.openAnalysisPage = function (assignmentId) {
  let fallbackWeek = "Current Assignments";
  if (typeof ASSIGNMENTS !== 'undefined' && ASSIGNMENTS.length > 0) {
    const upcoming = ASSIGNMENTS.find(a => new Date(a.dueDate) >= new Date());
    fallbackWeek = upcoming ? upcoming.week : ASSIGNMENTS[ASSIGNMENTS.length - 1].week;
  }
  const allAssignments = [...ASSIGNMENTS, ...cachedTeacherHw.map(t => ({ id: t.id, title: t.title || t.reason, week: t.week || fallbackWeek }))];
  const hw = allAssignments.find((a) => a.id === assignmentId);
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
  document.getElementById("ana-band-score").textContent = sub.bandScore ? `Band ${sub.bandScore}` : "Practice Drill";
  document.getElementById("ana-accuracy").textContent = `${pct}%`;

  const allImgs = Array.isArray(sub.screenshotUrls) ? sub.screenshotUrls : (sub.screenshotUrl ? [sub.screenshotUrl] : []);
  document.getElementById("ana-screenshot-box").innerHTML = allImgs.length > 0
    ? allImgs.map(url => `<a href="${url}" target="_blank"><img src="${url}" alt="Result Screenshot" style="width:100%;border-radius:8px;border:1px solid var(--border);margin-bottom:8px;" /></a>`).join("")
    : `<p class="muted">No screenshot attached.</p>`;
  
  const logged = Object.entries(sub.mistakeCounts || {}).filter(([, v]) => v > 0);
  document.getElementById("ana-type-breakdown").innerHTML = logged.length > 0
    ? logged.map(([type, count] ) => `
        <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">
          <strong>${MISTAKE_LABELS[type] || type}</strong>
          <span class="badge badge-red">${count} mistake${count > 1 ? "s" : ""}</span>
        </div>
      `).join("")
    : `<p class="muted">No specific question-type mistakes logged for this test.</p>`;
};

window.startBrowserRecording = async function () {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    recordedAudioBlob = null;
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
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
  } catch (err) { alert("Microphone access denied."); }
};

window.stopBrowserRecording = function () {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  clearInterval(recInterval);
  document.getElementById("rec-status-label").textContent = "Recording captured — listen below or re-record";
  document.getElementById("btn-stop-rec").classList.add("hidden");
  document.getElementById("btn-start-rec").textContent = "↻ Re-record";
  document.getElementById("btn-start-rec").classList.remove("hidden");
};

function stopActiveRecordingCleanup() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  clearInterval(recInterval);
}

window.submitSpeakingHomework = async function (assignmentId) {
  if (!recordedAudioBlob) return alert("Please record your speaking answer first.");
  const btn = document.getElementById("submit-speaking-btn") || document.getElementById("pun-submit-speaking-btn");
  btn.disabled = true; btn.textContent = "Uploading audio...";

  try {
    const formData = new FormData(); formData.append("file", recordedAudioBlob, `${assignmentId}_${currentStudentId}.webm`); formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/video/upload`, { method: "POST", body: formData });
    const data = await res.json();
    if (!data.secure_url) throw new Error(data.error?.message || "Upload failed");

    // We don't have hw object if it's from punish, so fetch it dynamically or just use current date
    const submissionData = {
      assignmentId: assignmentId, studentId: currentStudentId, skill: "speaking", status: "submitted",
      isLate: false, submittedAt: serverTimestamp(), audioUrl: data.secure_url
    };

    if (assignmentId.includes("CUSTOMHW")) await updateDoc(doc(db, "customAssignments", assignmentId), { status: "submitted" });
    if (assignmentId.includes("PUN_")) await updateDoc(doc(db, "punishments", assignmentId), { status: "submitted", submission: { audioUrl: data.secure_url } });

    await setDoc(doc(db, "submissions", `${assignmentId}_${currentStudentId}`), submissionData);
    studentSubmissionsMap[assignmentId] = submissionData;
    updateDashboardUI();
    alert("Speaking recording uploaded!");
    if (assignmentId.includes("PUN_")) document.getElementById("back-to-punishments-btn").click();
    else showHomeworkListView();
  } catch (err) {
    alert("Audio upload error: " + err.message);
    btn.disabled = false; btn.textContent = "Upload & Submit Recording";
  }
};

// ==========================================
// STUDENT PUNISHMENTS & EXTRAS WORKFLOW
// ==========================================
async function renderStudentPunishmentsList() {
  const container = document.getElementById("student-punishments-container");
  if (!container) return;

  const pendingCount = cachedStudentPunishments.filter((t) => t.status !== "verified" && t.status !== "submitted").length;
  document.getElementById("nav-pun-badge").textContent = pendingCount;

  if (cachedStudentPunishments.length === 0) {
    container.innerHTML = `<p class="muted center" style="padding:32px 0;">🎉 You have no active punishments or extra tasks!</p>`;
    return;
  }

  container.innerHTML = cachedStudentPunishments.map((t) => {
    let detailStr = "";
    if (t.skill === "listening" || t.skill === "reading") detailStr = `${t.details.testCount || 1} test set(s)`;
    else if (t.skill === "speaking") detailStr = t.details.notes || "Speaking practice";
    else detailStr = t.details.instructions || t.details.promptText || "";

    const statusBadge = t.status === "verified" ? `<span class="badge badge-green">Completed & Verified</span>`
      : t.status === "submitted" ? `<span class="badge badge-blue">Submitted (Pending Review)</span>`
      : `<span class="badge badge-red">Pending Due ${formatDueDate(t.dueDate)}</span>`;

    const actionBtn = (t.status === "verified" || t.status === "submitted")
      ? `<span class="muted" style="font-size:13px;">${t.status === "verified" ? "Completed" : "Submitted"}</span>`
      : `<button class="btn btn-primary btn-sm" onclick="window.startPunishmentRunner('${t.id}')">Complete</button>`;

    return `
      <div class="hw-item">
        <div style="flex:1;">
          <span class="role-pill">${t.skill.toUpperCase()}</span>
          <strong>${escapeHtml(t.reason)}</strong>
          <div style="font-size:13px;color:var(--text);margin-top:4px;">Instructions: ${escapeHtml(detailStr)}</div>
          <div class="hw-meta" style="margin-top:6px;"><span>Deadline: ${formatDueDate(t.dueDate)}</span>${statusBadge}</div>
        </div>
        <div>${actionBtn}</div>
      </div>
    `;
  }).join("");
}

document.getElementById("back-to-punishments-btn")?.addEventListener("click", () => {
  document.getElementById("punishment-runner-view").classList.add("hidden");
  document.getElementById("student-punishments-container").parentElement.classList.remove("hidden");
  document.getElementById("student-punishments-container").classList.remove("hidden");
  initStudentData();
});

// ==========================================
// RESOURCES & CHARTS HELPERS
// ==========================================
function renderResourcesList(cat) {
  const container = document.getElementById("resources-grid-container");
  if (!container) return;
  const filtered = cat === "all" ? RESOURCES : RESOURCES.filter((r) => r.category === cat);
  
  if (filtered.length === 0) {
    container.innerHTML = `<p class="muted center">No resources added in this category yet.</p>`;
    return;
  }

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
            <span class="badge badge-blue" style="margin-bottom:6px;">${res.category.toUpperCase()}</span>
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

function renderStatisticsPage() {
  const subsArr = Object.values(studentSubmissionsMap);

  studentChartInstance = buildScoreChart("student-score-chart", subsArr, studentMocksList, studentChartInstance);
  groupCompareChartInstance = buildGroupCompareChart("group-compare-chart", studentMocksList, allGroupMocks, groupCompareChartInstance);

  renderMistakeBars("dash-permanent-mistakes", currentStudentProfile.permanentMistakes || {}, "No question-type mistakes logged yet.", "var(--danger)");

  const groupMistakeTotals = {};
  allGroupUsers.forEach((u) => {
    Object.entries(u.permanentMistakes || {}).forEach(([type, val]) => {
      const count = val.wrong || 0;
      if (count > 0) groupMistakeTotals[type] = (groupMistakeTotals[type] || 0) + count;
    });
  });

  renderMistakeBars("group-common-mistakes", groupMistakeTotals, "No group mistake data logged yet.", "var(--warning)");

  const yesterday = getTodayStr(-1);
  const rankedStudents = allGroupUsers.map((u) => {
    const st = u.ankiStats || {};
    const liveStreak = (st.lastReviewedDate && st.lastReviewedDate >= yesterday) ? (st.streak || 0) : 0;
    return { studentId: u.studentId, fullName: u.fullName, streak: liveStreak, totalReviewed: st.totalReviewed || 0 };
  }).sort((a, b) => (b.streak - a.streak) || (b.totalReviewed - a.totalReviewed));

  document.getElementById("effort-leaderboard-tbody").innerHTML = rankedStudents.map((s, idx) => {
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
      const hw = ASSIGNMENTS.find((a) => a.id === sub.assignmentId) || cachedTeacherHw.find(a => a.id === sub.assignmentId);
      const title = hw ? (hw.title || hw.reason) : sub.assignmentId;
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

function buildScoreChart(canvasId, submissions, mocks, existingChart) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === "undefined") return existingChart;
  if (existingChart) existingChart.destroy();

  const events = [];
  mocks.forEach((m) => {
    events.push({ sortKey: m.date || "2026-01-01", label: m.mockTitle || "Mock Exam", listening: m.listening, reading: m.reading, writing: m.writing, speaking: m.speaking, overall: m.overall });
  });

  submissions.forEach((sub) => {
    const hw = ASSIGNMENTS.find((a) => a.id === sub.assignmentId) || cachedTeacherHw.find(a => a.id === sub.assignmentId);
    if (!sub.bandScore || sub.isDrill || (hw && hw.isDrill)) return;
    if ((sub.skill === "reading" || sub.skill === "listening") && Number(sub.totalQuestions) !== 40) return;

    const dateStr = sub.submittedAt?.toDate ? sub.submittedAt.toDate().toISOString().split("T")[0] : (hw ? hw.dueDate.split("T")[0] : "2026-11-15");
    events.push({
      sortKey: dateStr, label: `${sub.assignmentId} (${sub.skill.toUpperCase()})`,
      listening: sub.skill === "listening" ? sub.bandScore : null, reading: sub.skill === "reading" ? sub.bandScore : null,
      writing: sub.skill === "writing" ? sub.bandScore : null, speaking: sub.skill === "speaking" ? sub.bandScore : null, overall: null
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
      responsive: true, maintainAspectRatio: false,
      scales: { y: { min: 4.0, max: 9.0, ticks: { stepSize: 0.5 } } },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } } }
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
      responsive: true, maintainAspectRatio: false,
      scales: { y: { min: 4.0, max: 9.0, ticks: { stepSize: 0.5 } } },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } } }
    }
  });
}

function renderMistakeBars(containerId, mistakesObj, emptyText, barColor = "var(--danger)") {
  const container = document.getElementById(containerId);
  if (!container) return;

  const entries = Object.entries(mistakesObj || {}).map(([type, val]) => ({ type, wrong: typeof val === "number" ? val : (val.wrong || 0) })).filter((item) => item.wrong > 0).sort((a, b) => b.wrong - a.wrong);
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
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%;background:${barColor};"></div></div>
      </div>
    `;
  }).join("");
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
