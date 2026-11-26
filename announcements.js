import {
  doc,
  updateDoc,
  arrayUnion,
  arrayRemove
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase.js";
import { store } from "./store.js";
import { escapeHtml } from "./utils.js";

export const ANNOUNCEMENT_EMOJIS = ["👍", "❤️", "🔥", "🎉", "👏", "😢", "😡"];

function getOrdinalLabel(n) {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return `${n}th`;
}

export function sortAnnouncementsList(list) {
  return [...list].sort((a, b) => {
    if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
    const tA = a.updatedAtMs || (a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAtMs || 0));
    const tB = b.updatedAtMs || (b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAtMs || 0));
    return tB - tA;
  });
}

export function formatAnnouncementDate(ann) {
  const released =
    ann.dateLabel ||
    (ann.createdAt?.toDate
      ? ann.createdAt.toDate().toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        })
      : "Recent");

  const history = Array.isArray(ann.updateHistory) ? ann.updateHistory : [];
  if (history.length === 0) {
    return `Released: ${released}`;
  }

  const updatesText = history
    .map((stamp, idx) => `${getOrdinalLabel(idx + 1)} Updated: ${stamp}`)
    .join(" • ");

  return `Released: ${released} • ${updatesText}`;
}

export function getAnnouncementBadgeClass(tag) {
  if (tag === "URGENT") return "badge-red";
  if (tag === "MOCK EXAM") return "badge-blue";
  if (tag === "NEW MATERIAL") return "badge-green";
  return "badge-gray";
}

export function buildAnnouncementReactionsHtml(ann, actorId, isTeacher = false) {
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
        data-action="toggle-reaction" data-doc-id="${escapeHtml(ann.docId)}" data-emoji="${emoji}"
        style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border:1px solid;border-radius:999px;font-size:13px;cursor:pointer;transition:all 0.15s;${activeStyle}">
        <span>${emoji}</span>
        ${count > 0 ? `<span style="font-size:12px;">${count}</span>` : ""}
      </button>
    `;
  }).join("");

  return `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:8px;border-top:1px dashed var(--border);">${pills}</div>`;
}

export async function toggleAnnouncementReaction(docId, emoji, onRerender) {
  const actorId = store.currentStudentId || "TEACHER";
  const ann = store.cachedAnnouncements.find((a) => a.docId === docId);
  if (!ann) return;

  if (!ann.reactions) ann.reactions = {};
  const currentUsers = Array.isArray(ann.reactions[emoji]) ? [...ann.reactions[emoji]] : [];
  const hasReacted = currentUsers.includes(actorId);

  ann.reactions[emoji] = hasReacted
    ? currentUsers.filter((id) => id !== actorId)
    : [...currentUsers, actorId];

  if (onRerender) onRerender();

  try {
    await updateDoc(doc(db, "announcements", docId), {
      [`reactions.${emoji}`]: hasReacted ? arrayRemove(actorId) : arrayUnion(actorId)
    });
  } catch (err) {
    console.error("Reaction update error:", err);
  }
}

export function renderStudentAnnouncements(list) {
  const container = document.getElementById("student-announcements-feed");
  if (!container) return;
  if (list.length === 0) {
    container.innerHTML = `<p class="muted" style="margin-bottom:0;">No announcements from your teacher yet.</p>`;
    return;
  }
  container.innerHTML = list.map((ann) => {
    const revCount = Array.isArray(ann.updateHistory) ? ann.updateHistory.length : 0;
    return `
      <div class="hw-item" style="flex-direction:column;align-items:stretch;${ann.pinned ? "border-left:4px solid var(--primary);background:#f8fafc;" : ""}">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          ${ann.pinned ? `<span class="badge badge-yellow">📌 Pinned</span>` : ""}
          <span class="badge ${getAnnouncementBadgeClass(ann.tag)}">${escapeHtml(ann.tag || "GENERAL")}</span>
          ${revCount > 0 ? `<span class="badge badge-blue">Updated (${revCount}x)</span>` : ""}
          <strong>${escapeHtml(ann.title)}</strong>
        </div>
        <div class="muted" style="font-size:12px;margin-top:4px;">${escapeHtml(formatAnnouncementDate(ann))}</div>
        <p style="font-size:14px;white-space:pre-line;margin-top:8px;margin-bottom:0;color:var(--text);line-height:1.55;">${escapeHtml(ann.body)}</p>
        ${buildAnnouncementReactionsHtml(ann, store.currentStudentId, false)}
      </div>
    `;
  }).join("");
}

export function checkAndShowNewAnnouncementModal(list) {
  if (!store.currentStudentId || !Array.isArray(list) || list.length === 0) return;

  const storageKey = `ielts_hub_seen_anns_${store.currentStudentId}`;
  let seenTokens = [];
  try {
    seenTokens = JSON.parse(localStorage.getItem(storageKey) || "[]");
  } catch {
    seenTokens = [];
  }

  const getVersionToken = (ann) => {
    const revCount = Array.isArray(ann.updateHistory) ? ann.updateHistory.length : 0;
    return `${ann.docId}_v${revCount}`;
  };

  const seenSet = new Set(seenTokens);
  const unseenAnns = list.filter((ann) => !seenSet.has(getVersionToken(ann)));
  if (unseenAnns.length === 0) return;

  document.getElementById("new-ann-popup-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "new-ann-popup-overlay";
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(15, 23, 42, 0.55);
    display: flex; align-items: center; justify-content: center;
    padding: 16px; z-index: 9999; backdrop-filter: blur(2px);
  `;

  const cardsHtml = unseenAnns.map((ann) => {
    const revCount = Array.isArray(ann.updateHistory) ? ann.updateHistory.length : 0;
    return `
      <div style="background:#f8fafc;border:1px solid var(--border);${ann.pinned ? "border-left:4px solid var(--primary);" : ""}border-radius:10px;padding:14px 16px;margin-bottom:12px;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
          ${ann.pinned ? `<span class="badge badge-yellow">📌 Pinned</span>` : ""}
          <span class="badge ${getAnnouncementBadgeClass(ann.tag)}">${escapeHtml(ann.tag || "GENERAL")}</span>
          ${revCount > 0 ? `<span class="badge badge-blue">Updated (${revCount}x)</span>` : ""}
        </div>
        <div class="muted" style="font-size:11px;margin-bottom:6px;">${escapeHtml(formatAnnouncementDate(ann))}</div>
        <div style="font-weight:700;font-size:15px;color:var(--text);margin-bottom:6px;">${escapeHtml(ann.title)}</div>
        <div style="font-size:14px;white-space:pre-line;color:var(--text);line-height:1.55;">${escapeHtml(ann.body)}</div>
      </div>
    `;
  }).join("");

  overlay.innerHTML = `
    <div style="background:#ffffff;border-radius:14px;max-width:520px;width:100%;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 20px 25px -5px rgba(0,0,0,0.18);overflow:hidden;">
      <div style="padding:18px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:20px;">📢</span>
          <h3 style="margin:0;font-size:17px;">New / Updated Announcement${unseenAnns.length > 1 ? `s (${unseenAnns.length})` : ""}</h3>
        </div>
        <button type="button" id="close-ann-popup-x" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--muted);line-height:1;">✕</button>
      </div>
      <div style="padding:18px 20px;overflow-y:auto;">${cardsHtml}</div>
      <div style="padding:14px 20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px;background:#f8fafc;">
        <button type="button" class="btn btn-primary" id="ack-ann-popup-btn">Got it ✓</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const dismissModal = () => {
    const updatedSeen = Array.from(new Set([...seenTokens, ...list.map(getVersionToken)]));
    localStorage.setItem(storageKey, JSON.stringify(updatedSeen));
    overlay.remove();
  };

  document.getElementById("ack-ann-popup-btn")?.addEventListener("click", dismissModal);
  document.getElementById("close-ann-popup-x")?.addEventListener("click", dismissModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismissModal();
  });
}
