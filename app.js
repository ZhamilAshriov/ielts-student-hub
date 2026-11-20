import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  updatePassword
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where,
  serverTimestamp,
  arrayUnion,
  arrayRemove
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
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
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
let recordedAudioList = []; // Array of { blob, url, duration }
let recReplaceLast = false;
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

const ANNOUNCEMENT_EMOJIS = ["👍", "❤️", "🔥", "🎉", "👏", "😢", "😡"];

function buildAnnouncementReactionsHtml(ann, actorId, isTeacher = false) {
  const reactions = ann.reactions || {};
  const pills = ANNOUNCEMENT_EMOJIS.map((emoji) => {
    const users = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
    const count = users.length;
    const reacted = users.includes(actorId);
    const activeStyle = reacted
      ? "background:#eff6ff;border-color:#93c5fd;color:var(--primary);font-weight:700;"
      : "background:#f8fafc;border-color:var(--border);color:var(--text);";
    const titleAttr = isTeacher && count > 0 ? `title="Reacted by: ${escapeHtml(users.join(", "))}"` : "";

    return `
      <button type="button" ${titleAttr}
        onclick="window.toggleAnnouncementReaction('${ann.docId}', '${emoji}')"
        style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border:1px solid;border-radius:999px;font-size:13px;cursor:pointer;transition:all 0.15s;${activeStyle}">
        <span>${emoji}</span>
        ${count > 0 ? `<span style="font-size:12px;">${count}</span>` : ""}
      </button>
    `;
  }).join("");

  return `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:8px;border-top:1px dashed var(--border);">${pills}</div>`;
}

window.toggleAnnouncementReaction = async function (docId, emoji) {
  const actorId = currentStudentId || "TEACHER";
  const ann = cachedAnnouncements.find((a) => a.docId === docId);
  if (!ann) return;

  if (!ann.reactions) ann.reactions = {};
  const currentUsers = Array.isArray(ann.reactions[emoji]) ? [...ann.reactions[emoji]] : [];
  const hasReacted = currentUsers.includes(actorId);

  // Optimistic instant UI update in memory
  ann.reactions[emoji] = hasReacted
    ? currentUsers.filter((id) => id !== actorId)
    : [...currentUsers, actorId];

  if (currentStudentId) renderStudentAnnouncements(cachedAnnouncements);
  else renderTeacherAnnouncementsList(cachedAnnouncements);

  try {
    await updateDoc(doc(db, "announcements", docId), {
      [`reactions.${emoji}`]: hasReacted ? arrayRemove(actorId) : arrayUnion(actorId)
    });
  } catch (err) {
    console.error("Reaction update error:", err);
  }
};

const MISTAKE_LABELS = {
  MCQ: "Reading: Multiple Choice", TFNG: "True / False / Not Given", YNNG: "Yes / No / Not Given",
  MATCHING_HEADINGS: "Matching Headings", MATCHING_INFO: "Matching Information", MATCHING_FEATURES: "Matching Features",
  MATCHING_SENTENCE_ENDINGS: "Matching Sentence Endings", SENTENCE_COMPLETION: "Reading: Sentence Completion",
  SUMMARY_COMPLETION: "Summary Completion", NOTE_COMPLETION: "Note Completion", TABLE_COMPLETION: "Table Completion",
  FLOW_CHART_COMPLETION: "Flow-chart Completion", DIAGRAM_LABELLING: "Diagram Labelling", SHORT_ANSWER: "Reading: Short-Answer Questions",
  L_MCQ: "Listening: Multiple Choice", MATCHING: "Listening: Matching", MAP_DIAGRAM: "Listening: Plan, Map, or Diagram", 
  FORM_NOTE_TABLE_SUMMARY: "Listening: Form / Note / Table / Summary", L_SENTENCE_COMPLETION: "Listening: Sentence Completion", L_SHORT_ANSWER: "Listening: Short-Answer Questions",
  W_ARTICLES: "Writing: Articles & Determiners", W_TENSE: "Writing: Verb Tense Consistency", W_SVA: "Writing: Subject-Verb Agreement",
  W_PREPOSITIONS: "Writing: Prepositions", W_WORD_CHOICE: "Writing: Word Choice & Collocation", W_SENTENCE_STRUCTURE: "Writing: Run-ons & Fragments",
  W_TASK_RESPONSE: "Writing: Task Response / Coherence",
  S_FLUENCY_HESITATION: "Speaking: Hesitation & Fillers", S_GRAMMAR_TENSE: "Speaking: Grammar & Tense Control",
  S_LEXICAL_RANGE: "Speaking: Limited Vocabulary Range", S_PRONUNCIATION: "Speaking: Pronunciation & Stress"
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

const changePassForm = document.getElementById("change-password-form");
if (changePassForm) {
  changePassForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const newPass = document.getElementById("new-pass-input").value;
    const btn = document.getElementById("change-pass-btn");
    const msg = document.getElementById("change-pass-msg");

    btn.disabled = true;
    btn.textContent = "Updating...";
    msg.textContent = "";

    try {
      const user = auth.currentUser;
      if (!user) throw new Error("No user logged in.");
      await updatePassword(user, newPass);
      msg.style.color = "var(--success)";
      msg.textContent = "Password updated successfully!";
      changePassForm.reset();
    } catch (err) {
      msg.style.color = "var(--danger)";
      if (err.code === "auth/requires-recent-login") {
        msg.textContent = "Security check: Please log out and log back in, then try changing your password again.";
      } else {
        msg.textContent = err.message;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "Update Password";
    }
  });
}

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
    
    // FIX: Process the QR Code instantly before downloading heavy dashboard data!
    await handleUrlCheckInToken(); 
    await initStudentData();
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
      const attachInput = document.getElementById("hw-attach-images");
      let imageUrls = [];
      if (attachInput && attachInput.files.length > 0) {
        btn.textContent = "Uploading images...";
        const uploaded = await uploadMultipleFiles("hw-attach-images");
        if (!uploaded) {
          btn.disabled = false;
          btn.textContent = "Publish Homework 🚀";
          return;
        }
        imageUrls = uploaded;
        btn.textContent = "Publishing...";
      }

      let activeWeek = "Current Assignments";
      if (typeof ASSIGNMENTS !== 'undefined' && ASSIGNMENTS.length > 0) {
        const upcoming = ASSIGNMENTS.find(a => new Date(a.dueDate) >= new Date());
        activeWeek = upcoming ? upcoming.week : ASSIGNMENTS[ASSIGNMENTS.length - 1].week;
      }

      const targets = target === "ALL" ? cachedStudents.map((s) => s.studentId) : [target];
      for (const studentId of targets) {
        const taskId = `CUSTOMHW_${studentId}_${Date.now()}`;
        await setDoc(doc(db, "customAssignments", taskId), {
          id: taskId, studentId, skill, title, details, imageUrls, dueDate, week: activeWeek, status: "pending", createdAt: serverTimestamp()
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

let showArchivedCustomHw = false;

function renderTeacherCustomHw(tasks, students) {
  const tbody = document.getElementById("group-hw-tbody");
  if (!tbody) return;

  const cutoffMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const activeTasks = showArchivedCustomHw
    ? tasks
    : tasks.filter((t) => !t.dueDate || new Date(t.dueDate).getTime() >= cutoffMs);
  const hiddenCount = tasks.length - activeTasks.length;

  if (activeTasks.length === 0) {
    const toggleRow = hiddenCount > 0
      ? `<tr><td colspan="4" class="muted center">No recent homework (${hiddenCount} older tasks hidden). <button type="button" class="btn btn-outline btn-sm" style="margin-left:8px;" onclick="window.toggleArchivedCustomHw()">Show Archived</button></td></tr>`
      : `<tr><td colspan="4" class="muted center">No active custom homework.</td></tr>`;
    tbody.innerHTML = toggleRow;
    return;
  }

  const nameMap = {};
  students.forEach((s) => { nameMap[s.studentId] = s.fullName; });

  const groupedMap = new Map();
  activeTasks.forEach((t) => {
    const key = `${t.skill}|${t.title}|${t.dueDate}`;
    if (!groupedMap.has(key)) {
      groupedMap.set(key, {
        representativeId: t.id,
        skill: t.skill,
        title: t.title,
        dueDate: t.dueDate,
        items: []
      });
    }
    groupedMap.get(key).items.push(t);
  });

  const rowsHtml = Array.from(groupedMap.values()).map((group) => {
    const isBatch = group.items.length > 1;
    const first = group.items[0];

    let targetHtml = "";
    let statusHtml = "";

    if (isBatch) {
      const doneCount = group.items.filter((i) => i.status === "submitted" || i.status === "verified").length;
      const pendingStudents = group.items
        .filter((i) => i.status !== "submitted" && i.status !== "verified")
        .map((i) => i.studentId);

      targetHtml = `<strong>📢 Group (${group.items.length} students)</strong>` +
        (pendingStudents.length > 0
          ? `<br><span class="muted" style="font-size:11px;">Pending: ${pendingStudents.slice(0, 4).join(", ")}${pendingStudents.length > 4 ? ` +${pendingStudents.length - 4} more` : ""}</span>`
          : `<br><span style="color:var(--success);font-size:11px;font-weight:600;">All submitted!</span>`);

      const badgeClass = doneCount === group.items.length ? "badge-green" : doneCount > 0 ? "badge-blue" : "badge-red";
      statusHtml = `<span class="badge ${badgeClass}">${doneCount} / ${group.items.length} Done</span>`;
    } else {
      const sName = nameMap[first.studentId] || first.studentId;
      targetHtml = `<strong>${first.studentId}</strong><br><span class="muted" style="font-size:12px;">${escapeHtml(sName)}</span>`;
      statusHtml = first.status === "verified"
        ? `<span class="badge badge-green">Verified</span>`
        : first.status === "submitted"
          ? `<span class="badge badge-blue">Submitted</span>`
          : `<span class="badge badge-red">Pending</span>`;
    }

    const deleteLabel = isBatch ? "Delete All" : "Delete";
    const actionBtn = `<button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:#fecaca;" onclick="window.deleteDynamicTask('${group.representativeId}', 'customAssignments')">${deleteLabel}</button>`;

    return `
      <tr>
        <td>${targetHtml}</td>
        <td><span class="role-pill">${group.skill.toUpperCase()}</span><br>${escapeHtml(group.title)}</td>
        <td>${statusHtml}<br><span class="muted" style="font-size:11px;">Due: ${formatDueDate(group.dueDate)}</span></td>
        <td>${actionBtn}</td>
      </tr>
    `;
  }).join("");

  const footerHtml = (hiddenCount > 0 || showArchivedCustomHw)
    ? `<tr><td colspan="4" class="center" style="padding:10px;"><button type="button" class="btn btn-outline btn-sm" onclick="window.toggleArchivedCustomHw()">${showArchivedCustomHw ? "Hide Archived (14d+)" : `Show Archived (${hiddenCount} older)`}</button></td></tr>`
    : "";

  tbody.innerHTML = rowsHtml + footerHtml;
}

window.toggleArchivedCustomHw = function () {
  showArchivedCustomHw = !showArchivedCustomHw;
  renderTeacherCustomHw(cachedTeacherHw, cachedStudents);
};
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
  const list = collectionName === "customAssignments" ? cachedTeacherHw : cachedTeacherPunishments;
  const target = list.find(item => item.id === id);
  const label = target ? (target.title || target.reason) : "";
  const matching = target ? list.filter(item => (item.title || item.reason) === label && item.dueDate === target.dueDate) : [];

  if (matching.length > 1 && confirm(`Found ${matching.length} copies of "${label}" for this deadline.\n\nClick OK to delete ALL ${matching.length} copies at once, or Cancel to delete only this student's copy.`)) {
    await Promise.all(matching.map(item => deleteDoc(doc(db, collectionName, item.id))));
    const idsToRemove = new Set(matching.map(m => m.id));
    if (collectionName === "customAssignments") {
      cachedTeacherHw = cachedTeacherHw.filter(t => !idsToRemove.has(t.id));
      renderTeacherCustomHw(cachedTeacherHw, cachedStudents);
      renderTeacherHwMatrix(cachedStudents, cachedSubmissions);
    } else {
      cachedTeacherPunishments = cachedTeacherPunishments.filter(t => !idsToRemove.has(t.id));
      renderTeacherPunishments(cachedTeacherPunishments, cachedStudents);
    }
    return;
  }

  if (!confirm("Delete this assigned record?")) return;
  await deleteDoc(doc(db, collectionName, id));
  if (collectionName === "customAssignments") {
    cachedTeacherHw = cachedTeacherHw.filter(t => t.id !== id);
    renderTeacherCustomHw(cachedTeacherHw, cachedStudents);
    renderTeacherHwMatrix(cachedStudents, cachedSubmissions);
  } else {
    cachedTeacherPunishments = cachedTeacherPunishments.filter(t => t.id !== id);
    renderTeacherPunishments(cachedTeacherPunishments, cachedStudents);
  }
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
      ${buildAnnouncementReactionsHtml(ann, "TEACHER", true)}
    </div>
  `).join("");
}

window.deleteAnnouncement = async function (docId) {
  if (!confirm("Delete this announcement?")) return;
  await deleteDoc(doc(db, "announcements", docId));
  cachedAnnouncements = cachedAnnouncements.filter((a) => a.docId !== docId);
  renderTeacherAnnouncementsList(cachedAnnouncements);
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

let showArchivedMatrixHw = false;

function renderTeacherHwMatrix(students, submissions) {
  const container = document.getElementById("hw-matrix-container");
  if (students.length === 0) {
    container.innerHTML = `<p class="muted center">No students in roster yet.</p>`;
    return;
  }

  const now = new Date();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const cutoffMs = now.getTime() - 14 * oneDayMs;
  const delinquentRecords = [];
  let hiddenIssuesCount = 0;

  students.forEach((s) => {
    const studentCustomTasks = cachedTeacherHw
      .filter((t) => t.studentId === s.studentId || t.studentId === "ALL")
      .map((t) => ({ id: t.id, title: t.title || t.reason, skill: t.skill, dueDate: t.dueDate }));

    const studentAssignments = [...ASSIGNMENTS, ...studentCustomTasks];
    const issues = [];

    studentAssignments.forEach((a) => {
      const sub = submissions.find((item) => item.studentId === s.studentId && item.assignmentId === a.id);
      const dueTime = new Date(a.dueDate).getTime();
      const isPastDue = now.getTime() > dueTime;
      const isOverOneDayLate = now.getTime() > (dueTime + oneDayMs);
      const isArchived = dueTime < cutoffMs;

      if ((!sub && isPastDue) || (sub && sub.isLate)) {
        if (!showArchivedMatrixHw && isArchived) {
          hiddenIssuesCount++;
          return;
        }
        if (!sub && isPastDue) {
          const punishBtn = isOverOneDayLate
            ? `<button type="button" class="btn btn-outline btn-sm" style="color:var(--danger);border-color:#fecaca;margin-left:auto;" onclick="window.quickAssignPunishment('${s.studentId}', '${a.skill}')">⚡ Assign Punishment</button>`
            : "";
          issues.push(`<div style="margin-bottom:8px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;"><span class="badge badge-red">Missing</span> <span><strong>${escapeHtml(a.title)}</strong> <span class="muted" style="font-size:12px;">(Due: ${formatDueDate(a.dueDate)})</span></span>${punishBtn}</div>`);
        } else if (sub && sub.isLate) {
          issues.push(`<div style="margin-bottom:8px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;"><span class="badge badge-yellow">Late</span> <span><strong>${escapeHtml(a.title)}</strong> <span class="muted" style="font-size:12px;">(Submitted: ${sub.submittedAt?.toDate ? formatDueDate(sub.submittedAt.toDate().toISOString()) : "Late"})</span></span></div>`);
        }
      }
    });

    if (issues.length > 0) {
      delinquentRecords.push({ student: s, issues });
    }
  });

  const archiveToggleBtn = (hiddenIssuesCount > 0 || showArchivedMatrixHw)
    ? `<button type="button" class="btn btn-outline btn-sm" onclick="window.toggleArchivedMatrixHw()">${showArchivedMatrixHw ? "Hide Archived (14d+)" : `Show Archived (${hiddenIssuesCount} older)`}</button>`
    : "";

  if (delinquentRecords.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding: 40px 20px; border: 1px dashed var(--border); border-radius: 8px;">
        <div style="font-size:32px; margin-bottom:12px;">🎉</div>
        <h3 style="margin-bottom:8px;">All Caught Up!</h3>
        <p class="muted">Every student has submitted all recent past-due assignments on time.</p>
        ${archiveToggleBtn ? `<div style="margin-top:12px;">${archiveToggleBtn}</div>` : ""}
      </div>
    `;
    return;
  }

  const rows = delinquentRecords.map((record) => `
    <div class="grade-card" style="margin-bottom:16px;">
      <div style="font-weight:600; font-size:15px; margin-bottom:12px; border-bottom:1px solid var(--border); padding-bottom:8px; color:var(--primary);">
        ${escapeHtml(record.student.fullName)} <span class="muted" style="font-size:13px; font-weight:400;">(${record.student.studentId})</span>
      </div>
      <div>${record.issues.join("")}</div>
    </div>
  `).join("");

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:16px;">
      <p class="muted" style="font-size:14px; margin:0;">Showing students who have missing or late assignments from the last 14 days.</p>
      ${archiveToggleBtn}
    </div>
    ${rows}
  `;
}

window.toggleArchivedMatrixHw = function () {
  showArchivedMatrixHw = !showArchivedMatrixHw;
  renderTeacherHwMatrix(cachedStudents, cachedSubmissions);
};

let showArchivedGraded = false;

function renderTeacherGradingQueue(students, submissions) {
  const container = document.getElementById("grading-list-container");
  const ungradedCount = submissions.filter((s) => s.status !== "graded").length;
  document.getElementById("nav-grade-badge").textContent = ungradedCount;

  const oneDayMs = 24 * 60 * 60 * 1000;
  const cutoffMs = Date.now() - oneDayMs;

  const isExpiredGraded = (sub) => {
    if (sub.status !== "graded") return false;
    const gradedMs = sub.gradedAt?.toMillis
      ? sub.gradedAt.toMillis()
      : (typeof sub.gradedAt === "number" ? sub.gradedAt : 0);
    return gradedMs > 0 && gradedMs < cutoffMs;
  };

  const visibleSubmissions = showArchivedGraded
    ? [...submissions]
    : submissions.filter((s) => !isExpiredGraded(s));
  const hiddenCount = submissions.length - visibleSubmissions.length;

  const toggleBarHtml = (hiddenCount > 0 || showArchivedGraded)
    ? `<div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
         <button type="button" class="btn btn-outline btn-sm" onclick="window.toggleArchivedGraded()">
           ${showArchivedGraded ? "Hide Checked (1d+)" : `Show Older Checked (${hiddenCount})`}
         </button>
       </div>`
    : "";

  if (visibleSubmissions.length === 0) {
    container.innerHTML = toggleBarHtml + `<p class="muted center">No active submissions to review.</p>`;
    return;
  }

  visibleSubmissions.sort((a, b) => (a.status === "graded") - (b.status === "graded"));
  const studentNameMap = {};
  students.forEach((s) => { studentNameMap[s.studentId] = s.fullName; });

  container.innerHTML = toggleBarHtml + visibleSubmissions.map((sub) => {
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
      const perSetHtml = (Array.isArray(sub.setScores) && sub.setScores.length > 1)
        ? `<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;">${sub.setScores.map((sc, i) => `<span class="badge badge-blue">Test ${i + 1}: ${sc}/40 (Band ${rawToIeltsBand(sc, 40)})</span>`).join("")}</div>`
        : "";
      contentHtml = `
        <div style="margin:10px 0;">
          <p style="font-size:14px;margin-bottom:8px;"><strong>Reported Score:</strong> ${sub.rawScore} / ${sub.totalQuestions} ${sub.bandScore ? `(Avg Band ${sub.bandScore})` : `(Drill — Weakest Areas Only)`}</p>
          ${perSetHtml}
          ${mistakesSummary ? `<div style="margin-bottom:10px;">${mistakesSummary}</div>` : ""}
          <div style="display:flex;flex-wrap:wrap;">${imgHtml}</div>
        </div>
      `;
    } else if (sub.skill === "writing") {
      const savedWritingAiHtml = sub.aiEvaluation
        ? `<div style="margin-top:10px;background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:12px;font-size:13px;">
             <strong style="color:var(--primary);">🎯 IELTS Writing Evaluation:</strong>
             <div style="margin-top:4px;white-space:pre-line;line-height:1.55;">${escapeHtml(sub.aiEvaluation)}</div>
           </div>`
        : "";

      contentHtml = `
        <div style="display:flex;flex-wrap:wrap;margin:10px 0;">${chartImgHtml}</div>
        <div class="essay-preview">${escapeHtml(sub.essayText || "")}</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;">
          <button type="button" class="btn btn-outline btn-sm" id="ai-wrt-btn-${sub.docId}" onclick="window.evaluateWritingSubmission('${sub.docId}')">
            ${sub.aiEvaluation ? "🔄 Re-run AI Writing Check" : "✨ Evaluate Writing (Gemini)"}
          </button>
          <button type="button" class="btn btn-outline btn-sm" style="font-size:11px;color:var(--muted);" onclick="window.setTeacherGeminiKey()">🔑 Set API Key</button>
        </div>
        ${savedWritingAiHtml}
      `;
    } else if (sub.skill === "speaking") {
      const allAudios = Array.isArray(sub.audioUrls) && sub.audioUrls.length > 0
        ? sub.audioUrls
        : (sub.audioUrl ? [sub.audioUrl] : []);
      const audioPlayersHtml = allAudios.map((url, idx) => `
        <div style="margin-bottom:8px;">
          ${allAudios.length > 1 ? `<div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px;">Recording ${idx + 1} of ${allAudios.length}</div>` : ""}
          <audio controls src="${url}" style="width:100%;"></audio>
        </div>
      `).join("");

      const savedAiHtml = (sub.transcript || sub.aiEvaluation)
        ? `<div style="margin-top:10px;background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:12px;font-size:13px;">
             ${sub.transcript ? `<div style="margin-bottom:10px;"><strong style="color:var(--primary);">📝 Verbatim Transcript:</strong><p style="margin:4px 0 0;white-space:pre-line;line-height:1.5;">${escapeHtml(sub.transcript)}</p></div>` : ""}
             ${sub.aiEvaluation ? `<div><strong style="color:var(--primary);">🎯 IELTS Speaking Evaluation:</strong><div style="margin-top:4px;white-space:pre-line;line-height:1.55;">${escapeHtml(sub.aiEvaluation)}</div></div>` : ""}
           </div>`
        : "";

      contentHtml = `
        <div style="margin:12px 0;">
          ${audioPlayersHtml}
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <button type="button" class="btn btn-outline btn-sm" id="ai-spk-btn-${sub.docId}" onclick="window.transcribeAndEvaluateSpeaking('${sub.docId}')">
              ${sub.aiEvaluation ? "🔄 Re-run AI Transcribe & Evaluate" : "✨ Transcribe & Evaluate (Gemini)"}
            </button>
            <button type="button" class="btn btn-outline btn-sm" style="font-size:11px;color:var(--muted);" onclick="window.setTeacherGeminiKey()">🔑 Set API Key</button>
          </div>
          ${savedAiHtml}
        </div>
      `;
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

    const computedBand = sub.bandScore != null
      ? Number(sub.bandScore).toFixed(1)
      : ((sub.skill === "reading" || sub.skill === "listening") && sub.rawScore != null && sub.totalQuestions)
        ? rawToIeltsBand(sub.rawScore, sub.totalQuestions).toFixed(1)
        : "6.0";

    const bandSelectorHtml = noBandRequired
      ? `<div><label>Status</label><input type="text" value="Completion Check" disabled style="background:#f1f5f9;color:var(--muted);" /><input type="hidden" id="band-${sub.docId}" value="" /></div>`
      : `<div><label>Confirm / Set Band</label><select id="band-${sub.docId}">${["4.0","4.5","5.0","5.5","6.0","6.5","7.0","7.5","8.0","8.5","9.0"].map((b) => `<option value="${b}" ${computedBand === b ? "selected" : ""}>Band ${b}</option>`).join("")}</select></div>`;

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
          <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="window.saveTeacherGrade('${sub.docId}', '${sub.assignmentId}', ${noBandRequired})">Save & Verify</button>
            <button type="button" class="btn btn-outline" style="color:var(--danger);border-color:#fecaca;" onclick="window.quickAssignPunishment('${sub.studentId}', '${sub.skill}')">⚡ Assign Punishment</button>
            <button type="button" class="btn btn-outline" style="color:var(--danger);border-color:#fecaca;" onclick="window.deleteSubmission('${sub.docId}', '${sub.assignmentId}')">🗑️ Delete</button>
          </div>
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

  const subIdx = cachedSubmissions.findIndex((s) => s.docId === docId);
  if (subIdx !== -1) {
    cachedSubmissions[subIdx] = { ...cachedSubmissions[subIdx], ...updatePayload, gradedAt: Date.now() };
  }
  if (assignmentId && assignmentId.startsWith("PUN_")) {
    const punIdx = cachedTeacherPunishments.findIndex((p) => p.id === assignmentId);
    if (punIdx !== -1) cachedTeacherPunishments[punIdx].status = "verified";
    renderTeacherPunishments(cachedTeacherPunishments, cachedStudents);
  }

  alert("Verified & feedback saved!");
  renderTeacherGradingQueue(cachedStudents, cachedSubmissions);
};

window.toggleArchivedGraded = function () {
  showArchivedGraded = !showArchivedGraded;
  renderTeacherGradingQueue(cachedStudents, cachedSubmissions);
};

window.deleteSubmission = async function (docId, assignmentId) {
  if (!confirm("Delete this student submission permanently?")) return;

  await deleteDoc(doc(db, "submissions", docId));

  // If it was a custom assignment or punishment, reset its status back to pending
  if (assignmentId && assignmentId.startsWith("CUSTOMHW_")) {
    await updateDoc(doc(db, "customAssignments", assignmentId), { status: "pending" }).catch(() => {});
    const hwIdx = cachedTeacherHw.findIndex((h) => h.id === assignmentId);
    if (hwIdx !== -1) cachedTeacherHw[hwIdx].status = "pending";
    renderTeacherCustomHw(cachedTeacherHw, cachedStudents);
  } else if (assignmentId && assignmentId.startsWith("PUN_")) {
    await updateDoc(doc(db, "punishments", assignmentId), { status: "pending" }).catch(() => {});
    const punIdx = cachedTeacherPunishments.findIndex((p) => p.id === assignmentId);
    if (punIdx !== -1) cachedTeacherPunishments[punIdx].status = "pending";
    renderTeacherPunishments(cachedTeacherPunishments, cachedStudents);
  }

  cachedSubmissions = cachedSubmissions.filter((s) => s.docId !== docId);
  renderTeacherGradingQueue(cachedStudents, cachedSubmissions);
  renderTeacherHwMatrix(cachedStudents, cachedSubmissions);
};

window.setTeacherGeminiKey = function () {
  const existing = localStorage.getItem("ielts_hub_gemini_key") || "";
  const input = prompt(
    "Paste your Google AI Studio Gemini API key (saved only in this browser's localStorage):",
    existing
  );
  if (input === null) return null;
  const trimmed = input.trim();
  if (trimmed) {
    localStorage.setItem("ielts_hub_gemini_key", trimmed);
    alert("Gemini API key saved to this browser!");
    return trimmed;
  } else {
    localStorage.removeItem("ielts_hub_gemini_key");
    alert("Gemini API key cleared.");
    return null;
  }
};

window.transcribeAndEvaluateSpeaking = async function (docId) {
  const sub = cachedSubmissions.find((s) => s.docId === docId);
  const allAudios = Array.isArray(sub?.audioUrls) && sub.audioUrls.length > 0
    ? sub.audioUrls
    : (sub?.audioUrl ? [sub.audioUrl] : []);
  if (!sub || allAudios.length === 0) return alert("No audio recording found for this submission.");

  let apiKey = localStorage.getItem("ielts_hub_gemini_key");
  if (!apiKey) {
    apiKey = window.setTeacherGeminiKey();
    if (!apiKey) return;
  }

  const btn = document.getElementById(`ai-spk-btn-${docId}`);
  const origText = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Fetching audio...";
  }

  try {
    // 1. Download all student audio recordings from Cloudinary and convert to Base64
    const audioParts = [];
    for (let i = 0; i < allAudios.length; i++) {
      const audioRes = await fetch(allAudios[i]);
      if (!audioRes.ok) throw new Error(`Could not download Recording ${i + 1} from Cloudinary.`);
      const audioBlob = await audioRes.blob();
      const mimeType = audioBlob.type || "audio/webm";
      const base64Audio = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(audioBlob);
      });
      if (allAudios.length > 1) audioParts.push({ text: `[Recording ${i + 1} of ${allAudios.length}]` });
      audioParts.push({ inline_data: { mime_type: mimeType, data: base64Audio } });
    }

    if (btn) btn.textContent = "✨ Gemini analyzing...";

    // 2. Look up the speaking prompt/questions if available for context
    const taskObj = cachedTeacherHw.find((h) => h.id === sub.assignmentId)
      || cachedTeacherPunishments.find((p) => p.id === sub.assignmentId)
      || ASSIGNMENTS.find((a) => a.id === sub.assignmentId);
    const promptContext = taskObj?.details?.questions || taskObj?.instructions || taskObj?.title || "IELTS Speaking task";

    const systemPrompt = `You are a strict, certified IELTS Speaking examiner.
Listen carefully to the student's audio response for this prompt: "${promptContext}".

Return your response in valid JSON with two string fields:
1. "transcript": A verbatim transcription of everything the student said, preserving filler words (um, uh, like), pauses (...), and self-corrections so the teacher can inspect fluency.
2. "evaluation": A concise, structured IELTS Speaking assessment formatted cleanly with line breaks covering:
   - Estimated Overall Band: (e.g., Band 6.0)
   - Fluency & Coherence (Band X.X): 1-2 sentences on pace, hesitation, and linking.
   - Lexical Resource (Band X.X): 1-2 sentences on vocabulary range and collocations.
   - Grammatical Range & Accuracy (Band X.X): 1-2 sentences on sentence structures and specific errors heard.
   - Pronunciation (Band X.X): 1-2 sentences on clarity, word stress, and intonation.
   - Key Corrections & Upgrades: 2-3 bullet points quoting exact mistakes from the audio and giving Band 8+ alternatives.`;

    // 3. Call Gemini 3.8 Flash with inline audio
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: systemPrompt },
                ...audioParts
              ]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.2
          }
        })
      }
    );

    const geminiData = await geminiRes.json();
    if (!geminiRes.ok) {
      throw new Error(geminiData.error?.message || `Gemini API error (${geminiRes.status})`);
    }

    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const parsed = JSON.parse(rawText);
    const transcript = parsed.transcript || "(No speech detected)";
    const aiEvaluation = parsed.evaluation || "";

    // 4. Save to Firestore so you never have to re-run it
    await updateDoc(doc(db, "submissions", docId), {
      transcript,
      aiEvaluation
    });

    // 5. Update local cache and re-render the queue
    const subIdx = cachedSubmissions.findIndex((s) => s.docId === docId);
    if (subIdx !== -1) {
      cachedSubmissions[subIdx].transcript = transcript;
      cachedSubmissions[subIdx].aiEvaluation = aiEvaluation;
    }

    renderTeacherGradingQueue(cachedStudents, cachedSubmissions);
  } catch (err) {
    alert("Transcription/Evaluation failed: " + err.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }
};

window.quickAssignPunishment = function (studentId, skill) {
  const punTab = document.querySelector('#teacher-nav [data-target="teacher-punishments"]');
  if (punTab) punTab.click();

  const targetSel = document.getElementById("pun-target-select");
  if (targetSel) targetSel.value = studentId;

  const skillSel = document.getElementById("pun-skill-select");
  if (skillSel && [...skillSel.options].some((o) => o.value === skill)) {
    skillSel.value = skill;
    renderSkillConfigForm("pun-skill-select", "pun-config-container");
  }
};

document.getElementById("refresh-roster-btn")?.addEventListener("click", loadTeacherData);
document.getElementById("refresh-matrix-btn")?.addEventListener("click", loadTeacherData);
document.getElementById("refresh-grading-btn")?.addEventListener("click", loadTeacherData);

async function logAiMistakesToStudent(studentId, mistakeTagCounts) {
  if (!studentId || !mistakeTagCounts || typeof mistakeTagCounts !== "object") return;
  const validEntries = Object.entries(mistakeTagCounts).filter(([k, v]) => MISTAKE_LABELS[k] && Number(v) > 0);
  if (validEntries.length === 0) return;

  const studentRef = doc(db, "users", studentId);
  const snap = await getDoc(studentRef);
  if (!snap.exists()) return;

  const currentMistakes = { ...(snap.data().permanentMistakes || {}) };
  validEntries.forEach(([key, count]) => {
    currentMistakes[key] = { wrong: (currentMistakes[key]?.wrong || 0) + Number(count) };
  });

  await updateDoc(studentRef, { permanentMistakes: currentMistakes });
  const idx = cachedStudents.findIndex((s) => s.studentId === studentId);
  if (idx !== -1) cachedStudents[idx].permanentMistakes = currentMistakes;
}

window.evaluateWritingSubmission = async function (docId) {
  const sub = cachedSubmissions.find((s) => s.docId === docId);
  if (!sub || !sub.essayText) return alert("No essay text found for this submission.");

  let apiKey = localStorage.getItem("ielts_hub_gemini_key");
  if (!apiKey) {
    apiKey = window.setTeacherGeminiKey();
    if (!apiKey) return;
  }

  const btn = document.getElementById(`ai-wrt-btn-${docId}`);
  const origText = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "✨ Gemini grading essay...";
  }

  try {
    const taskObj = cachedTeacherHw.find((h) => h.id === sub.assignmentId)
      || cachedTeacherPunishments.find((p) => p.id === sub.assignmentId)
      || ASSIGNMENTS.find((a) => a.id === sub.assignmentId);
    const promptText = taskObj?.details?.promptText || taskObj?.promptText || taskObj?.title || "IELTS Writing Task";

    const systemPrompt = `You are a strict, certified IELTS Writing examiner.
Grade the student's response to this prompt: "${promptText}".
Word count: ${sub.essayText.trim().split(/\s+/).filter(Boolean).length} words.

Return valid JSON with three fields:
1. "estimatedBand": A string band score like "6.0", "6.5", or "7.0".
2. "evaluation": A structured IELTS Writing assessment formatted cleanly with line breaks covering:
   - Estimated Overall Band: (e.g., Band 6.0)
   - Task Achievement / Response (Band X.X): 1-2 sentences.
   - Coherence & Cohesion (Band X.X): 1-2 sentences.
   - Lexical Resource (Band X.X): 1-2 sentences.
   - Grammatical Range & Accuracy (Band X.X): 1-2 sentences.
   - Key Sentence Corrections & Band 8+ Upgrades: 3 bullet points quoting exact student errors and providing corrected Band 8+ versions.
3. "mistakeCounts": An object counting specific recurring error categories found in the essay using ONLY these keys: W_ARTICLES, W_TENSE, W_SVA, W_PREPOSITIONS, W_WORD_CHOICE, W_SENTENCE_STRUCTURE, W_TASK_RESPONSE (use 0 if none).`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\nSTUDENT ESSAY:\n${sub.essayText}` }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
        })
      }
    );

    const geminiData = await geminiRes.json();
    if (!geminiRes.ok) throw new Error(geminiData.error?.message || `Gemini API error (${geminiRes.status})`);

    const parsed = JSON.parse(geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
    const aiEvaluation = parsed.evaluation || "";
    const estimatedBand = parsed.estimatedBand || "";

    await updateDoc(doc(db, "submissions", docId), {
      aiEvaluation,
      aiMistakesLogged: true
    });

    if (!sub.aiMistakesLogged && parsed.mistakeCounts) {
      await logAiMistakesToStudent(sub.studentId, parsed.mistakeCounts);
    }

    const subIdx = cachedSubmissions.findIndex((s) => s.docId === docId);
    if (subIdx !== -1) {
      cachedSubmissions[subIdx].aiEvaluation = aiEvaluation;
      cachedSubmissions[subIdx].aiMistakesLogged = true;
    }

    renderTeacherGradingQueue(cachedStudents, cachedSubmissions);

    const bandSelect = document.getElementById(`band-${docId}`);
    if (bandSelect && estimatedBand && [...bandSelect.options].some((o) => o.value === estimatedBand)) {
      bandSelect.value = estimatedBand;
    }
  } catch (err) {
    alert("Writing evaluation failed: " + err.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }
};

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
    getDocs(query(collection(db, "customAssignments"), where("studentId", "in", [currentStudentId, "ALL"]))),
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
  hwSnap.forEach((d) => cachedTeacherHw.push(d.data()));

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
  checkAndShowNewAnnouncementModal(cachedAnnouncements);
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
      ${buildAnnouncementReactionsHtml(ann, currentStudentId, false)}
    </div>
  `).join("");
}

function checkAndShowNewAnnouncementModal(list) {
  if (!currentStudentId || !Array.isArray(list) || list.length === 0) return;

  const storageKey = `ielts_hub_seen_anns_${currentStudentId}`;
  let seenIds = [];
  try {
    seenIds = JSON.parse(localStorage.getItem(storageKey) || "[]");
  } catch {
    seenIds = [];
  }

  const seenSet = new Set(seenIds);
  const unseenAnns = list.filter((ann) => !seenSet.has(ann.docId));
  if (unseenAnns.length === 0) return;

  // Remove any existing modal before creating a new one
  document.getElementById("new-ann-popup-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "new-ann-popup-overlay";
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(15, 23, 42, 0.55);
    display: flex; align-items: center; justify-content: center;
    padding: 16px; z-index: 9999; backdrop-filter: blur(2px);
  `;

  const cardsHtml = unseenAnns.map((ann) => `
    <div style="background:#f8fafc;border:1px solid var(--border);${ann.pinned ? "border-left:4px solid var(--primary);" : ""}border-radius:10px;padding:14px 16px;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
        ${ann.pinned ? `<span class="badge badge-yellow">📌 Pinned</span>` : ""}
        <span class="badge ${getAnnouncementBadgeClass(ann.tag)}">${escapeHtml(ann.tag || "GENERAL")}</span>
        <span class="muted" style="font-size:12px;margin-left:auto;">${formatAnnouncementDate(ann)}</span>
      </div>
      <div style="font-weight:700;font-size:15px;color:var(--text);margin-bottom:6px;">${escapeHtml(ann.title)}</div>
      <div style="font-size:14px;white-space:pre-line;color:var(--text);line-height:1.55;">${escapeHtml(ann.body)}</div>
    </div>
  `).join("");

  overlay.innerHTML = `
    <div style="background:#ffffff;border-radius:14px;max-width:520px;width:100%;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 20px 25px -5px rgba(0,0,0,0.18);overflow:hidden;">
      <div style="padding:18px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:20px;">📢</span>
          <h3 style="margin:0;font-size:17px;">New Announcement${unseenAnns.length > 1 ? `s (${unseenAnns.length})` : ""}</h3>
        </div>
        <button type="button" id="close-ann-popup-x" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--muted);line-height:1;">✕</button>
      </div>
      <div style="padding:18px 20px;overflow-y:auto;">
        ${cardsHtml}
      </div>
      <div style="padding:14px 20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px;background:#f8fafc;">
        <button type="button" class="btn btn-primary" id="ack-ann-popup-btn">Got it ✓</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const dismissModal = () => {
    const updatedSeen = Array.from(new Set([...seenIds, ...list.map((a) => a.docId)]));
    localStorage.setItem(storageKey, JSON.stringify(updatedSeen));
    overlay.remove();
  };

  document.getElementById("ack-ann-popup-btn")?.addEventListener("click", dismissModal);
  document.getElementById("close-ann-popup-x")?.addEventListener("click", dismissModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismissModal();
  });
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
  }

  // Always update daily streak & review counts (including Bonus Practice Mode when 0 cards are due)
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

  await setDoc(
    doc(db, "users", currentStudentId),
    {
      studentId: currentStudentId,
      fullName: currentStudentProfile.fullName || currentStudentId,
      role: "student",
      ankiStats: updatedStats
    },
    { merge: true }
  );

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
    const testCount = Math.max(1, Number(task.details?.testCount) || 1);
    const totalQ = testCount * 40;
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

    const testScoreInputsHtml = Array.from({ length: testCount }, (_, idx) => {
      const label = testCount > 1 ? `Test Set ${idx + 1} — Correct Answers (out of 40)` : `Your Correct Answers (out of 40)`;
      return `<div class="form-group"><label>${label}</label><input type="number" class="dynamic-lr-set-score" data-set="${idx + 1}" min="0" max="40" required /></div>`;
    }).join("");

    rightHtml = `
      <h3>Submit Score & Screenshot</h3>
      ${testScoreInputsHtml}
      <div class="form-group"><label>Result Screenshot (PNG / JPG)</label><input type="file" id="dynamic-lr-file" accept="image/*" multiple required /></div>
      <div class="form-group"><label>Mistakes by Question Type (Combined Total)</label><div style="border:1px solid var(--border);border-radius:8px;padding:2px 12px;max-height:300px;overflow-y:auto;">${mistakeInputsHtml}</div></div>
      <button class="btn btn-primary btn-full" onclick="submitDynamicScreenshot(${totalQ})">Upload Screenshot & Submit Proof</button>
    `;
  } else if (task.skill === "speaking") {
    rightHtml = `
      <h3>Record Speaking Answer</h3>
      <div style="text-align:center;padding:24px 0;">
        <div id="rec-status-label" style="font-weight:600;margin-bottom:12px;">Ready to record</div>
        <div id="rec-timer-display" style="font-size:32px;font-weight:700;font-family:monospace;margin-bottom:16px;">00:00</div>
        <div style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin-bottom:20px;">
          <button type="button" class="btn btn-primary" id="btn-start-rec" onclick="startBrowserRecording(false)">🔴 Start Recording</button>
          <button type="button" class="btn btn-outline hidden" id="btn-rerecord-rec" onclick="startBrowserRecording(true)">↻ Re-record Last</button>
          <button type="button" class="btn btn-outline hidden" id="btn-addmore-rec" onclick="startBrowserRecording(false)" style="color:var(--primary);border-color:#bfdbfe;">➕ Record One More</button>
          <button type="button" class="btn btn-outline hidden" id="btn-stop-rec" onclick="stopBrowserRecording()" style="color:var(--danger);border-color:#fecaca;">⏹ Stop Recording</button>
        </div>
        <div id="rec-preview-area" class="hidden" style="margin-top:16px;text-align:left;"></div>
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
  recordedAudioList = [];
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
  recordedAudioList = [];
  const snap = await getDoc(doc(db, "punishments", taskId));
  if (!snap.exists()) return;
  activeDynamicTask = snap.data();
  activeDynamicCollection = "punishments";

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
  if (files.length > 8) {
    alert("You can upload a maximum of 8 images per submission.");
    return null;
  }
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
  const scoreInputs = Array.from(document.querySelectorAll(".dynamic-lr-set-score"));
  if (!fileInput.files.length) return alert("Please attach your result screenshot(s).");

  const setScores = [];
  for (let i = 0; i < scoreInputs.length; i++) {
    const valStr = scoreInputs[i].value;
    const val = Number(valStr);
    if (valStr === "" || isNaN(val) || val < 0 || val > 40) {
      return alert(`Please enter a valid score between 0 and 40 for Test Set ${i + 1}.`);
    }
    setScores.push(val);
  }
  const rawScore = setScores.reduce((sum, n) => sum + n, 0);

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

  const setBreakdownText = setScores.length > 1
    ? ` (${setScores.map((s, i) => `Set ${i + 1}: ${s}/40 [Band ${rawToIeltsBand(s, 40)}]`).join(", ")})`
    : "";

  const submissionData = {
    status: "submitted",
    submission: { scoreText: `${rawScore} / ${totalQ}${setBreakdownText}`, setScores, screenshotUrls: urls, mistakeCounts },
    submittedAt: serverTimestamp()
  };

  const bandScore = rawToIeltsBand(rawScore, totalQ);

  await setDoc(doc(db, "submissions", `${activeDynamicTask.id}_${currentStudentId}`), {
    assignmentId: activeDynamicTask.id, studentId: currentStudentId, skill: activeDynamicTask.skill, status: "submitted",
    isLate: new Date() > new Date(activeDynamicTask.dueDate), submittedAt: serverTimestamp(),
    rawScore, totalQuestions: totalQ, setScores, bandScore, screenshotUrls: urls, mistakeCounts
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
  if (recordedAudioList.length === 0) return alert("Please record your audio first.");
  const btn = document.querySelector("#hw-custom-runner-right .btn-primary, #pun-runner-right .btn-primary");
  if (btn) { btn.disabled = true; btn.textContent = `Uploading ${recordedAudioList.length} recording(s)...`; }

  try {
    const audioUrls = await uploadAllRecordedAudio(`task_${activeDynamicTask.id}`);

    await setDoc(doc(db, "submissions", `${activeDynamicTask.id}_${currentStudentId}`), {
      assignmentId: activeDynamicTask.id, studentId: currentStudentId, skill: "speaking", status: "submitted",
      isLate: new Date() > new Date(activeDynamicTask.dueDate), submittedAt: serverTimestamp(), audioUrl: audioUrls[0], audioUrls
    });

    await updateDoc(doc(db, activeDynamicCollection, activeDynamicTask.id), {
      status: "submitted", submission: { audioUrl: audioUrls[0], audioUrls }, submittedAt: serverTimestamp()
    });
    recordedAudioList = [];

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
  } catch (err) {
    alert("Audio upload failed: " + err.message);
    if (btn) { btn.disabled = false; btn.textContent = "Upload & Submit Speaking"; }
  }
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
  const missedList = [];
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
    // Ensure local timezone comparison
const dueDateObj = new Date(hw.dueDate.endsWith('Z') || hw.dueDate.includes('+') ? hw.dueDate : hw.dueDate);
const isPastDue = now > dueDateObj;
    
    if (isSub) {
      doneList.push(hw);
    } else if (isPastDue) {
      missedList.push(hw);
    } else {
      todoList.push(hw);
    }
  });

  // Adding the middle "Missed" button
  const filterControls = `
    <div style="display:flex;gap:8px;margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:12px;overflow-x:auto;">
      <button class="btn ${hwViewFilter === "todo" ? "btn-primary" : "btn-outline"} btn-sm" id="btn-hw-todo" style="white-space:nowrap;">To Do (${todoList.length})</button>
      <button class="btn ${hwViewFilter === "missed" ? "btn-primary" : "btn-outline"} btn-sm" id="btn-hw-missed" style="white-space:nowrap;${hwViewFilter !== 'missed' && missedList.length > 0 ? 'color:var(--danger);border-color:#fecaca;' : ''}">Missed (${missedList.length})</button>
      <button class="btn ${hwViewFilter === "completed" ? "btn-primary" : "btn-outline"} btn-sm" id="btn-hw-done" style="white-space:nowrap;">Completed (${doneList.length})</button>
    </div>
  `;

  const activeList = hwViewFilter === "todo" ? todoList : hwViewFilter === "missed" ? missedList : doneList;
  
  if (activeList.length === 0) {
    let emptyMsg = "";
    if (hwViewFilter === "todo") emptyMsg = "🎉 All caught up on current tasks!";
    else if (hwViewFilter === "missed") emptyMsg = "✅ Excellent! You have no missed assignments.";
    else emptyMsg = "No completed assignments yet.";

    container.innerHTML = filterControls + `<p class="muted center" style="padding:24px 0;">${emptyMsg}</p>`;
    document.getElementById("btn-hw-todo")?.addEventListener("click", () => { hwViewFilter = "todo"; renderAssignmentsList(); });
    document.getElementById("btn-hw-missed")?.addEventListener("click", () => { hwViewFilter = "missed"; renderAssignmentsList(); });
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
      const dueDateObj = new Date(hw.dueDate.endsWith('Z') || hw.dueDate.includes('+') ? hw.dueDate : hw.dueDate);
      const isPastDue = now > dueDateObj;
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
        const oneDayMs = 24 * 60 * 60 * 1000;
        const isLockedOut = now > new Date(new Date(hw.dueDate).getTime() + oneDayMs);

        if (isLockedOut) {
          statusBadge = `<span class="badge badge-red">Closed (Deadline Passed)</span>`;
          actionBtn = `<span class="muted" style="font-size:13px;font-weight:600;color:var(--danger);">Closed</span>`;
        } else if (isPastDue) {
          statusBadge = `<span class="badge badge-gray">Missing (Late Window Open)</span>`;
          actionBtn = `<button class="btn btn-primary btn-sm" onclick="window.startAssignment('${hw.id}')">Submit Late</button>`;
        } else {
          statusBadge = `<span class="badge badge-yellow">Due ${formatDueDate(hw.dueDate)}</span>`;
          actionBtn = `<button class="btn btn-primary btn-sm" onclick="window.startAssignment('${hw.id}')">Submit</button>`;
        }
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
  document.getElementById("btn-hw-missed")?.addEventListener("click", () => { hwViewFilter = "missed"; renderAssignmentsList(); });
  document.getElementById("btn-hw-done")?.addEventListener("click", () => { hwViewFilter = "completed"; renderAssignmentsList(); });
}

window.startAssignment = function (assignmentId) {
  recordedAudioList = [];
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
      promptText: t.details?.promptText || t.title, isTask1, details: t.details, imageUrls: t.imageUrls || [], status: t.status
    };
  });

  const allAssignments = [...ASSIGNMENTS, ...mappedDynamicHw];
  const hw = allAssignments.find((a) => a.id === assignmentId);
  if (!hw) return;

  if (studentSubmissionsMap[assignmentId] || hw.status === "submitted" || hw.status === "verified") {
    alert("You have already submitted this assignment.");
    renderAssignmentsList();
    return;
  }

  const oneDayMs = 24 * 60 * 60 * 1000;
  if (new Date() > new Date(new Date(hw.dueDate).getTime() + oneDayMs)) {
    alert("The 24-hour late submission window for this assignment has closed.");
    renderAssignmentsList();
    return;
  }

  document.getElementById("hw-list-view").classList.add("hidden");
  document.getElementById("hw-analysis-view").classList.add("hidden");
  document.getElementById("hw-runner-view").classList.remove("hidden");

  document.getElementById("runner-title").textContent = hw.title;
  document.getElementById("runner-due-badge").textContent = `Due: ${formatDueDate(hw.dueDate)}`;

  const leftPane = document.getElementById("runner-prompt-pane");
  const rightPane = document.getElementById("runner-work-pane");
  const refImagesHtml = (hw.imageUrls && hw.imageUrls.length > 0)
    ? `<div style="margin-top:14px;display:flex;flex-direction:column;gap:10px;">
         ${hw.imageUrls.map((url) => `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Assignment Reference" style="width:100%;max-height:360px;object-fit:contain;border:1px solid var(--border);border-radius:8px;background:#fff;" /></a>`).join("")}
       </div>`
    : "";

  if (hw.skill === "reading" || hw.skill === "listening") {
    const isDrill = Boolean(hw.isDrill);
    if (isDrill) {
      const drillTypes = hw.drillTypes || [{ key: "TFNG", label: "True / False / Not Given" }, { key: "YNNG", label: "Yes / No / Not Given" }];
      leftPane.innerHTML = `<h3>Drill Instructions</h3><p class="passage-box" style="margin-bottom:16px;">${escapeHtml(hw.instructions)}</p>
        <div style="background:#f8fafc;border:1px solid var(--border);padding:14px;border-radius:8px;font-size:13px;"><strong>How this works:</strong><br/>Enter how many questions you got right and total questions for each type.</div>${refImagesHtml}`;
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
        <div style="background:#f8fafc;border:1px solid var(--border);padding:14px;border-radius:8px;font-size:13px;"><strong>How to log your mistakes:</strong><br/>Count how many questions you missed in each category.</div>${refImagesHtml}`;
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
    const hasTeacherChart = hw.imageUrls && hw.imageUrls.length > 0;
    const chartHtml = (hw.isTask1 || hw.id === "HW-05") && !hasTeacherChart
      ? `<div class="form-group"><label>Upload Line Graph / Chart Image (Required)</label><input type="file" id="writing-chart-file" accept="image/*" multiple required /></div>`
      : "";
    leftPane.innerHTML = `<h3>Instructions</h3><p class="passage-box" style="margin-bottom:16px;white-space:pre-line;">${escapeHtml(hw.promptText || hw.title)}</p>${refImagesHtml}`;
    rightPane.innerHTML = `<h3>Your Essay / Report Response</h3>
      ${chartHtml}
      <div class="form-group"><label>Type your response here</label><textarea id="writing-essay-input" rows="12" style="width:100%;padding:12px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:14px;"></textarea></div>
      <button class="btn btn-primary btn-full" id="submit-writing-btn">Submit Writing</button>`;
    document.getElementById("submit-writing-btn").addEventListener("click", () => submitWritingHomework(hw));
  } else if (hw.skill === "speaking") {
    leftPane.innerHTML = `<h3>Instructions</h3><p class="passage-box" style="margin-bottom:16px;white-space:pre-line;">${escapeHtml(hw.instructions)}</p>${refImagesHtml}`;
    rightPane.innerHTML = `
      <h3>Record Speaking Answer</h3>
      <div style="text-align:center;padding:24px 0;">
        <div id="rec-status-label" style="font-weight:600;margin-bottom:12px;">Ready to record</div>
        <div id="rec-timer-display" style="font-size:32px;font-weight:700;font-family:monospace;margin-bottom:16px;">00:00</div>
        <div style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin-bottom:20px;">
          <button type="button" class="btn btn-primary" id="btn-start-rec" onclick="startBrowserRecording(false)">🔴 Start Recording</button>
          <button type="button" class="btn btn-outline hidden" id="btn-rerecord-rec" onclick="startBrowserRecording(true)">↻ Re-record Last</button>
          <button type="button" class="btn btn-outline hidden" id="btn-addmore-rec" onclick="startBrowserRecording(false)" style="color:var(--primary);border-color:#bfdbfe;">➕ Record One More</button>
          <button type="button" class="btn btn-outline hidden" id="btn-stop-rec" onclick="stopBrowserRecording()" style="color:var(--danger);border-color:#fecaca;">⏹ Stop Recording</button>
        </div>
        <div id="rec-preview-area" class="hidden" style="margin-top:16px;text-align:left;"></div>
      </div>
      <button class="btn btn-primary btn-full" id="submit-speaking-btn" onclick="submitSpeakingHomework('${hw.id}')">Upload & Submit Speaking</button>
    `;
  } else if (hw.skill === "grammar") {
    leftPane.innerHTML = `<h3>Instructions</h3><p class="passage-box" style="margin-bottom:16px;white-space:pre-line;">${escapeHtml(hw.instructions)}</p>${refImagesHtml}`;
    rightPane.innerHTML = `
      <h3>Upload Completed Pages</h3>
      <div class="form-group"><label>Workbook Photo / Screenshot</label><input type="file" id="gram-file" accept="image/*" multiple required /></div>
      <div class="form-group"><label>Student Notes / Questions (Optional)</label><input type="text" id="gram-notes" /></div>
      <button class="btn btn-primary btn-full" id="submit-gram-btn">Upload & Submit Homework</button>
    `;
    document.getElementById("submit-gram-btn").addEventListener("click", () => submitGrammarHomework(hw));
  } else {
    leftPane.innerHTML = `<h3>Instructions</h3><p class="passage-box" style="margin-bottom:16px;white-space:pre-line;">${escapeHtml(hw.instructions)}</p>${refImagesHtml}`;
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
  const hasTeacherChart = hw.imageUrls && hw.imageUrls.length > 0;
  if ((hw.id === "HW-05" || hw.isTask1) && !hasTeacherChart && !fileInput?.files.length) return alert("Please upload an image of the line graph you wrote about.");

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

function renderRecordedClipsList() {
  const previewArea = document.getElementById("rec-preview-area");
  const startBtn = document.getElementById("btn-start-rec");
  const rerecordBtn = document.getElementById("btn-rerecord-rec");
  const addMoreBtn = document.getElementById("btn-addmore-rec");
  if (!previewArea) return;

  if (recordedAudioList.length === 0) {
    previewArea.classList.add("hidden");
    previewArea.innerHTML = "";
    if (startBtn) {
      startBtn.textContent = "🔴 Start Recording";
      startBtn.classList.remove("hidden");
    }
    rerecordBtn?.classList.add("hidden");
    addMoreBtn?.classList.add("hidden");
    return;
  }

  previewArea.classList.remove("hidden");
  previewArea.innerHTML = recordedAudioList.map((clip, idx) => `
    <div style="background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:13px;">
        <strong>🎙️ Recording ${idx + 1} <span class="muted" style="font-weight:400;">(${clip.duration})</span></strong>
        <button type="button" class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px;color:var(--danger);border-color:#fecaca;" onclick="window.removeRecordedClip(${idx})">✕ Remove</button>
      </div>
      <audio controls src="${clip.url}" style="width:100%;height:36px;"></audio>
    </div>
  `).join("");

  startBtn?.classList.add("hidden");
  rerecordBtn?.classList.remove("hidden");
  if (addMoreBtn) {
    if (recordedAudioList.length < 5) addMoreBtn.classList.remove("hidden");
    else addMoreBtn.classList.add("hidden");
  }
}

window.removeRecordedClip = function (idx) {
  recordedAudioList.splice(idx, 1);
  renderRecordedClipsList();
  const statusEl = document.getElementById("rec-status-label");
  if (statusEl) {
    statusEl.textContent = recordedAudioList.length > 0
      ? `${recordedAudioList.length} recording(s) ready — re-record last or add another`
      : "Ready to record";
  }
};

window.startBrowserRecording = async function (replaceLast = false) {
  if (!replaceLast && recordedAudioList.length >= 5) {
    return alert("Maximum 5 recordings allowed per submission.");
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recReplaceLast = replaceLast;
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: "audio/webm" });
      const url = URL.createObjectURL(blob);
      const mins = String(Math.floor(recSeconds / 60)).padStart(2, "0");
      const secs = String(recSeconds % 60).padStart(2, "0");
      const clipObj = { blob, url, duration: `${mins}:${secs}` };

      if (recReplaceLast && recordedAudioList.length > 0) {
        recordedAudioList[recordedAudioList.length - 1] = clipObj;
      } else {
        recordedAudioList.push(clipObj);
      }

      renderRecordedClipsList();
      stream.getTracks().forEach((track) => track.stop());
    };
    mediaRecorder.start();
    recSeconds = 0;
    const takeNum = replaceLast && recordedAudioList.length > 0 ? recordedAudioList.length : recordedAudioList.length + 1;
    document.getElementById("rec-status-label").innerHTML = `<span class="rec-dot"></span> Recording Take #${takeNum}...`;
    document.getElementById("btn-start-rec")?.classList.add("hidden");
    document.getElementById("btn-rerecord-rec")?.classList.add("hidden");
    document.getElementById("btn-addmore-rec")?.classList.add("hidden");
    document.getElementById("btn-stop-rec")?.classList.remove("hidden");

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
  document.getElementById("rec-status-label").textContent = "Recording saved — listen below, re-record last, or add one more";
  document.getElementById("btn-stop-rec")?.classList.add("hidden");
};

function stopActiveRecordingCleanup() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  clearInterval(recInterval);
}

async function uploadAllRecordedAudio(prefix) {
  const uploadedUrls = [];
  for (let i = 0; i < recordedAudioList.length; i++) {
    const formData = new FormData();
    formData.append("file", recordedAudioList[i].blob, `${prefix}_part${i + 1}_${currentStudentId}.webm`);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/video/upload`, { method: "POST", body: formData });
    const data = await res.json();
    if (!data.secure_url) throw new Error(data.error?.message || `Audio #${i + 1} upload failed`);
    uploadedUrls.push(data.secure_url);
  }
  return uploadedUrls;
}

window.submitSpeakingHomework = async function (assignmentId) {
  if (recordedAudioList.length === 0) return alert("Please record your speaking answer first.");
  const btn = document.getElementById("submit-speaking-btn") || document.getElementById("pun-submit-speaking-btn");
  btn.disabled = true; btn.textContent = `Uploading ${recordedAudioList.length} recording(s)...`;

  try {
    const audioUrls = await uploadAllRecordedAudio(assignmentId);
    const submissionData = {
      assignmentId, studentId: currentStudentId, skill: "speaking", status: "submitted",
      isLate: false, submittedAt: serverTimestamp(), audioUrl: audioUrls[0], audioUrls
    };

    if (assignmentId.includes("CUSTOMHW")) await updateDoc(doc(db, "customAssignments", assignmentId), { status: "submitted" });
    if (assignmentId.includes("PUN_")) await updateDoc(doc(db, "punishments", assignmentId), { status: "submitted", submission: { audioUrl: audioUrls[0], audioUrls } });

    await setDoc(doc(db, "submissions", `${assignmentId}_${currentStudentId}`), submissionData);
    studentSubmissionsMap[assignmentId] = submissionData;
    recordedAudioList = [];
    updateDashboardUI();
    alert("Speaking recording(s) uploaded!");
    if (assignmentId.includes("PUN_")) document.getElementById("back-to-punishments-btn").click();
    else showHomeworkListView();
  } catch (err) {
    alert("Audio upload error: " + err.message);
    btn.disabled = false; btn.textContent = "Upload & Submit Speaking";
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
  stopActiveRecordingCleanup();
  document.getElementById("punishment-runner-view").classList.add("hidden");
  document.getElementById("student-punishments-container").classList.remove("hidden");
  renderStudentPunishmentsList();
  updateDashboardUI();
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
    const shortMock = (m.mockTitle || "Mock").replace(/\s*20\d{2}\s*/g, " ").replace(/Mock Exam/i, "Mock").trim();
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
    const hw = ASSIGNMENTS.find((a) => a.id === sub.assignmentId)
      || cachedTeacherHw.find((a) => a.id === sub.assignmentId)
      || cachedTeacherPunishments.find((p) => p.id === sub.assignmentId);
    if (!sub.bandScore || sub.isDrill || (hw && hw.isDrill)) return;
    if ((sub.skill === "reading" || sub.skill === "listening") && Number(sub.totalQuestions) % 40 !== 0) return;

    skillCounters[sub.skill] = (skillCounters[sub.skill] || 0) + 1;
    const dateObj = sub.submittedAt?.toDate ? sub.submittedAt.toDate() : (hw?.dueDate ? new Date(hw.dueDate) : new Date("2026-11-15"));
    const dateStr = dateObj.toISOString().split("T")[0];
    const shortDate = dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const capSkill = sub.skill.charAt(0).toUpperCase() + sub.skill.slice(1);

    events.push({
      sortKey: dateStr,
      label: `${capSkill} #${skillCounters[sub.skill]} (${shortDate})`,
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
          ticks: {
            maxRotation: 0,
            minRotation: 0,
            autoSkip: true,
            font: { size: 11 }
          },
          grid: { display: false }
        },
        y: { min: 4.0, max: 9.0, ticks: { stepSize: 0.5 } }
      },
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
