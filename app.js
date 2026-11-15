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

// Cloudinary Config
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
let studentSubmissionsMap = {};

// Audio Recorder State
let mediaRecorder = null;
let recordedChunks = [];
let recordedAudioBlob = null;
let recInterval = null;
let recSeconds = 0;

// Official IELTS L/R 40-Question Band Conversion
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

// NAVIGATION
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
// TEACHER: ROSTER, HW MATRIX & SUBMISSIONS
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
        if (sub.status === "graded") return `<td><span class="badge badge-green">Verified${scoreTxt}</span></td>`;
        return `<td><span class="badge badge-blue">Submitted${scoreTxt}</span></td>`;
      } else
