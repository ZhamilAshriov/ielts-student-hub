import {
  doc,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db, CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET } from "./firebase.js";
import { store } from "./store.js";
import { isPastDeadline, validateImageFiles } from "./utils.js";

async function compressImageFile(file, maxWidth = 1400, quality = 0.82) {
  if (file.size < 350 * 1024 || file.type === "image/gif") {
    return file;
  }

  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = img;

      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (!blob || blob.size >= file.size) {
            resolve(file);
          } else {
            const cleanName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
            resolve(new File([blob], cleanName, { type: "image/jpeg" }));
          }
        },
        "image/jpeg",
        quality
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file);
    };

    img.src = objectUrl;
  });
}

export async function uploadImagesToCloudinary(fileInputId, required = false) {
  const input = document.getElementById(fileInputId);
  if (!input || !input.files || input.files.length === 0) {
    if (required) throw new Error("Please attach the required image(s).");
    return [];
  }

  const check = validateImageFiles(input.files);
  if (!check.valid) throw new Error(check.error);

  const urls = [];
  for (const rawFile of check.files) {
    const fileToUpload = await compressImageFile(rawFile);
    const formData = new FormData();
    formData.append("file", fileToUpload);
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

export async function submitTaskSubmission({
  task,
  collectionName = null,
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

export function revokeClipsList(clips) {
  if (!Array.isArray(clips)) return;
  clips.forEach((clip) => {
    if (clip?.url) URL.revokeObjectURL(clip.url);
  });
}
