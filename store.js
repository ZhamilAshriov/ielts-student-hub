import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase.js";

export const store = {
  role: null, // "teacher" | "student"
  currentStudentId: null,
  currentStudentProfile: null,
  ankiProgressMap: {},
  studentSubmissionsMap: {},
  studentMocksList: [],
  allGroupUsers: [],
  allGroupMocks: [],
  cachedAnnouncements: [],
  cachedStudentPunishments: [],
  cachedStudents: [],
  cachedSubmissions: [],
  cachedMocks: [],
  cachedTeacherHw: [],
  cachedTeacherPunishments: [],
  activeDynamicTask: null,
  activeDynamicCollection: null,
  loginTimeoutId: null
};

export function clearLoginTimer() {
  if (store.loginTimeoutId) {
    clearTimeout(store.loginTimeoutId);
    store.loginTimeoutId = null;
  }
}

export async function resolveUserRole(user) {
  // 1. Prefer Firebase Auth Custom Claims if configured
  const tokenResult = await user.getIdTokenResult();
  if (tokenResult.claims?.role) {
    return tokenResult.claims.role;
  }

  // 2. Otherwise check Firestore profile document (users/{AUTH_ID})
  const cleanId = user.email.split("@")[0].toUpperCase();
  const profileSnap = await getDoc(doc(db, "users", cleanId));
  if (profileSnap.exists() && profileSnap.data().role) {
    return profileSnap.data().role;
  }

  // Fallback for legacy teacher@zhamil-hub.local before Firestore doc migration
  return cleanId === "TEACHER" ? "teacher" : "student";
}
