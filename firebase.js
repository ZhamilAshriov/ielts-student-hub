import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

export const firebaseConfig = {
  apiKey: "AIzaSyDrGjx51H42h6Pkg44RIpZo0vyZApz8SGA",
  authDomain: "zhamil-ielts-hub.firebaseapp.com",
  projectId: "zhamil-ielts-hub",
  storageBucket: "zhamil-ielts-hub.firebasestorage.app",
  messagingSenderId: "101411624698",
  appId: "1:101411624698:web:862eba707513e098c65b43"
};

export const CLOUDINARY_CLOUD_NAME = "b9izjowd";
export const CLOUDINARY_UPLOAD_PRESET = "ielts_speaking";
export const LOGIN_DOMAIN = "@zhamil-hub.local";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// Secondary app for teacher account creation without logging out admin
export const secondaryApp = initializeApp(firebaseConfig, `SecondaryCreator_${Date.now()}`);
export const secondaryAuth = getAuth(secondaryApp);
