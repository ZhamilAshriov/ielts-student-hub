import {
  createUserWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db, secondaryAuth, LOGIN_DOMAIN } from "./firebase.js";
import { store } from "./store.js";
import {
  escapeHtml,
  notify,
  withLoading,
  getTodayStr,
  formatDueDate,
  parseLocalDeadline
} from "./utils.js";
import { uploadImagesToCloudinary } from "./submissions.js";
import {
  MISTAKE_LABELS,
  rawToIeltsBand,
  calcOverallIelts,
  buildScoreChart,
  renderMistakeBars
} from "./charts.js";
import {
  sortAnnouncementsList,
  formatAnnouncementDate,
  getAnnouncementBadgeClass,
  buildAnnouncementReactionsHtml,
  toggleAnnouncementReaction
} from "./announcements.js";
import { ASSIGNMENTS } from "./assignments-data.js";

let inspectorChartInstance = null;
let showArchivedCustomHw = false;
let showArchivedMatrixHw = false;
let showArchivedGraded = false;
let teacherListenersBound = false;

export function initTeacherModule() {
  if (!teacherListenersBound) {
    bindTeacherStaticListeners();
    bindTeacherDelegatedClicks();
    teacherListenersBound = true;
  }
  loadTeacherData();
}

function bindTeacherStaticListeners() {
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

  document.getElementById("assign-hw-form")?.addEventListener("submit", handleAssignHomework);
  document.getElementById("assign-pun-form")?.addEventListener("submit", handleAssignPunishment);
  document.getElementById("create-student-form")?.addEventListener("submit", handleCreateStudent);
  document.getElementById("announcement-form")?.addEventListener("submit", handlePostAnnouncement);
  document.getElementById("mock-score-form")?.addEventListener("submit", handleSaveMockScore);

  document.getElementById("close-inspector-btn")?.addEventListener("click", () => {
    document.getElementById("teacher-inspector-card")?.classList.add("hidden");
  });

  document.getElementById("refresh-hw-btn")?.addEventListener("click", loadTeacherData);
  document.getElementById("refresh-pun-btn")?.addEventListener("click", loadTeacherData);
  document.getElementById("refresh-ann-btn")?.addEventListener("click", loadTeacherData);
  document.getElementById("refresh-roster-btn")?.addEventListener("click", loadTeacherData);
  document.getElementById("refresh-matrix-btn")?.addEventListener("click", loadTeacherData);
  document.getElementById("refresh-grading-btn")?.addEventListener("click", loadTeacherData);
  document.getElementById("refresh-attendance-table-btn")?.addEventListener("click", renderTeacherAttendanceManager);
  document.getElementById("refresh-qr-btn")?.addEventListener("click", renderTeacherAttendanceManager);
}

function bindTeacherDelegatedClicks() {
  document.getElementById("app-shell")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || store.role !== "teacher") return;
    const action = btn.dataset.action;

    if (action === "toggle-reaction") {
      await toggleAnnouncementReaction(btn.dataset.docId, btn.dataset.emoji, () =>
        renderTeacherAnnouncementsList(store.cachedAnnouncements)
      );
    } else if (action === "inspect-student") {
      inspectStudent(btn.dataset.studentId);
    } else if (action === "delete-ann") {
      await deleteAnnouncement(btn.dataset.docId);
    } else if (action === "toggle-archived-hw") {
      showArchivedCustomHw = !showArchivedCustomHw;
      renderTeacherCustomHw(store.cachedTeacherHw, store.cachedStudents);
    } else if (action === "toggle-archived-matrix") {
      showArchivedMatrixHw = !showArchivedMatrixHw;
      renderTeacherHwMatrix(store.cachedStudents, store.cachedSubmissions);
    } else if (action === "toggle-archived-graded") {
      showArchivedGraded = !showArchivedGraded;
      renderTeacherGradingQueue(store.cachedStudents, store.cachedSubmissions);
    } else if (action === "delete-dynamic-task") {
      await deleteDynamicTask(btn.dataset.id, btn.dataset.collection);
    } else if (action === "quick-punish") {
      quickAssignPunishment(btn.dataset.studentId, btn.dataset.skill);
    } else if (action === "save-grade") {
      await saveTeacherGrade(btn.dataset.docId, btn.dataset.assignmentId, btn.dataset.noBand === "true");
    } else if (action === "delete-submission") {
      await deleteSubmission(btn.dataset.docId, btn.dataset.assignmentId);
    } else if (action === "ai-eval-writing") {
      await evaluateWritingSubmission(btn.dataset.docId);
    } else if (action === "ai-eval-speaking") {
      await transcribeAndEvaluateSpeaking(btn.dataset.docId);
    } else if (action === "set-gemini-key") {
      setTeacherGeminiKey();
    }
  });

  document.getElementById("app-shell")?.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-action='toggle-writing-task']");
    if (!sel) return;
    toggleWritingTaskConfig(sel, sel.dataset.containerId);
  });
}

export async function loadTeacherData() {
  const [usersSnap, subsSnap, mocksSnap, annSnap, customHwSnap, punSnap] = await Promise.all([
    getDocs(collection(db, "users")),
    getDocs(collection(db, "submissions")),
    getDocs(collection(db, "mockScores")),
    getDocs(collection(db, "announcements")),
    getDocs(collection(db, "customAssignments")),
    getDocs(collection(db, "punishments"))
  ]);

  const students = [];
  usersSnap.forEach((d) => {
    if (d.data().role === "student") students.push(d.data());
  });
  students.sort((a, b) => a.studentId.localeCompare(b.studentId));
  store.cachedStudents = students;

  const submissions = [];
  subsSnap.forEach((d) => submissions.push({ docId: d.id, ...d.data() }));
  store.cachedSubmissions = submissions;

  const mocks = [];
  mocksSnap.forEach((d) => mocks.push({ docId: d.id, ...d.data() }));
  mocks.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  store.cachedMocks = mocks;

  const rawAnns = [];
  annSnap.forEach((d) => rawAnns.push({ docId: d.id, ...d.data() }));
  store.cachedAnnouncements = sortAnnouncementsList(rawAnns);

  const teacherHw = [];
  customHwSnap.forEach((d) => teacherHw.push(d.data()));
  teacherHw.sort((a, b) => (b.dueDate || "").localeCompare(a.dueDate || ""));
  store.cachedTeacherHw = teacherHw;

  const teacherPuns = [];
  punSnap.forEach((d) => teacherPuns.push(d.data()));
  teacherPuns.sort((a, b) => (b.dueDate || "").localeCompare(a.dueDate || ""));
  store.cachedTeacherPunishments = teacherPuns;

  renderTeacherRoster(store.cachedStudents);
  renderTeacherHwMatrix(store.cachedStudents, store.cachedSubmissions);
  renderTeacherGradingQueue(store.cachedStudents, store.cachedSubmissions);
  populateMockStudentDropdown(store.cachedStudents);
  populateTargetDropdowns(store.cachedStudents);
  renderRecentMocksTable(store.cachedStudents, store.cachedMocks);
  renderTeacherAnnouncementsList(store.cachedAnnouncements);
  renderTeacherCustomHw(store.cachedTeacherHw, store.cachedStudents);
  renderTeacherPunishments(store.cachedTeacherPunishments, store.cachedStudents);
  renderTeacherAttendanceManager();
}

function populateTargetDropdowns(students) {
  const optionsHtml =
    `<option value="">-- Choose Target --</option><option value="ALL">📢 All Students (Whole Class Broadcast)</option>` +
    students.map((s) => `<option value="${escapeHtml(s.studentId)}">${escapeHtml(s.studentId)} — ${escapeHtml(s.fullName)}</option>`).join("");
  const hwSel = document.getElementById("hw-target-select");
  const punSel = document.getElementById("pun-target-select");
  if (hwSel) hwSel.innerHTML = optionsHtml;
  if (punSel) punSel.innerHTML = optionsHtml;
}

function renderSkillConfigForm(skillSelectId, containerId) {
  const skill = document.getElementById(skillSelectId)?.value;
  const container = document.getElementById(containerId);
  if (!container) return;

  if (skill === "listening" || skill === "reading") {
    container.innerHTML = `<div class="form-group"><label>Number of Test Sets / Passages</label><input type="number" class="config-count" min="1" max="10" value="1" required /></div>`;
  } else if (skill === "writing") {
    container.innerHTML = `
      <div class="form-group">
        <label>Writing Task Type</label>
        <select class="config-w-task" data-action="toggle-writing-task" data-container-id="${containerId}">
          <option value="task1">Task 1 (Chart / Graph / Diagram - Requires Image Upload)</option>
          <option value="task2">Task 2 (Essay - Custom Title & Prompt)</option>
        </select>
      </div>
      <div class="config-writing-subfields">
        <div class="form-group"><label>Task 1 Title / Instructions</label><input type="text" class="config-w-title" placeholder="e.g. Summarize the line graph below" required /></div>
      </div>`;
  } else if (skill === "speaking") {
    container.innerHTML = `
      <div class="form-group"><label>Speaking Questions / Topics</label><textarea class="config-spk-questions" rows="3" placeholder="Enter questions here..." required></textarea></div>
      <div class="form-group"><label>Notes & Instructions for Students</label><textarea class="config-spk-notes" rows="2" placeholder="e.g. Speak for 2 full minutes. Record clearly." required></textarea></div>`;
  } else if (skill === "grammar") {
    container.innerHTML = `
      <div class="form-group"><label>Grammar Instructions / Title</label><input type="text" class="config-g-title" placeholder="e.g. Grammar Book: Sections 1-6" required /></div>
      <div class="form-group"><label>Detailed Notes for Students</label><textarea class="config-g-notes" rows="2" placeholder="e.g. Complete exercises and upload a clear photo."></textarea></div>`;
  } else if (skill === "other") {
    container.innerHTML = `
      <div class="form-group"><label>Task Title / Topic</label><input type="text" class="config-o-title" placeholder="e.g. Vocabulary Workbook Unit 3" required /></div>
      <div class="form-group"><label>Task Instructions</label><textarea class="config-o-notes" rows="2" placeholder="e.g. Write your answers in the response box..."></textarea></div>`;
  }
}

function toggleWritingTaskConfig(selectEl, containerId) {
  const container = document.getElementById(containerId);
  const subfields = container?.querySelector(".config-writing-subfields");
  if (!subfields) return;

  if (selectEl.value === "task1") {
    subfields.innerHTML = `<div class="form-group"><label>Task 1 Title / Instructions</label><input type="text" class="config-w-title" placeholder="e.g. Summarize the line graph below" required /></div>`;
  } else {
    subfields.innerHTML = `
      <div class="form-group"><label>Task 2 Essay Title</label><input type="text" class="config-w-title" placeholder="e.g. Opinion Essay: Remote Work" required /></div>
      <div class="form-group"><label>Essay Prompt / Question</label><textarea class="config-w-prompt" rows="3" placeholder="Enter the full essay prompt here..." required></textarea></div>`;
  }
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
    details = isTask1
      ? { taskType: "task1", title }
      : { taskType: "task2", title, promptText: container.querySelector(".config-w-prompt").value.trim() };
  } else if (skill === "speaking") {
    title = "Speaking Practice & Questions";
    details = {
      questions: container.querySelector(".config-spk-questions").value.trim(),
      notes: container.querySelector(".config-spk-notes").value.trim()
    };
  } else if (skill === "grammar") {
    title = container.querySelector(".config-g-title").value.trim();
    details = { instructions: container.querySelector(".config-g-notes").value.trim() };
  } else if (skill === "other") {
    title = container.querySelector(".config-o-title").value.trim();
    details = { instructions: container.querySelector(".config-o-notes").value.trim() };
  }
  return { title, details };
}

async function handleAssignHomework(e) {
  e.preventDefault();
  const btn = document.getElementById("assign-hw-btn");
  const msgEl = document.getElementById("hw-assign-msg");
  const target = document.getElementById("hw-target-select").value;
  const skill = document.getElementById("hw-skill-select").value;
  const dueDate = document.getElementById("hw-duedate").value;
  if (!target || !dueDate) return notify("Please select a target and deadline.", "warning");

  const { title, details } = extractDynamicFormDetails(skill, "hw-config-container");
  msgEl.textContent = "";

  await withLoading(btn, "Publishing...", async () => {
    const imageUrls = await uploadImagesToCloudinary("hw-attach-images", false);
    let activeWeek = "Current Assignments";
    if (ASSIGNMENTS.length > 0) {
      const upcoming = ASSIGNMENTS.find((a) => parseLocalDeadline(a.dueDate) >= new Date());
      activeWeek = upcoming ? upcoming.week : ASSIGNMENTS[ASSIGNMENTS.length - 1].week;
    }

    const targets = target === "ALL" ? store.cachedStudents.map((s) => s.studentId) : [target];
    for (const studentId of targets) {
      const taskId = `CUSTOMHW_${studentId}_${Date.now()}`;
      await setDoc(doc(db, "customAssignments", taskId), {
        id: taskId,
        studentId,
        skill,
        title,
        details,
        imageUrls,
        dueDate,
        week: activeWeek,
        status: "pending",
        createdAt: serverTimestamp()
      });
    }

    msgEl.style.color = "var(--success)";
    msgEl.textContent = target === "ALL" ? "Successfully broadcasted homework!" : `Assigned to ${target}!`;
    notify("Homework published!", "success");
    e.target.reset();
    document.getElementById("hw-duedate").value = `${getTodayStr()}T23:59`;
    renderSkillConfigForm("hw-skill-select", "hw-config-container");
    await loadTeacherData();
  });
}

async function handleAssignPunishment(e) {
  e.preventDefault();
  const btn = document.getElementById("assign-pun-btn");
  const msgEl = document.getElementById("pun-assign-msg");
  const target = document.getElementById("pun-target-select").value;
  const skill = document.getElementById("pun-skill-select").value;
  const dueDate = document.getElementById("pun-duedate").value;
  if (!target || !dueDate) return notify("Please select a target and deadline.", "warning");

  let { title, details } = extractDynamicFormDetails(skill, "pun-config-container");
  title = `Extra/Remedial: ${title}`;
  msgEl.textContent = "";

  await withLoading(btn, "Assigning...", async () => {
    const targets = target === "ALL" ? store.cachedStudents.map((s) => s.studentId) : [target];
    for (const studentId of targets) {
      const taskId = `PUN_${studentId}_${Date.now()}`;
      await setDoc(doc(db, "punishments", taskId), {
        id: taskId,
        studentId,
        skill,
        reason: title,
        details,
        status: "pending",
        dueDate,
        assignedAt: serverTimestamp()
      });
    }

    msgEl.style.color = "var(--success)";
    msgEl.textContent = target === "ALL" ? "Successfully assigned punishments!" : `Assigned punishment to ${target}!`;
    notify("Remedial task assigned!", "success");
    e.target.reset();
    document.getElementById("pun-duedate").value = `${getTodayStr()}T23:59`;
    renderSkillConfigForm("pun-skill-select", "pun-config-container");
    await loadTeacherData();
  });
}

function renderTeacherCustomHw(tasks, students) {
  const tbody = document.getElementById("group-hw-tbody");
  if (!tbody) return;

  const cutoffMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const activeTasks = showArchivedCustomHw
    ? tasks
    : tasks.filter((t) => !t.dueDate || parseLocalDeadline(t.dueDate).getTime() >= cutoffMs);
  const hiddenCount = tasks.length - activeTasks.length;

  if (activeTasks.length === 0) {
    tbody.innerHTML =
      hiddenCount > 0
        ? `<tr><td colspan="4" class="muted center">No recent homework (${hiddenCount} older tasks hidden). <button type="button" class="btn btn-outline btn-sm" style="margin-left:8px;" data-action="toggle-archived-hw">Show Archived</button></td></tr>`
        : `<tr><td colspan="4" class="muted center">No active custom homework.</td></tr>`;
    return;
  }

  const nameMap = {};
  students.forEach((s) => {
    nameMap[s.studentId] = s.fullName;
  });

  const groupedMap = new Map();
  activeTasks.forEach((t) => {
    const key = `${t.skill}|${t.title}|${t.dueDate}`;
    if (!groupedMap.has(key)) {
      groupedMap.set(key, { representativeId: t.id, skill: t.skill, title: t.title, dueDate: t.dueDate, items: [] });
    }
    groupedMap.get(key).items.push(t);
  });

  const rowsHtml = Array.from(groupedMap.values())
    .map((group) => {
      const isBatch = group.items.length > 1;
      const first = group.items[0];
      let targetHtml = "";
      let statusHtml = "";

      if (isBatch) {
        const doneCount = group.items.filter((i) => i.status === "submitted" || i.status === "verified").length;
        const pendingStudents = group.items
          .filter((i) => i.status !== "submitted" && i.status !== "verified")
          .map((i) => i.studentId);

        targetHtml =
          `<strong>📢 Group (${group.items.length} students)</strong>` +
          (pendingStudents.length > 0
            ? `<br><span class="muted" style="font-size:11px;">Pending: ${escapeHtml(pendingStudents.slice(0, 4).join(", "))}${pendingStudents.length > 4 ? ` +${pendingStudents.length - 4} more` : ""}</span>`
            : `<br><span style="color:var(--success);font-size:11px;font-weight:600;">All submitted!</span>`);

        const badgeClass = doneCount === group.items.length ? "badge-green" : doneCount > 0 ? "badge-blue" : "badge-red";
        statusHtml = `<span class="badge ${badgeClass}">${doneCount} / ${group.items.length} Done</span>`;
      } else {
        const sName = nameMap[first.studentId] || first.studentId;
        targetHtml = `<strong>${escapeHtml(first.studentId)}</strong><br><span class="muted" style="font-size:12px;">${escapeHtml(sName)}</span>`;
        statusHtml =
          first.status === "verified"
            ? `<span class="badge badge-green">Verified</span>`
            : first.status === "submitted"
              ? `<span class="badge badge-blue">Submitted</span>`
              : `<span class="badge badge-red">Pending</span>`;
      }

      const deleteLabel = isBatch ? "Delete All" : "Delete";
      return `
        <tr>
          <td>${targetHtml}</td>
          <td><span class="role-pill">${escapeHtml(group.skill.toUpperCase())}</span><br>${escapeHtml(group.title)}</td>
          <td>${statusHtml}<br><span class="muted" style="font-size:11px;">Due: ${formatDueDate(group.dueDate)}</span></td>
          <td><button type="button" class="btn btn-outline btn-sm" style="color:var(--danger);border-color:#fecaca;" data-action="delete-dynamic-task" data-id="${escapeHtml(group.representativeId)}" data-collection="customAssignments">${deleteLabel}</button></td>
        </tr>`;
    })
    .join("");

  const footerHtml =
    hiddenCount > 0 || showArchivedCustomHw
      ? `<tr><td colspan="4" class="center" style="padding:10px;"><button type="button" class="btn btn-outline btn-sm" data-action="toggle-archived-hw">${showArchivedCustomHw ? "Hide Archived (14d+)" : `Show Archived (${hiddenCount} older)`}</button></td></tr>`
      : "";

  tbody.innerHTML = rowsHtml + footerHtml;
}

function renderTeacherPunishments(tasks, students) {
  const tbody = document.getElementById("group-pun-tbody");
  if (!tbody) return;
  if (tasks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted center">No active punishments.</td></tr>`;
    return;
  }
  const nameMap = {};
  students.forEach((s) => {
    nameMap[s.studentId] = s.fullName;
  });

  tbody.innerHTML = tasks
    .map((t) => {
      const sName = nameMap[t.studentId] || t.studentId;
      const statusBadge =
        t.status === "verified"
          ? `<span class="badge badge-green">Verified</span>`
          : t.status === "submitted"
            ? `<span class="badge badge-blue">Submitted</span>`
            : `<span class="badge badge-red">Pending</span>`;

      return `
        <tr>
          <td><strong>${escapeHtml(t.studentId)}</strong><br><span class="muted" style="font-size:12px;">${escapeHtml(sName)}</span></td>
          <td><span class="role-pill">${escapeHtml(t.skill.toUpperCase())}</span><br>${escapeHtml(t.reason)}</td>
          <td>${statusBadge}<br><span class="muted" style="font-size:11px;">Due: ${formatDueDate(t.dueDate)}</span></td>
          <td><button type="button" class="btn btn-outline btn-sm" style="color:var(--danger);border-color:#fecaca;" data-action="delete-dynamic-task" data-id="${escapeHtml(t.id)}" data-collection="punishments">Delete</button></td>
        </tr>`;
    })
    .join("");
}

async function deleteDynamicTask(id, collectionName) {
  const list = collectionName === "customAssignments" ? store.cachedTeacherHw : store.cachedTeacherPunishments;
  const target = list.find((item) => item.id === id);
  const label = target ? target.title || target.reason : "";
  const matching = target ? list.filter((item) => (item.title || item.reason) === label && item.dueDate === target.dueDate) : [];

  if (
    matching.length > 1 &&
    confirm(`Found ${matching.length} copies of "${label}" for this deadline.\n\nClick OK to delete ALL ${matching.length} copies at once, or Cancel to delete only this student's copy.`)
  ) {
    await Promise.all(matching.map((item) => deleteDoc(doc(db, collectionName, item.id))));
    const idsToRemove = new Set(matching.map((m) => m.id));
    if (collectionName === "customAssignments") {
      store.cachedTeacherHw = store.cachedTeacherHw.filter((t) => !idsToRemove.has(t.id));
      renderTeacherCustomHw(store.cachedTeacherHw, store.cachedStudents);
      renderTeacherHwMatrix(store.cachedStudents, store.cachedSubmissions);
    } else {
      store.cachedTeacherPunishments = store.cachedTeacherPunishments.filter((t) => !idsToRemove.has(t.id));
      renderTeacherPunishments(store.cachedTeacherPunishments, store.cachedStudents);
    }
    notify(`Deleted ${matching.length} tasks.`, "success");
    return;
  }

  if (!confirm("Delete this assigned record?")) return;
  await deleteDoc(doc(db, collectionName, id));
  if (collectionName === "customAssignments") {
    store.cachedTeacherHw = store.cachedTeacherHw.filter((t) => t.id !== id);
    renderTeacherCustomHw(store.cachedTeacherHw, store.cachedStudents);
    renderTeacherHwMatrix(store.cachedStudents, store.cachedSubmissions);
  } else {
    store.cachedTeacherPunishments = store.cachedTeacherPunishments.filter((t) => t.id !== id);
    renderTeacherPunishments(store.cachedTeacherPunishments, store.cachedStudents);
  }
  notify("Task deleted.", "success");
}

async function handleCreateStudent(e) {
  e.preventDefault();
  const msgEl = document.getElementById("create-student-msg");
  const btn = document.getElementById("create-student-btn");
  const fullName = document.getElementById("new-student-name").value.trim();
  const studentId = document.getElementById("new-student-id").value.trim().toUpperCase();
  const password = document.getElementById("new-student-pass").value;

  if (!/^ST-\d{2,4}$/.test(studentId)) {
    return notify("Student ID should follow format ST-101.", "warning");
  }
  if (password.length < 6) {
    return notify("Password must be at least 6 characters.", "warning");
  }

  msgEl.textContent = "";
  await withLoading(btn, "Creating...", async () => {
    try {
      const email = studentId.toLowerCase() + LOGIN_DOMAIN;
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
      notify(`Created account for ${fullName}`, "success");
      e.target.reset();
      await loadTeacherData();
    } catch (err) {
      msgEl.style.color = "var(--danger)";
      msgEl.textContent = err.code === "auth/email-already-in-use" ? `Student ID "${studentId}" already exists.` : `Error: ${err.message}`;
      throw err;
    }
  });
}

async function handlePostAnnouncement(e) {
  e.preventDefault();
  const msgEl = document.getElementById("ann-post-msg");
  const btn = document.getElementById("post-ann-btn");
  const title = document.getElementById("ann-title").value.trim();
  const tag = document.getElementById("ann-tag").value;
  const body = document.getElementById("ann-body").value.trim();
  const pinned = document.getElementById("ann-pinned").checked;

  msgEl.textContent = "";
  await withLoading(btn, "Publishing...", async () => {
    const docId = `ANN_${Date.now()}`;
    await setDoc(doc(db, "announcements", docId), {
      title,
      tag,
      body,
      pinned,
      dateLabel: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      createdAtMs: Date.now(),
      createdAt: serverTimestamp()
    });
    msgEl.style.color = "var(--success)";
    msgEl.textContent = "Announcement published!";
    notify("Announcement published!", "success");
    e.target.reset();
    await loadTeacherData();
  });
}

function renderTeacherAnnouncementsList(list) {
  const container = document.getElementById("teacher-ann-list");
  if (!container) return;
  if (list.length === 0) {
    container.innerHTML = `<p class="muted center">No announcements published yet.</p>`;
    return;
  }
  container.innerHTML = list
    .map(
      (ann) => `
    <div class="hw-item" style="flex-direction:column;align-items:stretch;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div>
          ${ann.pinned ? `<span class="badge badge-yellow" style="margin-right:4px;">📌 Pinned</span>` : ""}
          <span class="badge ${getAnnouncementBadgeClass(ann.tag)}">${escapeHtml(ann.tag || "GENERAL")}</span>
          <span class="muted" style="font-size:12px;margin-left:6px;">${formatAnnouncementDate(ann)}</span>
          <h3 style="margin-top:6px;">${escapeHtml(ann.title)}</h3>
        </div>
        <button type="button" class="btn btn-outline btn-sm" style="color:var(--danger);border-color:#fecaca;" data-action="delete-ann" data-doc-id="${escapeHtml(ann.docId)}">Delete</button>
      </div>
      <p style="font-size:14px;white-space:pre-line;margin-top:8px;margin-bottom:0;color:var(--text);">${escapeHtml(ann.body)}</p>
      ${buildAnnouncementReactionsHtml(ann, "TEACHER", true)}
    </div>`
    )
    .join("");
}

async function deleteAnnouncement(docId) {
  if (!confirm("Delete this announcement?")) return;
  await deleteDoc(doc(db, "announcements", docId));
  store.cachedAnnouncements = store.cachedAnnouncements.filter((a) => a.docId !== docId);
  renderTeacherAnnouncementsList(store.cachedAnnouncements);
  notify("Announcement deleted.", "success");
}

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
      const reviewedToday = stats.lastReviewedDate === todayStr ? stats.todayCount || 0 : 0;
      return `
      <tr>
        <td><strong>${escapeHtml(s.studentId)}</strong></td>
        <td>${escapeHtml(s.fullName)}</td>
        <td>🔥 ${stats.streak || 0}d</td>
        <td>${reviewedToday > 0 ? `<span style="color:var(--success);font-weight:600;">${reviewedToday}</span>` : `<span class="muted">0</span>`}</td>
        <td><button type="button" class="btn btn-outline btn-sm" data-action="inspect-student" data-student-id="${escapeHtml(s.studentId)}">Inspect Stats</button></td>
      </tr>`;
    })
    .join("");
}

function inspectStudent(studentId) {
  const student = store.cachedStudents.find((s) => s.studentId === studentId);
  if (!student) return;
  const card = document.getElementById("teacher-inspector-card");
  card.classList.remove("hidden");
  document.getElementById("inspector-student-title").textContent = `${student.fullName} (${student.studentId}) — Performance Profile`;

  const sSubs = store.cachedSubmissions.filter((sub) => sub.studentId === studentId);
  const sMocks = store.cachedMocks.filter((m) => m.studentId === studentId);

  inspectorChartInstance = buildScoreChart("inspector-score-chart", sSubs, sMocks, inspectorChartInstance);
  renderMistakeBars("inspector-mistakes-box", student.permanentMistakes || {}, "No mistakes logged yet.");
  card.scrollIntoView({ behavior: "smooth" });
}

function populateMockStudentDropdown(students) {
  const sel = document.getElementById("mock-student-select");
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML =
    `<option value="">-- Choose Student --</option>` +
    students.map((s) => `<option value="${escapeHtml(s.studentId)}">${escapeHtml(s.studentId)} — ${escapeHtml(s.fullName)}</option>`).join("");
  if (currentVal) sel.value = currentVal;
}

function renderRecentMocksTable(students, mocks) {
  const tbody = document.getElementById("recent-mocks-tbody");
  if (!tbody) return;
  if (mocks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted center">No mock scores logged yet.</td></tr>`;
    return;
  }
  const nameMap = {};
  students.forEach((s) => {
    nameMap[s.studentId] = s.fullName;
  });
  tbody.innerHTML = mocks
    .map(
      (m) => `
    <tr>
      <td>${escapeHtml(m.date || "—")}</td>
      <td><strong>${escapeHtml(m.studentId)}</strong><br><span class="muted" style="font-size:12px;">${escapeHtml(nameMap[m.studentId] || "")}</span></td>
      <td>${escapeHtml(m.mockTitle)}</td>
      <td>${m.listening} / ${m.reading} / ${m.writing} / ${m.speaking}</td>
      <td><span class="badge badge-blue">Band ${m.overall}</span></td>
    </tr>`
    )
    .join("");
}

async function handleSaveMockScore(e) {
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

  msgEl.textContent = "";
  await withLoading(btn, "Saving...", async () => {
    const docId = `${date}_${studentId}_${Date.now()}`;
    await setDoc(doc(db, "mockScores", docId), {
      studentId,
      mockTitle,
      date,
      listening,
      reading,
      writing,
      speaking,
      overall,
      createdAt: serverTimestamp()
    });
    msgEl.style.color = "var(--success)";
    msgEl.textContent = `Saved ${mockTitle} for ${studentId} (Overall Band ${overall})!`;
    notify(`Saved Band ${overall} for ${studentId}`, "success");
    e.target.reset();
    document.getElementById("mock-date-input").value = getTodayStr();
    await loadTeacherData();
  });
}

function renderTeacherHwMatrix(students, submissions) {
  const container = document.getElementById("hw-matrix-container");
  if (!container) return;
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
    const studentCustomTasks = store.cachedTeacherHw
      .filter((t) => t.studentId === s.studentId || t.studentId === "ALL")
      .map((t) => ({ id: t.id, title: t.title || t.reason, skill: t.skill, dueDate: t.dueDate }));

    const studentAssignments = [...ASSIGNMENTS, ...studentCustomTasks];
    const issues = [];

    studentAssignments.forEach((a) => {
      const sub = submissions.find((item) => item.studentId === s.studentId && item.assignmentId === a.id);
      const dueTime = parseLocalDeadline(a.dueDate).getTime();
      const isPastDue = now.getTime() > dueTime;
      const isOverOneDayLate = now.getTime() > dueTime + oneDayMs;
      const isArchived = dueTime < cutoffMs;

      if ((!sub && isPastDue) || (sub && sub.isLate)) {
        if (!showArchivedMatrixHw && isArchived) {
          hiddenIssuesCount++;
          return;
        }
        if (!sub && isPastDue) {
          const punishBtn = isOverOneDayLate
            ? `<button type="button" class="btn btn-outline btn-sm" style="color:var(--danger);border-color:#fecaca;margin-left:auto;" data-action="quick-punish" data-student-id="${escapeHtml(s.studentId)}" data-skill="${escapeHtml(a.skill)}">⚡ Assign Punishment</button>`
            : "";
          issues.push(
            `<div style="margin-bottom:8px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;"><span class="badge badge-red">Missing</span> <span><strong>${escapeHtml(a.title)}</strong> <span class="muted" style="font-size:12px;">(Due: ${formatDueDate(a.dueDate)})</span></span>${punishBtn}</div>`
          );
        } else if (sub && sub.isLate) {
          issues.push(
            `<div style="margin-bottom:8px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;"><span class="badge badge-yellow">Late</span> <span><strong>${escapeHtml(a.title)}</strong> <span class="muted" style="font-size:12px;">(Submitted: ${sub.submittedAt?.toDate ? formatDueDate(sub.submittedAt.toDate().toISOString()) : "Late"})</span></span></div>`
          );
        }
      }
    });

    if (issues.length > 0) delinquentRecords.push({ student: s, issues });
  });

  const archiveToggleBtn =
    hiddenIssuesCount > 0 || showArchivedMatrixHw
      ? `<button type="button" class="btn btn-outline btn-sm" data-action="toggle-archived-matrix">${showArchivedMatrixHw ? "Hide Archived (14d+)" : `Show Archived (${hiddenIssuesCount} older)`}</button>`
      : "";

  if (delinquentRecords.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding: 40px 20px; border: 1px dashed var(--border); border-radius: 8px;">
        <div style="font-size:32px; margin-bottom:12px;">🎉</div>
        <h3 style="margin-bottom:8px;">All Caught Up!</h3>
        <p class="muted">Every student has submitted all recent past-due assignments on time.</p>
        ${archiveToggleBtn ? `<div style="margin-top:12px;">${archiveToggleBtn}</div>` : ""}
      </div>`;
    return;
  }

  const rows = delinquentRecords
    .map(
      (record) => `
    <div class="grade-card" style="margin-bottom:16px;">
      <div style="font-weight:600; font-size:15px; margin-bottom:12px; border-bottom:1px solid var(--border); padding-bottom:8px; color:var(--primary);">
        ${escapeHtml(record.student.fullName)} <span class="muted" style="font-size:13px; font-weight:400;">(${escapeHtml(record.student.studentId)})</span>
      </div>
      <div>${record.issues.join("")}</div>
    </div>`
    )
    .join("");

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:16px;">
      <p class="muted" style="font-size:14px; margin:0;">Showing students who have missing or late assignments from the last 14 days.</p>
      ${archiveToggleBtn}
    </div>
    ${rows}`;
}

function renderTeacherGradingQueue(students, submissions) {
  const container = document.getElementById("grading-list-container");
  if (!container) return;

  const ungradedCount = submissions.filter((s) => s.status !== "graded").length;
  document.getElementById("nav-grade-badge").textContent = ungradedCount;

  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  const isExpiredGraded = (sub) => {
    if (sub.status !== "graded") return false;
    const gradedMs = sub.gradedAt?.toMillis ? sub.gradedAt.toMillis() : typeof sub.gradedAt === "number" ? sub.gradedAt : 0;
    return gradedMs > 0 && gradedMs < cutoffMs;
  };

  const visibleSubmissions = showArchivedGraded ? [...submissions] : submissions.filter((s) => !isExpiredGraded(s));
  const hiddenCount = submissions.length - visibleSubmissions.length;

  const toggleBarHtml =
    hiddenCount > 0 || showArchivedGraded
      ? `<div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
           <button type="button" class="btn btn-outline btn-sm" data-action="toggle-archived-graded">
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
  students.forEach((s) => {
    studentNameMap[s.studentId] = s.fullName;
  });

  container.innerHTML =
    toggleBarHtml +
    visibleSubmissions
      .map((sub) => {
        const isCustom = sub.assignmentId.startsWith("CUSTOMHW_") || sub.assignmentId.startsWith("PUN_");
        const hw = isCustom ? { title: "Dynamic Task", isDrill: false } : ASSIGNMENTS.find((a) => a.id === sub.assignmentId);
        const title = isCustom ? `${sub.skill.toUpperCase()} Submission` : hw ? hw.title : sub.assignmentId;
        const sName = studentNameMap[sub.studentId] || sub.studentId;
        const noBandRequired = sub.skill === "grammar" || sub.skill === "other" || sub.isDrill || (hw && hw.isDrill);

        const statusBadge =
          sub.status === "graded"
            ? `<span class="badge badge-green">${noBandRequired ? "Checked" : `Verified: Band ${sub.bandScore}`}</span>`
            : `<span class="badge badge-yellow">Needs Review</span>`;
        const lateBadge = sub.isLate ? `<span class="badge badge-red">Late</span>` : "";

        let contentHtml = "";
        const allScreenshots = Array.isArray(sub.screenshotUrls) ? sub.screenshotUrls : sub.screenshotUrl ? [sub.screenshotUrl] : [];
        const imgHtml = allScreenshots
          .map(
            (url) =>
              `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${escapeHtml(url)}" alt="Attached Work" style="max-height:220px;border:1px solid var(--border);border-radius:8px;margin:0 8px 8px 0;display:inline-block;" /></a>`
          )
          .join("");

        const allCharts = Array.isArray(sub.chartImageUrls) ? sub.chartImageUrls : sub.chartImageUrl ? [sub.chartImageUrl] : [];
        const chartImgHtml = allCharts
          .map(
            (url) =>
              `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${escapeHtml(url)}" alt="Task 1 Chart" style="max-height:220px;border:1px solid var(--border);border-radius:8px;margin:0 8px 8px 0;display:inline-block;" /></a>`
          )
          .join("");

        if (sub.skill === "reading" || sub.skill === "listening") {
          const mistakesSummary = Object.entries(sub.mistakeCounts || {})
            .filter(([, count]) => count > 0)
            .map(([type, count]) => `<span class="q-tag">${escapeHtml(MISTAKE_LABELS[type] || type)}: ${count} wrong</span>`)
            .join(" ");
          const perSetHtml =
            Array.isArray(sub.setScores) && sub.setScores.length > 1
              ? `<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;">${sub.setScores
                  .map((sc, i) => `<span class="badge badge-blue">Test ${i + 1}: ${sc}/40 (Band ${rawToIeltsBand(sc, 40)})</span>`)
                  .join("")}</div>`
              : "";
          contentHtml = `
            <div style="margin:10px 0;">
              <p style="font-size:14px;margin-bottom:8px;"><strong>Reported Score:</strong> ${sub.rawScore} / ${sub.totalQuestions} ${sub.bandScore ? `(Avg Band ${sub.bandScore})` : `(Drill — Weakest Areas Only)`}</p>
              ${perSetHtml}
              ${mistakesSummary ? `<div style="margin-bottom:10px;">${mistakesSummary}</div>` : ""}
              <div style="display:flex;flex-wrap:wrap;">${imgHtml}</div>
            </div>`;
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
              <button type="button" class="btn btn-outline btn-sm" id="ai-wrt-btn-${escapeHtml(sub.docId)}" data-action="ai-eval-writing" data-doc-id="${escapeHtml(sub.docId)}">
                ${sub.aiEvaluation ? "🔄 Re-run AI Writing Check" : "✨ Evaluate Writing (Gemini)"}
              </button>
              <button type="button" class="btn btn-outline btn-sm" style="font-size:11px;color:var(--muted);" data-action="set-gemini-key">🔑 Set API Key</button>
            </div>
            ${savedWritingAiHtml}`;
        } else if (sub.skill === "speaking") {
          const allAudios = Array.isArray(sub.audioUrls) && sub.audioUrls.length > 0 ? sub.audioUrls : sub.audioUrl ? [sub.audioUrl] : [];
          const audioPlayersHtml = allAudios
            .map(
              (url, idx) => `
            <div style="margin-bottom:8px;">
              ${allAudios.length > 1 ? `<div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px;">Recording ${idx + 1} of ${allAudios.length}</div>` : ""}
              <audio controls src="${escapeHtml(url)}" style="width:100%;"></audio>
            </div>`
            )
            .join("");

          const savedAiHtml =
            sub.transcript || sub.aiEvaluation
              ? `<div style="margin-top:10px;background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:12px;font-size:13px;">
                   ${sub.transcript ? `<div style="margin-bottom:10px;"><strong style="color:var(--primary);">📝 Verbatim Transcript:</strong><p style="margin:4px 0 0;white-space:pre-line;line-height:1.5;">${escapeHtml(sub.transcript)}</p></div>` : ""}
                   ${sub.aiEvaluation ? `<div><strong style="color:var(--primary);">🎯 IELTS Speaking Evaluation:</strong><div style="margin-top:4px;white-space:pre-line;line-height:1.55;">${escapeHtml(sub.aiEvaluation)}</div></div>` : ""}
                 </div>`
              : "";

          contentHtml = `
            <div style="margin:12px 0;">
              ${audioPlayersHtml}
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <button type="button" class="btn btn-outline btn-sm" id="ai-spk-btn-${escapeHtml(sub.docId)}" data-action="ai-eval-speaking" data-doc-id="${escapeHtml(sub.docId)}">
                  ${sub.aiEvaluation ? "🔄 Re-run AI Transcribe & Evaluate" : "✨ Transcribe & Evaluate (Gemini)"}
                </button>
                <button type="button" class="btn btn-outline btn-sm" style="font-size:11px;color:var(--muted);" data-action="set-gemini-key">🔑 Set API Key</button>
              </div>
              ${savedAiHtml}
            </div>`;
        } else if (sub.skill === "grammar") {
          contentHtml = `
            <div style="margin:10px 0;">
              ${sub.notes ? `<p style="font-size:14px;margin-bottom:8px;"><strong>Student Note:</strong> ${escapeHtml(sub.notes)}</p>` : ""}
              <div style="display:flex;flex-wrap:wrap;">${imgHtml}</div>
            </div>`;
        } else {
          contentHtml = `
            <div style="margin:10px 0;">
              <p style="font-size:14px;white-space:pre-line;margin-bottom:8px;">${escapeHtml(sub.notes || sub.responseText || "")}</p>
              <div style="display:flex;flex-wrap:wrap;">${imgHtml}</div>
            </div>`;
        }

        const hasMultiSet = Array.isArray(sub.setScores) && sub.setScores.length > 1;
        const computedBand =
          sub.bandScore != null
            ? Number(sub.bandScore).toFixed(1)
            : (sub.skill === "reading" || sub.skill === "listening") && sub.rawScore != null && sub.totalQuestions
              ? rawToIeltsBand(sub.rawScore, sub.totalQuestions).toFixed(1)
              : "6.0";

        const bandOptions = ["4.0", "4.5", "5.0", "5.5", "6.0", "6.5", "7.0", "7.5", "8.0", "8.5", "9.0"];
        let bandSelectorHtml = "";
        if (noBandRequired) {
          bandSelectorHtml = `<div><label>Status</label><input type="text" value="Completion Check" disabled style="background:#f1f5f9;color:var(--muted);" /><input type="hidden" id="band-${escapeHtml(sub.docId)}" value="" /></div>`;
        } else if (hasMultiSet) {
          const multiDropdowns = sub.setScores
            .map((sc, i) => {
              const defaultSetBand =
                Array.isArray(sub.setBands) && sub.setBands[i] != null
                  ? Number(sub.setBands[i]).toFixed(1)
                  : rawToIeltsBand(sc, 40).toFixed(1);
              return `
              <div style="min-width:110px;">
                <label>Test ${i + 1} Band</label>
                <select class="set-band-select-${escapeHtml(sub.docId)}">${bandOptions.map((b) => `<option value="${b}" ${defaultSetBand === b ? "selected" : ""}>Band ${b}</option>`).join("")}</select>
              </div>`;
            })
            .join("");
          bandSelectorHtml = `<div style="display:flex;gap:8px;flex-wrap:wrap;">${multiDropdowns}<input type="hidden" id="band-${escapeHtml(sub.docId)}" value="${computedBand}" /></div>`;
        } else {
          bandSelectorHtml = `<div><label>Confirm / Set Band</label><select id="band-${escapeHtml(sub.docId)}">${bandOptions.map((b) => `<option value="${b}" ${computedBand === b ? "selected" : ""}>Band ${b}</option>`).join("")}</select></div>`;
        }

        return `
        <div class="grade-card">
          <div class="card-header-flex" style="margin-bottom:6px;">
            <div><span class="role-pill" style="margin-right:6px;">${escapeHtml(sub.skill.toUpperCase())}</span><strong>${escapeHtml(sName)} (${escapeHtml(sub.studentId)})</strong> — ${escapeHtml(title)}</div>
            <div style="display:flex;gap:6px;">${lateBadge}${statusBadge}</div>
          </div>
          ${contentHtml}
          <div class="grade-controls-row">
            ${bandSelectorHtml}
            <div><label>Teacher Feedback</label><input type="text" id="fb-${escapeHtml(sub.docId)}" placeholder="Leave a comment or feedback..." value="${escapeHtml(sub.teacherFeedback || "")}" /></div>
            <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">
              <button type="button" class="btn btn-primary" data-action="save-grade" data-doc-id="${escapeHtml(sub.docId)}" data-assignment-id="${escapeHtml(sub.assignmentId)}" data-no-band="${noBandRequired}">Save & Verify</button>
              <button type="button" class="btn btn-outline" style="color:var(--danger);border-color:#fecaca;" data-action="quick-punish" data-student-id="${escapeHtml(sub.studentId)}" data-skill="${escapeHtml(sub.skill)}">⚡ Assign Punishment</button>
              <button type="button" class="btn btn-outline" style="color:var(--danger);border-color:#fecaca;" data-action="delete-submission" data-doc-id="${escapeHtml(sub.docId)}" data-assignment-id="${escapeHtml(sub.assignmentId)}">🗑️ Delete</button>
            </div>
          </div>
        </div>`;
      })
      .join("");
}

async function saveTeacherGrade(docId, assignmentId, noBandRequired = false) {
  const setSelects = Array.from(document.querySelectorAll(`.set-band-select-${docId}`));
  const rawBand = document.getElementById(`band-${docId}`)?.value;
  const fbVal = document.getElementById(`fb-${docId}`)?.value.trim() || "";
  const updatePayload = { teacherFeedback: fbVal, status: "graded", gradedAt: serverTimestamp() };

  if (!noBandRequired) {
    if (setSelects.length > 0) {
      const setBands = setSelects.map((sel) => Number(sel.value));
      const avg = setBands.reduce((sum, b) => sum + b, 0) / setBands.length;
      updatePayload.setBands = setBands;
      updatePayload.bandScore = Math.round(avg * 2) / 2;
    } else if (rawBand) {
      updatePayload.bandScore = Number(rawBand);
    }
  }

  await updateDoc(doc(db, "submissions", docId), updatePayload);
  if (assignmentId && assignmentId.startsWith("PUN_")) {
    await updateDoc(doc(db, "punishments", assignmentId), { status: "verified" }).catch(() => {});
  }

  const subIdx = store.cachedSubmissions.findIndex((s) => s.docId === docId);
  if (subIdx !== -1) {
    store.cachedSubmissions[subIdx] = { ...store.cachedSubmissions[subIdx], ...updatePayload, gradedAt: Date.now() };
  }
  if (assignmentId && assignmentId.startsWith("PUN_")) {
    const punIdx = store.cachedTeacherPunishments.findIndex((p) => p.id === assignmentId);
    if (punIdx !== -1) store.cachedTeacherPunishments[punIdx].status = "verified";
    renderTeacherPunishments(store.cachedTeacherPunishments, store.cachedStudents);
  }

  notify("Verified & feedback saved!", "success");
  renderTeacherGradingQueue(store.cachedStudents, store.cachedSubmissions);
}

async function deleteSubmission(docId, assignmentId) {
  if (!confirm("Delete this student submission permanently?")) return;
  await deleteDoc(doc(db, "submissions", docId));

  if (assignmentId && assignmentId.startsWith("CUSTOMHW_")) {
    await updateDoc(doc(db, "customAssignments", assignmentId), { status: "pending" }).catch(() => {});
    const hwIdx = store.cachedTeacherHw.findIndex((h) => h.id === assignmentId);
    if (hwIdx !== -1) store.cachedTeacherHw[hwIdx].status = "pending";
    renderTeacherCustomHw(store.cachedTeacherHw, store.cachedStudents);
  } else if (assignmentId && assignmentId.startsWith("PUN_")) {
    await updateDoc(doc(db, "punishments", assignmentId), { status: "pending" }).catch(() => {});
    const punIdx = store.cachedTeacherPunishments.findIndex((p) => p.id === assignmentId);
    if (punIdx !== -1) store.cachedTeacherPunishments[punIdx].status = "pending";
    renderTeacherPunishments(store.cachedTeacherPunishments, store.cachedStudents);
  }

  store.cachedSubmissions = store.cachedSubmissions.filter((s) => s.docId !== docId);
  renderTeacherGradingQueue(store.cachedStudents, store.cachedSubmissions);
  renderTeacherHwMatrix(store.cachedStudents, store.cachedSubmissions);
  notify("Submission deleted.", "success");
}

function quickAssignPunishment(studentId, skill) {
  document.querySelector('#teacher-nav [data-target="teacher-punishments"]')?.click();
  const targetSel = document.getElementById("pun-target-select");
  if (targetSel) targetSel.value = studentId;

  const skillSel = document.getElementById("pun-skill-select");
  if (skillSel && [...skillSel.options].some((o) => o.value === skill)) {
    skillSel.value = skill;
    renderSkillConfigForm("pun-skill-select", "pun-config-container");
  }
}

function setTeacherGeminiKey() {
  const existing = localStorage.getItem("ielts_hub_gemini_key") || "";
  const input = prompt("Paste your Google AI Studio Gemini API key (saved only in this browser):", existing);
  if (input === null) return null;
  const trimmed = input.trim();
  if (trimmed) {
    localStorage.setItem("ielts_hub_gemini_key", trimmed);
    notify("Gemini API key saved to this browser!", "success");
    return trimmed;
  }
  localStorage.removeItem("ielts_hub_gemini_key");
  notify("Gemini API key cleared.", "info");
  return null;
}

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
  const idx = store.cachedStudents.findIndex((s) => s.studentId === studentId);
  if (idx !== -1) store.cachedStudents[idx].permanentMistakes = currentMistakes;
}

async function transcribeAndEvaluateSpeaking(docId) {
  const sub = store.cachedSubmissions.find((s) => s.docId === docId);
  const allAudios = Array.isArray(sub?.audioUrls) && sub.audioUrls.length > 0 ? sub.audioUrls : sub?.audioUrl ? [sub.audioUrl] : [];
  if (!sub || allAudios.length === 0) return notify("No audio recording found for this submission.", "warning");

  let apiKey = localStorage.getItem("ielts_hub_gemini_key") || setTeacherGeminiKey();
  if (!apiKey) return;

  const btn = document.getElementById(`ai-spk-btn-${docId}`);
  await withLoading(btn, "⏳ Fetching audio...", async () => {
    const audioParts = [];
    for (let i = 0; i < allAudios.length; i++) {
      const audioRes = await fetch(allAudios[i]);
      if (!audioRes.ok) throw new Error(`Could not download Recording ${i + 1}.`);
      const audioBlob = await audioRes.blob();
      const base64Audio = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(audioBlob);
      });
      if (allAudios.length > 1) audioParts.push({ text: `[Recording ${i + 1} of ${allAudios.length}]` });
      audioParts.push({ inline_data: { mime_type: audioBlob.type || "audio/webm", data: base64Audio } });
    }

    if (btn) btn.textContent = "✨ Gemini analyzing...";
    const taskObj =
      store.cachedTeacherHw.find((h) => h.id === sub.assignmentId) ||
      store.cachedTeacherPunishments.find((p) => p.id === sub.assignmentId) ||
      ASSIGNMENTS.find((a) => a.id === sub.assignmentId);
    const promptContext = taskObj?.details?.questions || taskObj?.instructions || taskObj?.title || "IELTS Speaking task";

    const systemPrompt = `You are a strict, certified IELTS Speaking examiner.
Listen carefully to the student's audio response for this prompt: "${promptContext}".
Return valid JSON with three fields:
1. "transcript": Verbatim transcription preserving filler words (um, uh, like), pauses (...), and self-corrections.
2. "evaluation": Concise structured IELTS Speaking assessment (Estimated Overall Band, Fluency & Coherence, Lexical Resource, Grammatical Range & Accuracy, Pronunciation, and 2-3 Key Corrections & Upgrades).
3. "mistakeCounts": Object counting recurring error categories using ONLY keys: S_FLUENCY_HESITATION, S_GRAMMAR_TENSE, S_LEXICAL_RANGE, S_PRONUNCIATION (0 if none).`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: systemPrompt }, ...audioParts] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
        })
      }
    );

    const geminiData = await geminiRes.json();
    if (!geminiRes.ok) throw new Error(geminiData.error?.message || `Gemini API error (${geminiRes.status})`);

    const parsed = JSON.parse(geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
    const transcript = parsed.transcript || "(No speech detected)";
    const aiEvaluation = parsed.evaluation || "";

    await updateDoc(doc(db, "submissions", docId), { transcript, aiEvaluation, aiMistakesLogged: true });
    if (!sub.aiMistakesLogged && parsed.mistakeCounts) {
      await logAiMistakesToStudent(sub.studentId, parsed.mistakeCounts);
    }

    const subIdx = store.cachedSubmissions.findIndex((s) => s.docId === docId);
    if (subIdx !== -1) {
      store.cachedSubmissions[subIdx].transcript = transcript;
      store.cachedSubmissions[subIdx].aiEvaluation = aiEvaluation;
      store.cachedSubmissions[subIdx].aiMistakesLogged = true;
    }

    notify("Speaking evaluated & weak spots logged!", "success");
    renderTeacherGradingQueue(store.cachedStudents, store.cachedSubmissions);
  });
}

async function evaluateWritingSubmission(docId) {
  const sub = store.cachedSubmissions.find((s) => s.docId === docId);
  if (!sub || !sub.essayText) return notify("No essay text found for this submission.", "warning");

  let apiKey = localStorage.getItem("ielts_hub_gemini_key") || setTeacherGeminiKey();
  if (!apiKey) return;

  const btn = document.getElementById(`ai-wrt-btn-${docId}`);
  await withLoading(btn, "✨ Gemini grading essay...", async () => {
    const taskObj =
      store.cachedTeacherHw.find((h) => h.id === sub.assignmentId) ||
      store.cachedTeacherPunishments.find((p) => p.id === sub.assignmentId) ||
      ASSIGNMENTS.find((a) => a.id === sub.assignmentId);
    const promptText = taskObj?.details?.promptText || taskObj?.promptText || taskObj?.title || "IELTS Writing Task";

    const systemPrompt = `You are a strict, certified IELTS Writing examiner.
Grade the student's response to this prompt: "${promptText}".
Word count: ${sub.essayText.trim().split(/\s+/).filter(Boolean).length} words.
Return valid JSON with three fields:
1. "estimatedBand": String band score like "6.0", "6.5", or "7.0".
2. "evaluation": Structured IELTS Writing assessment (Estimated Overall Band, Task Achievement/Response, Coherence & Cohesion, Lexical Resource, Grammatical Range & Accuracy, and 3 Key Sentence Corrections & Band 8+ Upgrades).
3. "mistakeCounts": Object counting recurring error categories using ONLY keys: W_ARTICLES, W_TENSE, W_SVA, W_PREPOSITIONS, W_WORD_CHOICE, W_SENTENCE_STRUCTURE, W_TASK_RESPONSE (0 if none).`;

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

    await updateDoc(doc(db, "submissions", docId), { aiEvaluation, aiMistakesLogged: true });
    if (!sub.aiMistakesLogged && parsed.mistakeCounts) {
      await logAiMistakesToStudent(sub.studentId, parsed.mistakeCounts);
    }

    const subIdx = store.cachedSubmissions.findIndex((s) => s.docId === docId);
    if (subIdx !== -1) {
      store.cachedSubmissions[subIdx].aiEvaluation = aiEvaluation;
      store.cachedSubmissions[subIdx].aiMistakesLogged = true;
    }

    notify("Writing evaluated & weak spots logged!", "success");
    renderTeacherGradingQueue(store.cachedStudents, store.cachedSubmissions);

    const bandSelect = document.getElementById(`band-${docId}`);
    if (bandSelect && estimatedBand && [...bandSelect.options].some((o) => o.value === estimatedBand)) {
      bandSelect.value = estimatedBand;
    }
  });
}

async function renderTeacherAttendanceManager() {
  const canvas = document.getElementById("teacher-qr-canvas");
  const dateLabel = document.getElementById("qr-date-label");
  if (!canvas) return;

  const today = getTodayStr();
  if (dateLabel) dateLabel.textContent = `Lesson Date: ${today}`;

  const checkinUrl = `${window.location.origin}${window.location.pathname}?checkin=${today}`;
  if (typeof QRCode !== "undefined") {
    QRCode.toCanvas(canvas, checkinUrl, { width: 200, margin: 2, color: { dark: "#0f172a", light: "#ffffff" } }, (e) => {
      if (e) console.error(e);
    });
  }

  const attSnap = await getDocs(query(collection(db, "attendance"), where("date", "==", today)));
  const attendedMap = {};
  attSnap.forEach((d) => {
    attendedMap[d.data().studentId] = d.data();
  });

  const tbody = document.getElementById("teacher-attendance-tbody");
  if (!tbody) return;
  if (store.cachedStudents.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted center">No students in roster.</td></tr>`;
    return;
  }

  tbody.innerHTML = store.cachedStudents
    .map((s) => {
      const record = attendedMap[s.studentId];
      const status = record?.status || "Absent";
      const timeStr = record?.checkedInAt?.toDate
        ? record.checkedInAt.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "—";
      const badgeClass = status === "Present" ? "badge-green" : status === "Late" ? "badge-yellow" : "badge-red";
      return `
      <tr>
        <td><strong>${escapeHtml(s.studentId)}</strong></td>
        <td>${escapeHtml(s.fullName)}</td>
        <td><span class="badge ${badgeClass}">${status}</span></td>
        <td>${timeStr}</td>
      </tr>`;
    })
    .join("");
}
