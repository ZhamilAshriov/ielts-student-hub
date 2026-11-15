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

const firebaseConfig = {
  apiKey: "AIzaSyDrGjx51H42h6Pkg44RIpZo0vyZApz8SGA",
  authDomain: "zhamil-ielts-hub.firebaseapp.com",
  projectId: "zhamil-ielts-hub",
  storageBucket: "zhamil-ielts-hub.firebasestorage.app",
  messagingSenderId: "101411624698",
  appId: "1:101411624698:web:862eba707513e098c65b43"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const secondaryApp = initializeApp(firebaseConfig, "SecondaryAccountCreator");
const secondaryAuth = getAuth(secondaryApp);

const DOMAIN = "@zhamil-hub.local";
const TEACHER_EMAIL = "teacher" + DOMAIN;

// Global Student Session State
let currentStudentId = null;
let currentStudentProfile = null;
let ankiProgressMap = {}; // cardId -> { easeFactor, interval, repetitions, nextReviewDate }
let ankiQueue = [];
let currentCard = null;
let isCardFlipped = false;
let bonusMode = false;

// Date Helpers (Local YYYY-MM-DD)
function getTodayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLoginEmail(rawId) {
  const clean = rawId.trim().toLowerCase();
  return clean.includes("@") ? clean : clean + DOMAIN;
}

// LOGIN & LOGOUT
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

// AUTH ROUTER
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
    loadStudentRoster();
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

// ==========================================
// TEACHER: STUDENT ACCOUNTS & ROSTER
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

async function loadStudentRoster() {
  const tbody = document.getElementById("roster-table-body");
  const countEl = document.getElementById("student-count");
  tbody.innerHTML = `<tr><td colspan="5" class="muted center">Loading...</td></tr>`;

  const snapshot = await getDocs(collection(db, "users"));
  const students = [];
  snapshot.forEach((docSnap) => {
    const data = docSnap.data();
    if (data.role === "student") students.push(data);
  });

  students.sort((a, b) => a.studentId.localeCompare(b.studentId));
  countEl.textContent = students.length;

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

document.getElementById("refresh-roster-btn").addEventListener("click", loadStudentRoster);

// ==========================================
// STUDENT: ANKI SPACED-REPETITION ENGINE
// ==========================================
function getAllVocabCards() {
  const all = [];
  VOCAB_DECKS.forEach((deck) => {
    deck.cards.forEach((c) => {
      all.push({ ...c, deckTitle: deck.title });
    });
  });
  return all;
}

async function initStudentData() {
  // 1. Load profile
  const userSnap = await getDoc(doc(db, "users", currentStudentId));
  currentStudentProfile = userSnap.exists() ? userSnap.data() : { fullName: currentStudentId, ankiStats: {} };

  document.getElementById("user-display-name").textContent = currentStudentProfile.fullName;
  document.getElementById("welcome-student-name").textContent = currentStudentProfile.fullName;

  // 2. Load student's saved card intervals from Firestore
  ankiProgressMap = {};
  const q = query(collection(db, "ankiProgress"), where("studentId", "==", currentStudentId));
  const progSnap = await getDocs(q);
  progSnap.forEach((d) => {
    const data = d.data();
    ankiProgressMap[data.cardId] = data;
  });

  bonusMode = false;
  buildAnkiQueue();
  updateDashboardAnkiUI();
}

function buildAnkiQueue() {
  const allCards = getAllVocabCards();
  const today = getTodayStr();

  if (bonusMode) {
    ankiQueue = [...allCards];
  } else {
    ankiQueue = allCards.filter((card) => {
      const prog = ankiProgressMap[card.id];
      if (!prog) return true; // New card
      return prog.nextReviewDate <= today; // Due today or overdue
    });
  }

  renderNextAnkiCard();
}

function updateDashboardAnkiUI() {
  const allCards = getAllVocabCards();
  const seenCount = Object.keys(ankiProgressMap).length;
  const dueCount = ankiQueue.length;
  const stats = currentStudentProfile.ankiStats || {};
  const today = getTodayStr();
  const yesterday = getTodayStr(-1);

  // Check if streak is still active (studied today or yesterday)
  let activeStreak = stats.streak || 0;
  if (stats.lastReviewedDate && stats.lastReviewedDate < yesterday) {
    activeStreak = 0;
  }
  const todayCount = stats.lastReviewedDate === today ? (stats.todayCount || 0) : 0;

  document.getElementById("nav-due-badge").textContent = bonusMode ? 0 : dueCount;
  document.getElementById("dash-due-count").textContent = bonusMode ? 0 : dueCount;
  document.getElementById("dash-streak-count").textContent = `🔥 ${activeStreak} days`;
  document.getElementById("dash-today-done").textContent = `${todayCount} reviewed today`;
  document.getElementById("dash-mastered-count").textContent = `${seenCount} / ${allCards.length}`;
}

function renderNextAnkiCard() {
  const stage = document.getElementById("anki-stage");
  const doneState = document.getElementById("anki-done-state");
  const subtitle = document.getElementById("anki-deck-subtitle");

  // Update New vs Review counters
  let newCnt = 0;
  let revCnt = 0;
  ankiQueue.forEach((c) => {
    if (!ankiProgressMap[c.id]) newCnt++;
    else revCnt++;
  });
  document.getElementById("anki-new-count").textContent = newCnt;
  document.getElementById("anki-review-count").textContent = revCnt;

  if (ankiQueue.length === 0) {
    stage.classList.add("hidden");
    doneState.classList.remove("hidden");
    subtitle.textContent = "Daily goal complete!";
    bonusMode = false;
    updateDashboardAnkiUI();
    return;
  }

  stage.classList.remove("hidden");
  doneState.classList.add("hidden");
  subtitle.textContent = bonusMode ? "Bonus Practice Mode (intervals won't reset)" : `${ankiQueue.length} card(s) remaining in today's session`;

  currentCard = ankiQueue[0];
  isCardFlipped = false;

  document.getElementById("card-lesson-tag").textContent = currentCard.deckTitle;
  document.getElementById("card-word").textContent = currentCard.word;
  document.getElementById("card-definition").textContent = currentCard.definition;
  document.getElementById("card-example").textContent = `"${currentCard.example}"`;

  document.getElementById("card-back").classList.add("hidden");
  document.getElementById("anki-reveal-bar").classList.remove("hidden");
  document.getElementById("anki-rate-bar").classList.add("hidden");

  // Preview SM-2 intervals on rating buttons
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

// Keyboard shortcuts (Space to flip, 1-4 to grade)
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

// SM-2 Spaced Repetition Math
function calcSM2(prev, quality) {
  let repetitions = prev.repetitions || 0;
  let interval = prev.interval || 0;
  let easeFactor = prev.easeFactor || 2.5;

  if (quality === 1) {
    // Again
    repetitions = 0;
    interval = 0;
  } else if (quality === 2) {
    // Hard
    repetitions = Math.max(1, repetitions);
    interval = 1;
    easeFactor = Math.max(1.3, easeFactor - 0.15);
  } else if (quality === 3) {
    // Good
    if (repetitions === 0) interval = 1;
    else if (repetitions === 1) interval = 6;
    else interval = Math.round(interval * easeFactor);
    repetitions += 1;
  } else if (quality === 4) {
    // Easy
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
  const card = ankiQueue.shift(); // Remove from front of queue

  if (quality === 1) {
    // Put back 2 spots later in current session
    const insertIdx = Math.min(2, ankiQueue.length);
    ankiQueue.splice(insertIdx, 0, card);
  }

  if (!bonusMode) {
    const prev = ankiProgressMap[card.id] || { repetitions: 0, interval: 0, easeFactor: 2.5 };
    const updated = calcSM2(prev, quality);
    ankiProgressMap[card.id] = { studentId: currentStudentId, cardId: card.id, ...updated };

    // Save card schedule to Firestore
    await setDoc(doc(db, "ankiProgress", `${currentStudentId}_${card.id}`), ankiProgressMap[card.id]);

    // Update student's daily streak & todayCount
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

  updateDashboardAnkiUI();
  renderNextAnkiCard();
}

document.querySelectorAll(".rate-btn").forEach((btn) => {
  btn.addEventListener("click", () => gradeCurrentCard(Number(btn.dataset.quality)));
});

document.getElementById("practice-all-btn").addEventListener("click", () => {
  bonusMode = true;
  buildAnkiQueue();
});
