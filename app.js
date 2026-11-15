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
  collection,
  getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// 1. REPLACE THIS WITH YOUR NEW FIREBASE PROJECT CONFIG
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// Primary app for main session
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Secondary app so Teacher can create student accounts without getting logged out
const secondaryApp = initializeApp(firebaseConfig, "SecondaryAccountCreator");
const secondaryAuth = getAuth(secondaryApp);

const DOMAIN = "@zhamil-hub.local";
const TEACHER_EMAIL = "teacher" + DOMAIN;

// DOM Elements
const loginView = document.getElementById("login-view");
const appShell = document.getElementById("app-shell");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const logoutBtn = document.getElementById("logout-btn");

// Helper: Convert Student ID (e.g., "ST-101") or "teacher" to internal email
function formatLoginEmail(rawId) {
  const clean = rawId.trim().toLowerCase();
  if (clean.includes("@")) return clean;
  return clean + DOMAIN;
}

// LOGIN HANDLER
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

// LOGOUT HANDLER
logoutBtn.addEventListener("click", () => signOut(auth));

// AUTH STATE ROUTER
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    loginView.classList.remove("hidden");
    appShell.classList.add("hidden");
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
    loadStudentRoster();
  } else {
    const studentId = user.email.split("@")[0].toUpperCase();
    document.getElementById("role-badge").textContent = studentId;
    document.getElementById("student-nav").classList.remove("hidden");
    document.getElementById("teacher-nav").classList.add("hidden");
    switchView("student-dashboard");

    // Fetch student profile name
    const snap = await getDoc(doc(db, "users", studentId));
    const fullName = snap.exists() ? snap.data().fullName : studentId;
    document.getElementById("user-display-name").textContent = fullName;
    document.getElementById("welcome-student-name").textContent = fullName;
  }
});

// TAB NAVIGATION
document.querySelectorAll(".nav-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const parentNav = tab.parentElement;
    parentNav.querySelectorAll(".nav-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    switchView(tab.dataset.target);
  });
});

function switchView(targetId) {
  document.querySelectorAll(".view-section").forEach((sec) => sec.classList.add("hidden"));
  const target = document.getElementById(targetId);
  if (target) target.classList.remove("hidden");
}

// TEACHER: CREATE STUDENT ACCOUNT
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
    await signOut(secondaryAuth); // Clean up secondary session

    // Save student profile in Firestore
    await setDoc(doc(db, "users", studentId), {
      studentId,
      fullName,
      role: "student",
      createdAt: serverTimestamp(),
      ankiStats: {
        streak: 0,
        lastReviewedDate: null,
        todayCount: 0,
        totalReviewed: 0
      },
      permanentMistakes: {}
    });

    msgEl.style.color = "var(--success)";
    msgEl.textContent = `Account created! Login ID: ${studentId} | Password: ${password}`;
    createStudentForm.reset();
    loadStudentRoster();
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

// TEACHER: LOAD STUDENT ROSTER
async function loadStudentRoster() {
  const tbody = document.getElementById("roster-table-body");
  const countEl = document.getElementById("student-count");
  tbody.innerHTML = `<tr><td colspan="4" class="muted center">Loading...</td></tr>`;

  const snapshot = await getDocs(collection(db, "users"));
  const students = [];
  snapshot.forEach((docSnap) => {
    const data = docSnap.data();
    if (data.role === "student") students.push(data);
  });

  students.sort((a, b) => a.studentId.localeCompare(b.studentId));
  countEl.textContent = students.length;

  if (students.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted center">No students created yet.</td></tr>`;
    return;
  }

  const todayStr = new Date().toISOString().split("T")[0];

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
        </tr>
      `;
    })
    .join("");
}

document.getElementById("refresh-roster-btn").addEventListener("click", loadStudentRoster);
