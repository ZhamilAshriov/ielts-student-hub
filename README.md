# ielts-student-hub
IELTS Hub — Student & Teacher Learning Management System

A static, modular web application built for managing IELTS preparation cohorts. Designed for zero-build deployment on GitHub Pages, powered by Firebase Authentication, Cloud Firestore (with multi-tab offline IndexedDB persistence), Cloudinary media hosting, and Google Gemini AI automated Speaking & Writing evaluation.

Key Features

Teacher Admin Dashboard

Student Roster & Account Provisioning: Create student accounts (ST-XXX) via a secondary Firebase Auth instance without interrupting the active admin session, and inspect individual student score trajectories and recurring mistake profiles.

Dynamic Homework & Remedial Dispatchers: Broadcast or assign custom tasks across Listening, Reading, Writing (Task 1 & Task 2), Speaking, Grammar, and general drills with deadlines and reference image attachments.

Multi-Set Grading & AI Evaluators:

Grade single or multi-set Listening/Reading tests (e.g., 2x sets = 80 questions) with individual per-set band selectors.

Run Gemini AI (gemini-3.8-flash) on Writing essays and multi-clip Speaking recordings to generate verbatim transcripts, band estimates, corrections, and automatic weak-spot logging (W_* and S_* tags).

Mock Exam Score Tracker: Log official 4-skill mock exam results with automatic IELTS overall band rounding (0.5 increments).

Announcements & Reactions: Publish pinned or tagged announcements (GENERAL, URGENT, MOCK EXAM, NEW MATERIAL) with real-time emoji reactions (👍, ❤️, 🔥, 🎉, 👏, 😢, 😡) and student hover tooltips.

QR Code Class Attendance: Generates a daily lesson QR code (?checkin=YYYY-MM-DD) for Tue/Thu/Sat schedules with a 15-minute grace period before marking check-ins as Late.

Student Portal

Anki-Style Spaced Repetition (SM-2): Interactive vocabulary decks with British English Web Speech pronunciation, keyboard shortcuts (Space to flip, 1–4 to rate, R to replay audio), Bonus Practice Mode, and daily streak tracking.

Unified Homework & Remedial Runner: Submit Listening/Reading scores with question-type mistake breakdowns, upload workbook photos, write essays, or record up to 5 Speaking audio clips directly in the browser.

Progress & Group Analytics: Interactive Chart.js score trajectory across mock exams and 40-question practice tests, class comparison bar charts, personal vs. class-wide weak-spot breakdown bars, and a study streak leaderboard.

Unread Announcement Pop-ups: Automatically notifies students upon login when new announcements are published.

Project Architecture

The application uses native ES Modules (<script type="module">) with no Node/Vite bundler required:

├── index.html              # Single-page shell & role-based navigation views
├── style.css               # Responsive layout, cards, badges, and UI styling
├── sw.js                   # Service worker for offline asset caching
├── app.js                  # Entry point, auth state listener, login/password & view router
├── firebase.js             # Firebase app init, Firestore persistent cache & Cloudinary constants
├── store.js                # Centralized application state & custom-claim / profile role resolver
├── utils.js                # Toast notifications, button loading states, local date & file validators
├── submissions.js          # Cloudinary uploaders, atomic Firestore transactions & blob URL cleanup
├── anki.js                 # SM-2 spaced repetition algorithm, pronunciation & streak persistence
├── recorder.js             # Multi-clip MediaRecorder controller with memory leak protection
├── charts.js               # IELTS band conversion & Chart.js trajectory / comparison builders
├── announcements.js        # Announcement sorting, emoji reactions & unread login modal
├── teacher.js              # Admin roster, dispatchers, grading queue, Gemini AI & QR attendance
├── student.js              # Student dashboard, homework/punishment runners, receipts & stats
├── vocab-data.js           # Static vocabulary flashcard decks
├── assignments-data.js     # Static baseline curriculum assignments
└── resources-data.js       # Curated IELTS study guides & embedded video resources


Setup & Deployment

Firebase Project Configuration:

Enable Email/Password authentication in Firebase Console.

Create a Firestore database and deploy Security Rules enforcing teacher vs. student write permissions.

Ensure the teacher admin account (teacher@zhamil-hub.local) exists in Firebase Auth.

Cloudinary Unsigned Upload Preset:

Configure an unsigned upload preset (ielts_speaking) in your Cloudinary dashboard to accept student image and .webm audio uploads.

Gemini AI Key (Teacher Browser):

Sign in as Teacher Admin, navigate to the Grading Queue, and click 🔑 Set API Key on any Writing or Speaking submission to store your Google AI Studio key in localStorage.

Deploy to GitHub Pages:

Push all files to your GitHub Pages repository (main branch).

Whenever updating JS modules, increment the cache version in sw.js so returning browsers fetch the latest scripts immediately.
