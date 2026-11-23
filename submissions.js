import {
  doc,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db, CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET } from "./firebase.js";
import { store } from "./store.js";
import { isPastDeadline, validateImageFiles } from "./utils.js";

export async function uploadImagesToCloudinary(fileInputId, required = false) {
  const input = document.getElementById(fileInputId);
  if (!input || !input.files || input.files.length === 0) {
    if (required) throw new Error("Please attach the required image(s).");
    return [];
  }

  const check = validateImageFiles(input.files);
  if (!check.valid) throw new Error(check.error);

  const urls = [];
  for (const file of check.files) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
      { method: "POST", body: formData }
    );
    const data = await res.json();
    if (!data.secure_url) throw new Error(data.error?.message || "Image upload failed.");
    urls.push(data.secure_url);
  }
  return urls;
}

export async function uploadAudioClipsToCloudinary(clips, prefix) {
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error("Please record your audio answer or attach audio file(s) first.");
  }

  const urls = [];
  for (let i = 0; i < clips.length; i++) {
    const fileOrBlob = clips[i].blob || clips[i];
    if (!fileOrBlob || fileOrBlob.size < 500) {
      throw new Error(`Recording #${i + 1} is empty (0 bytes). Please re-record or upload a Voice Memo file.`);
    }

    const ext = clips[i].ext || (fileOrBlob.name ? fileOrBlob.name.split(".").pop() : "m4a");
    const formData = new FormData();
    formData.append("file", fileOrBlob, `${prefix}_part${i + 1}_${store.currentStudentId}.${ext}`);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/video/upload`,
      { method: "POST", body: formData }
    );
    const data = await res.json();
    if (!data.secure_url) throw new Error(data.error?.message || `Recording #${i + 1} upload failed.`);
    urls.push(data.secure_url);
  }
  return urls;
}

// Atomic submission helper: prevents duplicate submissions & updates dynamic tasks in one transaction
export async function submitTaskSubmission({
  task,
  collectionName = null, // "customAssignments" | "punishments" | null
  payload,
  updatedMistakes = null
}) {
  const studentId = store.currentStudentId;
  if (!studentId) throw new Error("Not signed in.");

  const subRef = doc(db, "submissions", `${task.id}_${studentId}`);
  const userRef = doc(db, "users", studentId);
  const dynamicRef = collectionName ? doc(db, collectionName, task.id) : null;

  const fullSubmission = {
    assignmentId: task.id,
    studentId,
    skill: task.skill,
    status: "submitted",
    isLate: task.dueDate ? isPastDeadline(task.dueDate, 0) : false,
    submittedAt: serverTimestamp(),
    ...payload
  };

  await runTransaction(db, async (tx) => {
    const existing = await tx.get(subRef);
    if (existing.exists()) {
      throw new Error("This task has already been submitted.");
    }

    tx.set(subRef, fullSubmission);

    if (dynamicRef) {
      tx.update(dynamicRef, {
        status: "submitted",
        submittedAt: serverTimestamp()
      });
    }

    if (updatedMistakes) {
      tx.set(userRef, { permanentMistakes: updatedMistakes }, { merge: true });
    }
  });

  // Sync local store immediately
  store.studentSubmissionsMap[task.id] = fullSubmission;
  if (updatedMistakes && store.currentStudentProfile) {
    store.currentStudentProfile.permanentMistakes = updatedMistakes;
  }
  if (collectionName === "punishments") {
    const pun = store.cachedStudentPunishments.find((p) => p.id === task.id);
    if (pun) pun.status = "submitted";
  }

  return fullSubmission;
}

// Memory-safe helper to revoke object URLs when removing or resetting audio clips
export function revokeClipsList(clips) {
  if (!Array.isArray(clips)) return;
  clips.forEach((clip) => {
    if (clip?.url) URL.revokeObjectURL(clip.url);
  });
}
