// ─────────────────────────────────────────────
// firebase.js — Firebase SDK initialisation
// All Firebase services are exported from here.
// ─────────────────────────────────────────────

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.1/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  getDocs,
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  deleteDoc,
  updateDoc,
  serverTimestamp,
  orderBy,
  limit,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.1/firebase-firestore.js";
import {
  getDatabase,
  ref,
  set,
  get,
  remove,
  onValue,
  off,
  onDisconnect,
  serverTimestamp as rtdbTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.1/firebase-database.js";

// ── Config ────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyCTTJWfGNmA73ifwfhUpHR8xXxoZrTdmLs",
  authDomain: "chatting-2d60f.firebaseapp.com",
  databaseURL:
    "https://chatting-2d60f-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "chatting-2d60f",
  storageBucket: "chatting-2d60f.firebasestorage.app",
  messagingSenderId: "823509247651",
  appId: "1:823509247651:web:0f4965e63b693286870116",
};

// ── Initialise ────────────────────────────────
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const rtdb = getDatabase(app);

// ── Re-export helpers so script.js stays clean ─
export {
  auth,
  db,
  rtdb,
  // Auth
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  // Firestore
  doc,
  setDoc,
  getDoc,
  getDocs,
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  deleteDoc,
  updateDoc,
  serverTimestamp,
  orderBy,
  limit,
  Timestamp,
  // RTDB
  ref,
  set,
  get,
  remove,
  onValue,
  off,
  onDisconnect,
  rtdbTimestamp,
};
