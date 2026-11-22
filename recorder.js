import { notify } from "./utils.js";
import { revokeClipsList } from "./submissions.js";

let mediaRecorder = null;
let recordedChunks = [];
let recordedAudioList = []; // Array of { blob, url, duration }
let recReplaceLast = false;
let recInterval = null;
let recSeconds = 0;

export function getRecordedClips() {
  return recordedAudioList;
}

export function resetRecordedClips() {
  revokeClipsList(recordedAudioList);
  recordedAudioList = [];
}

export function stopActiveRecordingCleanup() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  clearInterval(recInterval);
}

export function renderRecordedClipsList() {
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
  previewArea.innerHTML = recordedAudioList
    .map(
      (clip, idx) => `
    <div style="background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:13px;">
        <strong>🎙️ Recording ${idx + 1} <span class="muted" style="font-weight:400;">(${clip.duration})</span></strong>
        <button type="button" class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px;color:var(--danger);border-color:#fecaca;" data-remove-clip="${idx}">✕ Remove</button>
      </div>
      <audio controls src="${clip.url}" style="width:100%;height:36px;"></audio>
    </div>
  `
    )
    .join("");

  previewArea.querySelectorAll("[data-remove-clip]").forEach((btn) => {
    btn.addEventListener("click", () => removeRecordedClip(Number(btn.dataset.removeClip)));
  });

  startBtn?.classList.add("hidden");
  rerecordBtn?.classList.remove("hidden");
  if (addMoreBtn) {
    if (recordedAudioList.length < 5) addMoreBtn.classList.remove("hidden");
    else addMoreBtn.classList.add("hidden");
  }
}

export function removeRecordedClip(idx) {
  const [removed] = recordedAudioList.splice(idx, 1);
  if (removed?.url) URL.revokeObjectURL(removed.url);
  renderRecordedClipsList();
  const statusEl = document.getElementById("rec-status-label");
  if (statusEl) {
    statusEl.textContent =
      recordedAudioList.length > 0
        ? `${recordedAudioList.length} recording(s) ready — re-record last or add another`
        : "Ready to record";
  }
}

export async function startBrowserRecording(replaceLast = false) {
  if (!replaceLast && recordedAudioList.length >= 5) {
    notify("Maximum 5 recordings allowed per submission.", "warning");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recReplaceLast = replaceLast;
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: "audio/webm" });
      const url = URL.createObjectURL(blob);
      const mins = String(Math.floor(recSeconds / 60)).padStart(2, "0");
      const secs = String(recSeconds % 60).padStart(2, "0");
      const clipObj = { blob, url, duration: `${mins}:${secs}` };

      if (recReplaceLast && recordedAudioList.length > 0) {
        const old = recordedAudioList[recordedAudioList.length - 1];
        if (old?.url) URL.revokeObjectURL(old.url);
        recordedAudioList[recordedAudioList.length - 1] = clipObj;
      } else {
        recordedAudioList.push(clipObj);
      }

      renderRecordedClipsList();
      stream.getTracks().forEach((track) => track.stop());
    };
    mediaRecorder.start();
    recSeconds = 0;
    const takeNum =
      replaceLast && recordedAudioList.length > 0 ? recordedAudioList.length : recordedAudioList.length + 1;
    document.getElementById("rec-status-label").innerHTML =
      `<span class="rec-dot"></span> Recording Take #${takeNum}...`;
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
  } catch {
    notify("Microphone access denied. Please allow microphone permissions.", "error");
  }
}

export function stopBrowserRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  clearInterval(recInterval);
  const statusEl = document.getElementById("rec-status-label");
  if (statusEl) {
    statusEl.textContent = "Recording saved — listen below, re-record last, or add one more";
  }
  document.getElementById("btn-stop-rec")?.classList.add("hidden");
}
