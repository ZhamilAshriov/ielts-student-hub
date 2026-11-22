import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase.js";
import { store } from "./store.js";
import { escapeHtml, getTodayStr } from "./utils.js";
import { VOCAB_DECKS } from "./vocab-data.js";

let ankiQueue = [];
let currentCard = null;
let isCardFlipped = false;
let bonusMode = false;
let selectedDeckId = "all";
let onDashboardSyncCallback = null;

export function initAnkiEngine({ onDashboardSync } = {}) {
  onDashboardSyncCallback = onDashboardSync || null;

  document.getElementById("anki-deck-select")?.addEventListener("change", (e) => {
    selectedDeckId = e.target.value;
    bonusMode = false;
    buildAnkiQueue();
  });

  document.getElementById("speak-word-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (currentCard) speakEnglishText(currentCard.word, true);
  });

  document.getElementById("speak-example-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (currentCard) speakEnglishText(currentCard.example, false);
  });

  document.getElementById("flashcard")?.addEventListener("click", flipFlashcard);
  document.getElementById("show-answer-btn")?.addEventListener("click", flipFlashcard);

  document.querySelectorAll(".rate-btn").forEach((btn) => {
    btn.addEventListener("click", () => gradeCurrentCard(Number(btn.dataset.quality)));
  });

  document.getElementById("practice-all-btn")?.addEventListener("click", () => {
    bonusMode = true;
    buildAnkiQueue();
  });

  document.addEventListener("keydown", (e) => {
    const ankiSection = document.getElementById("student-anki");
    if (!ankiSection || ankiSection.classList.contains("hidden") || !currentCard) return;

    if (e.code === "Space") {
      e.preventDefault();
      flipFlashcard();
    } else if (e.key.toLowerCase() === "r") {
      e.preventDefault();
      speakEnglishText(currentCard.word, true);
    } else if (isCardFlipped && ["1", "2", "3", "4"].includes(e.key)) {
      gradeCurrentCard(Number(e.key));
    }
  });
}

export function resetAnkiSession() {
  bonusMode = false;
  selectedDeckId = "all";
  buildAnkiQueue();
}

export function getAllDueCountAcrossAllDecks() {
  const today = getTodayStr();
  let totalDue = 0;
  VOCAB_DECKS.forEach((deck) => {
    deck.cards.forEach((card) => {
      if (!store.ankiProgressMap[card.id] || store.ankiProgressMap[card.id].nextReviewDate <= today) {
        totalDue++;
      }
    });
  });
  return totalDue;
}

function getFilteredVocabCards() {
  const all = [];
  VOCAB_DECKS.forEach((deck) => {
    if (selectedDeckId === "all" || deck.deckId === selectedDeckId) {
      deck.cards.forEach((c) => all.push({ ...c, deckId: deck.deckId, deckTitle: deck.title }));
    }
  });
  return all;
}

export function populateAnkiDeckDropdown() {
  const sel = document.getElementById("anki-deck-select");
  if (!sel) return;
  const today = getTodayStr();
  const optionsHtml = [
    `<option value="all" ${selectedDeckId === "all" ? "selected" : ""}>All Decks (${getAllDueCountAcrossAllDecks()} due)</option>`
  ];
  VOCAB_DECKS.forEach((deck) => {
    const deckDue = deck.cards.filter(
      (c) => !store.ankiProgressMap[c.id] || store.ankiProgressMap[c.id].nextReviewDate <= today
    ).length;
    optionsHtml.push(
      `<option value="${escapeHtml(deck.deckId)}" ${selectedDeckId === deck.deckId ? "selected" : ""}>${escapeHtml(deck.title)} (${deckDue} due)</option>`
    );
  });
  sel.innerHTML = optionsHtml.join("");
}

function speakEnglishText(rawText, isWord = true) {
  if (!("speechSynthesis" in window) || !rawText) return;
  window.speechSynthesis.cancel();
  let clean = rawText;
  if (isWord) {
    clean = clean.replace(/\((adj|adv|n|v|phr|prep)\.\)/gi, "").replace(/\s*\/\s*/g, ", ").trim();
  }
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = "en-GB";
  utterance.rate = isWord ? 0.92 : 0.96;
  window.speechSynthesis.speak(utterance);
}

export function buildAnkiQueue() {
  populateAnkiDeckDropdown();
  const filteredCards = getFilteredVocabCards();
  const today = getTodayStr();
  ankiQueue = bonusMode
    ? [...filteredCards]
    : filteredCards.filter((card) => !store.ankiProgressMap[card.id] || store.ankiProgressMap[card.id].nextReviewDate <= today);
  renderNextAnkiCard();
}

export function calcSM2(prev, quality) {
  let repetitions = prev.repetitions || 0;
  let interval = prev.interval || 0;
  let easeFactor = prev.easeFactor || 2.5;

  if (quality === 1) {
    repetitions = 0;
    interval = 0;
  } else if (quality === 2) {
    repetitions = Math.max(1, repetitions);
    interval = 1;
    easeFactor = Math.max(1.3, easeFactor - 0.15);
  } else if (quality === 3) {
    if (repetitions === 0) interval = 1;
    else if (repetitions === 1) interval = 6;
    else interval = Math.round(interval * easeFactor);
    repetitions += 1;
  } else if (quality === 4) {
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

function renderNextAnkiCard() {
  const stage = document.getElementById("anki-stage");
  const doneState = document.getElementById("anki-done-state");
  const subtitle = document.getElementById("anki-deck-subtitle");
  if (!stage || !doneState) return;

  let newCnt = 0;
  let revCnt = 0;
  ankiQueue.forEach((c) => (!store.ankiProgressMap[c.id] ? newCnt++ : revCnt++));
  document.getElementById("anki-new-count").textContent = newCnt;
  document.getElementById("anki-review-count").textContent = revCnt;

  if (ankiQueue.length === 0) {
    stage.classList.add("hidden");
    doneState.classList.remove("hidden");
    subtitle.textContent = "Daily goal complete!";
    bonusMode = false;
    if (onDashboardSyncCallback) onDashboardSyncCallback();
    return;
  }

  stage.classList.remove("hidden");
  doneState.classList.add("hidden");
  subtitle.textContent = bonusMode ? "Bonus Practice Mode" : `${ankiQueue.length} card(s) remaining in this session`;

  currentCard = ankiQueue[0];
  isCardFlipped = false;

  document.getElementById("card-lesson-tag").textContent = currentCard.deckTitle;
  document.getElementById("card-word").textContent = currentCard.word;
  document.getElementById("card-definition").textContent = currentCard.definition;
  document.getElementById("card-example").textContent = `"${currentCard.example}"`;

  document.getElementById("card-back").classList.add("hidden");
  document.getElementById("anki-reveal-bar").classList.remove("hidden");
  document.getElementById("anki-rate-bar").classList.add("hidden");

  const prev = store.ankiProgressMap[currentCard.id] || { repetitions: 0, interval: 0, easeFactor: 2.5 };
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

async function gradeCurrentCard(quality) {
  if (!currentCard) return;
  const card = ankiQueue.shift();

  if (quality === 1) {
    const insertIdx = Math.min(2, ankiQueue.length);
    ankiQueue.splice(insertIdx, 0, card);
  }

  if (!bonusMode) {
    const prev = store.ankiProgressMap[card.id] || { repetitions: 0, interval: 0, easeFactor: 2.5 };
    const updated = calcSM2(prev, quality);
    store.ankiProgressMap[card.id] = { studentId: store.currentStudentId, cardId: card.id, ...updated };

    await setDoc(doc(db, "ankiProgress", `${store.currentStudentId}_${card.id}`), store.ankiProgressMap[card.id]);
  }

  const today = getTodayStr();
  const yesterday = getTodayStr(-1);
  const stats = store.currentStudentProfile.ankiStats || {
    streak: 0,
    lastReviewedDate: null,
    todayCount: 0,
    totalReviewed: 0
  };

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
  store.currentStudentProfile.ankiStats = updatedStats;

  await setDoc(
    doc(db, "users", store.currentStudentId),
    {
      studentId: store.currentStudentId,
      fullName: store.currentStudentProfile.fullName || store.currentStudentId,
      role: "student",
      ankiStats: updatedStats
    },
    { merge: true }
  );

  populateAnkiDeckDropdown();
  if (onDashboardSyncCallback) onDashboardSyncCallback();
  renderNextAnkiCard();
}
