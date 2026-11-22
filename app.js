import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  updatePassword
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { auth, LOGIN_DOMAIN } from "./firebase.js";
import { store, clearLoginTimer, resolveUserRole } from "./store.js";
import { getTodayStr, notify, withLoading } from "./utils.js";
import { stopActiveRecordingCleanup } from "./recorder.js";
import { initTeacherModule } from "./teacher.js";
import {
  initStudentModule,
  showHomeworkListView,
  renderStudentPunishmentsList,
  renderStatisticsPage
} from "./student.js";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

function formatLoginEmail(rawId) {
  const clean = rawId.trim().toLowerCase();
  return clean.includes("@") ? clean : clean + LOGIN_DOMAIN;
}

function switchView(targetId) {
  document.querySelectorAll(".view-section").forEach((sec) => sec.classList.add("hidden"));
  const target = document.getElementById(targetId);
  if (target) target.classList.remove("hidden");
}

// ==========================================
// LOGIN, LOGOUT & PASSWORD MANAGEMENT
// ==========================================
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");

loginForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  const rawId = document.getElementById("login-id").value;
  const password = document.getElementById("login-password").value;
  const btn = document.getElementById("login-btn");

  clearLoginTimer();
  store.loginTimeoutId = setTimeout(() => {
    btn.disabled = false;
    btn.textContent = "Sign In";
    loginError.textContent = "Connection timed out. Please check your network.";
  }, 10000);

  try {
    await withLoading(btn, "Signing in...", async () => {
      await signInWithEmailAndPassword(auth, formatLoginEmail(rawId), password);
    });
  } catch {
    loginError.textContent = "Invalid Student ID or password. Please try again.";
  } finally {
    clearLoginTimer();
  }
});

document.getElementById("logout-btn")?.addEventListener("click", () => {
  clearLoginTimer();
  stopActiveRecordingCleanup();
  signOut(auth);
});

document.getElementById("change-password-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const newPass = document.getElementById("new-pass-input").value;
  const btn = document.getElementById("change-pass-btn");
  const msg = document.getElementById("change-pass-msg");
  msg.textContent = "";

  await withLoading(btn, "Updating...", async () => {
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("No user logged in.");
      await updatePassword(user, newPass);
      msg.style.color = "var(--success)";
      msg.textContent = "Password updated successfully!";
      notify("Password updated!", "success");
      e.target.reset();
    } catch (err) {
      msg.style.color = "var(--danger)";
      msg.textContent =
        err.code === "auth/requires-recent-login"
          ? "Security check: Please log out and log back in, then try changing your password again."
          : err.message;
      throw err;
    }
  });
});

// ==========================================
// NAVIGATION & AUTH STATE ROUTER
// ==========================================
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

onAuthStateChanged(auth, async (user) => {
  clearLoginTimer();
  if (!user) {
    document.getElementById("login-view")?.classList.remove("hidden");
    document.getElementById("app-shell")?.classList.add("hidden");
    store.currentStudentId = null;
    store.role = null;
    return;
  }

  document.getElementById("login-view")?.classList.add("hidden");
  document.getElementById("app-shell")?.classList.remove("hidden");

  const role = await resolveUserRole(user);
  store.role = role;

  if (role === "teacher") {
    store.currentStudentId = null;
    document.getElementById("role-badge").textContent = "Teacher Admin";
    document.getElementById("user-display-name").textContent = "Zhamil";
    document.getElementById("teacher-nav")?.classList.remove("hidden");
    document.getElementById("student-nav")?.classList.add("hidden");

    document.getElementById("mock-date-input").value = getTodayStr();
    document.getElementById("hw-duedate").value = `${getTodayStr()}T23:59`;
    document.getElementById("pun-duedate").value = `${getTodayStr()}T23:59`;

    switchView("teacher-roster");
    initTeacherModule();
  } else {
    store.currentStudentId = user.email.split("@")[0].toUpperCase();
    document.getElementById("role-badge").textContent = store.currentStudentId;
    document.getElementById("student-nav")?.classList.remove("hidden");
    document.getElementById("teacher-nav")?.classList.add("hidden");

    switchView("student-dashboard");
    await initStudentModule();
  }
});
