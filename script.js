// ═══════════════════════════════════════════════════════
// script.js — Nexus Chat · Production v2
// Fixes: PWA once-only, delete, 24h auto-delete,
//        branding, rotating header text, footer,
//        no duplicate listeners, clean re-renders
// ═══════════════════════════════════════════════════════

import {
  auth, db, rtdb,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  doc, setDoc, getDoc,
  collection, query, orderBy,
  onSnapshot, addDoc, deleteDoc,
  serverTimestamp, Timestamp,
  ref, set, onValue, onDisconnect, rtdbTimestamp,
} from "./firebase.js";

// ══════════════════════════════════════════════════════
// STATE — single source of truth
// ══════════════════════════════════════════════════════
const state = {
  currentUser:     null,   // Firebase Auth user
  currentUserData: null,   // Firestore profile {name, email}
  selectedUser:    null,   // The user we're chatting with
  chatId:          null,
  messageListener: null,   // Unsubscribe fn — messages
  userListener:    null,   // Unsubscribe fn — users list
  callTimer:       null,
  callSeconds:     0,
  rotatorInterval: null,   // Header text rotator
};

// ══════════════════════════════════════════════════════
// DOM REFERENCES
// ══════════════════════════════════════════════════════
const $ = id => document.getElementById(id);

const DOM = {
  // Screens
  intro:    $("intro-screen"),
  auth:     $("auth-screen"),
  app:      $("app-screen"),

  // Auth
  tabLogin:    $("tab-login"),
  tabSignup:   $("tab-signup"),
  formLogin:   $("form-login"),
  formSignup:  $("form-signup"),
  loginEmail:  $("login-email"),
  loginPass:   $("login-pass"),
  loginBtn:    $("login-btn"),
  loginError:  $("login-error"),
  signupName:  $("signup-name"),
  signupEmail: $("signup-email"),
  signupPass:  $("signup-pass"),
  signupBtn:   $("signup-btn"),
  signupError: $("signup-error"),

  // Sidebar
  searchInput: $("search-input"),
  userList:    $("user-list"),
  selfName:    $("self-name"),
  selfStatus:  $("self-status"),
  selfAvatar:  $("self-avatar"),
  logoutBtn:   $("logout-btn"),
  headerRotator: $("header-rotator"),   // rotating subtitle text

  // Chat
  chatEmpty:          $("chat-empty"),
  chatView:           $("chat-view"),
  chatHeaderAvatar:   $("chat-header-avatar"),
  chatHeaderName:     $("chat-header-name"),
  chatHeaderStatus:   $("chat-header-status"),
  messagesContainer:  $("messages-container"),
  msgInput:           $("msg-input"),
  sendBtn:            $("send-btn"),
  typingIndicator:    $("typing-indicator"),
  voiceCallBtn:       $("voice-call-btn"),
  videoCallBtn:       $("video-call-btn"),

  // Mobile
  sidebar:       $("sidebar"),
  chatArea:      $("chat-area"),
  mobileBackBtn: $("mobile-back-btn"),

  // PWA
  pwaBanner:     $("pwa-banner"),
  pwaInstallBtn: $("pwa-install-btn"),
  pwaCloseBtn:   $("pwa-close-btn"),

  // Call overlay
  callOverlay:  $("call-overlay"),
  voiceCallUi:  $("voice-call-ui"),
  videoCallUi:  $("video-call-ui"),
  callAvatar:   $("call-avatar"),
  callName:     $("call-name"),
  callStatus:   $("call-status"),
  callTimer:    $("call-timer"),
  endCallBtn:   $("end-call-btn"),
  endCallBtnV:  $("end-call-btn-v"),

  // Footer
  toastContainer: $("toast-container"),
};

// ══════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════

function toast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  DOM.toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function initials(name = "") {
  return name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2) || "?";
}

function formatTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatTimer(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function getChatId(uid1, uid2) {
  return [uid1, uid2].sort().join("_");
}

// XSS prevention
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function showScreen(name) {
  DOM.auth.style.display = "none";
  DOM.app.style.display  = "none";
  if (name === "auth") {
    DOM.auth.style.display = "flex";
    DOM.auth.classList.add("screen-fade-in");
  } else if (name === "app") {
    DOM.app.style.display = "flex";
    DOM.app.classList.add("screen-fade-in");
  }
}

// ══════════════════════════════════════════════════════
// TASK 2 — ROTATING HEADER SUBTITLE
// Smooth fade transition, no layout shift
// ══════════════════════════════════════════════════════

const ROTATOR_TEXTS = [
  "Student Web Developer",
  "Building Real-Time Apps",
  "Future God of Multiverse",
  "Focused on Clean UI/UX",
  "Turning Ideas into Products",
];
let rotatorIndex = 0;

function startHeaderRotator() {
  if (!DOM.headerRotator) return;
  // Clear any existing interval (no duplicate)
  if (state.rotatorInterval) clearInterval(state.rotatorInterval);

  DOM.headerRotator.textContent = ROTATOR_TEXTS[0];
  DOM.headerRotator.classList.add("rotator-visible");

  state.rotatorInterval = setInterval(() => {
    // Fade out
    DOM.headerRotator.classList.remove("rotator-visible");
    setTimeout(() => {
      rotatorIndex = (rotatorIndex + 1) % ROTATOR_TEXTS.length;
      DOM.headerRotator.textContent = ROTATOR_TEXTS[rotatorIndex];
      // Fade in
      DOM.headerRotator.classList.add("rotator-visible");
    }, 350); // matches CSS transition
  }, 3000);
}

// ══════════════════════════════════════════════════════
// AUTH — Tab switching (no duplicate listeners with
//        once-bound handlers)
// ══════════════════════════════════════════════════════

DOM.tabLogin.addEventListener("click", () => {
  DOM.tabLogin.classList.add("active");
  DOM.tabSignup.classList.remove("active");
  DOM.formLogin.classList.remove("hidden");
  DOM.formSignup.classList.add("hidden");
  DOM.loginError.classList.remove("visible");
});

DOM.tabSignup.addEventListener("click", () => {
  DOM.tabSignup.classList.add("active");
  DOM.tabLogin.classList.remove("active");
  DOM.formSignup.classList.remove("hidden");
  DOM.formLogin.classList.add("hidden");
  DOM.signupError.classList.remove("visible");
});

// Login
DOM.loginBtn.addEventListener("click", async () => {
  const email = DOM.loginEmail.value.trim();
  const pass  = DOM.loginPass.value;
  if (!email || !pass) return showAuthError(DOM.loginError, "Please fill in all fields.");
  DOM.loginBtn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    // onAuthStateChanged handles transition
  } catch (e) {
    showAuthError(DOM.loginError, friendlyAuthError(e.code));
    DOM.loginBtn.disabled = false;
  }
});

// Signup
DOM.signupBtn.addEventListener("click", async () => {
  const name  = DOM.signupName.value.trim();
  const email = DOM.signupEmail.value.trim();
  const pass  = DOM.signupPass.value;
  if (!name || !email || !pass) return showAuthError(DOM.signupError, "Please fill in all fields.");
  if (pass.length < 6) return showAuthError(DOM.signupError, "Password must be at least 6 characters.");
  DOM.signupBtn.disabled = true;
  try {
    const { user } = await createUserWithEmailAndPassword(auth, email, pass);
    // Correct Firestore structure: users/{uid}
    await setDoc(doc(db, "users", user.uid), {
      name,
      email,
      uid: user.uid,
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    showAuthError(DOM.signupError, friendlyAuthError(e.code));
    DOM.signupBtn.disabled = false;
  }
});

function showAuthError(el, msg) {
  el.textContent = msg;
  el.classList.add("visible");
  setTimeout(() => el.classList.remove("visible"), 4000);
}

function friendlyAuthError(code) {
  const map = {
    "auth/user-not-found":       "No account found with that email.",
    "auth/wrong-password":       "Incorrect password.",
    "auth/invalid-credential":   "Incorrect email or password.",
    "auth/email-already-in-use": "Email already registered.",
    "auth/weak-password":        "Password is too weak.",
    "auth/invalid-email":        "Invalid email address.",
    "auth/too-many-requests":    "Too many attempts. Try again later.",
  };
  return map[code] || "Something went wrong. Please try again.";
}

// Enter key support
[DOM.loginPass, DOM.loginEmail].forEach(el =>
  el.addEventListener("keydown", e => e.key === "Enter" && DOM.loginBtn.click())
);
[DOM.signupPass, DOM.signupEmail, DOM.signupName].forEach(el =>
  el.addEventListener("keydown", e => e.key === "Enter" && DOM.signupBtn.click())
);

// ══════════════════════════════════════════════════════
// AUTH STATE OBSERVER
// ══════════════════════════════════════════════════════

onAuthStateChanged(auth, async (user) => {
  if (user) {
    state.currentUser = user;

    // Load Firestore profile
    const snap = await getDoc(doc(db, "users", user.uid));
    state.currentUserData = snap.exists()
      ? snap.data()
      : { name: user.email, email: user.email, uid: user.uid };

    // Set online presence + auto-offline on disconnect
    const presenceRef = ref(rtdb, `presence/${user.uid}`);
    await set(presenceRef, { online: true, lastSeen: rtdbTimestamp() });
    onDisconnect(presenceRef).set({ online: false, lastSeen: rtdbTimestamp() });

    initApp();
    showScreen("app");
  } else {
    // Full cleanup on logout
    if (state.messageListener) { state.messageListener(); state.messageListener = null; }
    if (state.userListener)    { state.userListener();    state.userListener    = null; }
    if (state.rotatorInterval) { clearInterval(state.rotatorInterval); state.rotatorInterval = null; }

    state.currentUser     = null;
    state.currentUserData = null;
    state.selectedUser    = null;
    state.chatId          = null;

    DOM.loginBtn.disabled  = false;
    DOM.signupBtn.disabled = false;
    showScreen("auth");
  }
});

// ══════════════════════════════════════════════════════
// APP INIT
// ══════════════════════════════════════════════════════

function initApp() {
  const u = state.currentUserData;

  // Sidebar footer
  DOM.selfAvatar.textContent = initials(u.name);
  DOM.selfName.textContent   = u.name;
  DOM.selfStatus.textContent = "● Online";
  DOM.selfStatus.classList.add("online-text");

  // Reset chat to empty state
  DOM.chatEmpty.style.display = "flex";
  DOM.chatView.classList.remove("active");
  DOM.messagesContainer.innerHTML = "";

  // Start rotating subtitle
  startHeaderRotator();

  // Start user list listener
  listenToUsers();
}

// Logout
DOM.logoutBtn.addEventListener("click", async () => {
  if (state.currentUser) {
    await set(ref(rtdb, `presence/${state.currentUser.uid}`), {
      online: false, lastSeen: rtdbTimestamp(),
    });
  }
  await signOut(auth);
});

// ══════════════════════════════════════════════════════
// USER LIST — onSnapshot (real-time, not getDocs)
// ══════════════════════════════════════════════════════

function listenToUsers() {
  // Unsubscribe any previous listener first (prevent duplicates)
  if (state.userListener) { state.userListener(); state.userListener = null; }

  // Skeleton placeholders while loading
  DOM.userList.innerHTML = `
    <div class="skeleton user-skeleton"></div>
    <div class="skeleton user-skeleton"></div>
    <div class="skeleton user-skeleton"></div>`;

  const q = collection(db, "users");
  state.userListener = onSnapshot(q, (snapshot) => {
    const users = [];
    snapshot.forEach(d => {
      if (d.id !== state.currentUser.uid) {
        users.push({ uid: d.id, ...d.data() });
      }
    });
    renderUserList(users);
  });
}

// Presence cache — uid → boolean
const presenceCache = {};

function renderUserList(users) {
  // Full reset before re-render (prevents duplicate rows)
  DOM.userList.innerHTML = "";

  if (!users.length) {
    DOM.userList.innerHTML = `<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:24px 12px;">No other users yet</p>`;
    return;
  }

  users.forEach(u => {
    const item = document.createElement("div");
    item.className = "user-item";
    item.dataset.uid = u.uid;
    if (state.selectedUser?.uid === u.uid) item.classList.add("active");

    item.innerHTML = `
      <div class="avatar" id="av-${u.uid}">
        ${initials(u.name)}
        <span class="status-dot" id="dot-${u.uid}"></span>
      </div>
      <div class="user-info">
        <div class="user-name">${escapeHtml(u.name)}</div>
        <div class="user-status" id="status-text-${u.uid}">Offline</div>
      </div>
    `;

    // RTDB presence listener per user
    const presRef = ref(rtdb, `presence/${u.uid}`);
    onValue(presRef, snap => {
      const online = snap.val()?.online === true;
      presenceCache[u.uid] = online;

      const dot  = document.getElementById(`dot-${u.uid}`);
      const text = document.getElementById(`status-text-${u.uid}`);
      if (dot)  dot.className = `status-dot${online ? " online" : ""}`;
      if (text) {
        text.textContent = online ? "Online" : "Offline";
        text.className   = `user-status${online ? " online-text" : ""}`;
      }
    });

    item.addEventListener("click", () => selectUser(u));
    DOM.userList.appendChild(item);
  });

  filterUsers(DOM.searchInput.value);
}

// Search filter — no listener duplication (bound once at bottom)
function filterUsers(q) {
  const lower = q.toLowerCase();
  document.querySelectorAll(".user-item").forEach(el => {
    const name = el.querySelector(".user-name")?.textContent.toLowerCase() || "";
    el.style.display = name.includes(lower) ? "" : "none";
  });
}
DOM.searchInput.addEventListener("input", e => filterUsers(e.target.value));

// ══════════════════════════════════════════════════════
// SELECT USER → OPEN CHAT
// ══════════════════════════════════════════════════════

function selectUser(u) {
  state.selectedUser = u;
  state.chatId       = getChatId(state.currentUser.uid, u.uid);

  // Update active state in sidebar
  document.querySelectorAll(".user-item").forEach(el => el.classList.remove("active"));
  const item = document.querySelector(`.user-item[data-uid="${u.uid}"]`);
  if (item) item.classList.add("active");

  // Update chat header
  DOM.chatHeaderAvatar.textContent = initials(u.name);
  DOM.chatHeaderName.textContent   = u.name;
  const online = presenceCache[u.uid] === true;
  DOM.chatHeaderStatus.textContent = online ? "Online" : "Offline";
  DOM.chatHeaderStatus.className   = `user-status${online ? " online-text" : ""}`;

  // Show chat view, clear old messages
  DOM.chatEmpty.style.display = "none";
  DOM.chatView.classList.add("active");
  DOM.messagesContainer.innerHTML = ""; // clean reset — no ghost messages

  // Unsubscribe old listener before attaching new (prevents duplicates)
  if (state.messageListener) { state.messageListener(); state.messageListener = null; }
  listenToMessages();

  // Mobile: slide chat into view
  openChatOnMobile();

  setTimeout(() => DOM.msgInput.focus(), 300);
}

// ══════════════════════════════════════════════════════
// TASK 4 — 24-HOUR AUTO DELETE (Frontend layer)
// Messages older than 24h are removed from Firestore
// on render. Backend Cloud Function is the scalable
// complement (see cloud-functions/ folder).
// ══════════════════════════════════════════════════════

const MS_24H = 24 * 60 * 60 * 1000;

function isExpired(ts) {
  if (!ts) return false;
  const created = ts.toDate ? ts.toDate() : new Date(ts);
  return Date.now() - created.getTime() > MS_24H;
}

async function deleteExpiredMessage(msgDocId) {
  try {
    await deleteDoc(doc(db, "chats", state.chatId, "messages", msgDocId));
  } catch (_) {
    // Silent — may already be deleted by backend function
  }
}

// ══════════════════════════════════════════════════════
// MESSAGES — Real-time with onSnapshot
// Handles: added, removed (for delete), expired check
// ══════════════════════════════════════════════════════

function listenToMessages() {
  const msgsRef = collection(db, "chats", state.chatId, "messages");
  const q       = query(msgsRef, orderBy("createdAt", "asc"));

  let lastDate = null;

  state.messageListener = onSnapshot(q, snap => {
    snap.docChanges().forEach(change => {

      // ── New message added ──
      if (change.type === "added") {
        const data  = { id: change.doc.id, ...change.doc.data() };

        // Task 4: skip & delete expired messages immediately
        if (isExpired(data.createdAt)) {
          deleteExpiredMessage(data.id);
          return;
        }

        // Date separator logic
        const msgDate = data.createdAt
          ? data.createdAt.toDate().toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })
          : null;
        if (msgDate && msgDate !== lastDate) {
          lastDate = msgDate;
          const sep = document.createElement("div");
          sep.className = "date-sep";
          sep.textContent = msgDate;
          DOM.messagesContainer.appendChild(sep);
        }

        appendMessage(data);
        scrollToBottom();
      }

      // ── Message deleted (from DB) — remove from DOM instantly ──
      if (change.type === "removed") {
        const el = document.querySelector(`[data-msg-id="${change.doc.id}"]`);
        if (el) {
          el.style.animation = "msgFadeOut 0.2s ease forwards";
          setTimeout(() => el.remove(), 220);
        }
      }
    });
  });
}

// ══════════════════════════════════════════════════════
// TASK 3 — MESSAGE DELETE
// Hover → show delete icon → deleteDoc on click
// ══════════════════════════════════════════════════════

function appendMessage(data) {
  const isSent = data.senderId === state.currentUser.uid;
  const row    = document.createElement("div");
  row.className       = `msg-row ${isSent ? "sent" : "received"}`;
  row.dataset.msgId   = data.id; // for DOM removal on delete

  // Only sender can delete their own messages
  const deleteBtn = isSent
    ? `<button class="msg-delete-btn" data-id="${data.id}" title="Delete">
         <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
           <polyline points="3 6 5 6 21 6"/>
           <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
           <path d="M10 11v6M14 11v6"/>
           <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
         </svg>
       </button>`
    : "";

  row.innerHTML = `
    ${deleteBtn}
    <div class="bubble">
      ${escapeHtml(data.text)}
      <div class="bubble-meta">${formatTime(data.createdAt)}</div>
    </div>
  `;

  // Delete button handler
  const btn = row.querySelector(".msg-delete-btn");
  if (btn) {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const msgId = btn.dataset.id;
      try {
        // Firestore path: chats/{chatId}/messages/{messageId}
        await deleteDoc(doc(db, "chats", state.chatId, "messages", msgId));
        // DOM removal is handled by the "removed" change in onSnapshot
      } catch (_) {
        toast("Could not delete message.", "error");
      }
    });
  }

  DOM.messagesContainer.appendChild(row);
}

function scrollToBottom() {
  DOM.messagesContainer.scrollTop = DOM.messagesContainer.scrollHeight;
}

// ══════════════════════════════════════════════════════
// SEND MESSAGE
// ══════════════════════════════════════════════════════

async function sendMessage() {
  const text = DOM.msgInput.value.trim();
  if (!text || !state.chatId) return;

  DOM.msgInput.value = "";

  try {
    await addDoc(collection(db, "chats", state.chatId, "messages"), {
      text,
      senderId:   state.currentUser.uid,
      senderName: state.currentUserData.name,
      createdAt:  serverTimestamp(),  // Task 4: timestamp stored for expiry
    });
  } catch (e) {
    toast("Failed to send message.", "error");
  }
}

// Single binding — no duplicate listeners
DOM.sendBtn.addEventListener("click", sendMessage);
DOM.msgInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ══════════════════════════════════════════════════════
// CALL UI
// ══════════════════════════════════════════════════════

function openCall(type) {
  if (!state.selectedUser) return;

  DOM.callOverlay.classList.add("active");
  DOM.callName.textContent   = state.selectedUser.name;
  DOM.callAvatar.textContent = initials(state.selectedUser.name);
  DOM.callStatus.textContent = type === "voice" ? "Calling…" : "Connecting video…";

  DOM.voiceCallUi.style.display = type === "voice" ? "flex" : "none";
  DOM.videoCallUi.style.display = type === "video" ? "flex" : "none";

  if (type === "video") tryVideo();

  setTimeout(() => {
    DOM.callStatus.textContent = type === "voice" ? "Connected" : "Video connected";
    startCallTimer();
  }, 2000);
}

function tryVideo() {
  navigator.mediaDevices?.getUserMedia({ video: true, audio: true })
    .then(stream => stream.getTracks().forEach(t => t.stop()))
    .catch(() => {});
}

function startCallTimer() {
  clearInterval(state.callTimer); // prevent stacking timers
  state.callSeconds = 0;
  DOM.callTimer.textContent = "00:00";
  state.callTimer = setInterval(() => {
    state.callSeconds++;
    DOM.callTimer.textContent = formatTimer(state.callSeconds);
  }, 1000);
}

function endCall() {
  clearInterval(state.callTimer);
  state.callTimer   = null;
  state.callSeconds = 0;
  DOM.callTimer.textContent = "00:00";
  DOM.callOverlay.classList.remove("active");
}

DOM.voiceCallBtn.addEventListener("click", () => openCall("voice"));
DOM.videoCallBtn.addEventListener("click", () => openCall("video"));
DOM.endCallBtn.addEventListener("click",   endCall);
DOM.endCallBtnV.addEventListener("click",  endCall);

document.querySelectorAll(".ctrl-btn.toggle").forEach(btn => {
  btn.addEventListener("click", () => btn.classList.toggle("active"));
});

// ══════════════════════════════════════════════════════
// MOBILE NAVIGATION
// ══════════════════════════════════════════════════════

const isMobile = () => window.innerWidth <= 768;

function openChatOnMobile() {
  if (!isMobile()) return;
  DOM.sidebar.classList.add("slide-out");
  DOM.chatArea.classList.add("slide-in");
}

DOM.mobileBackBtn.addEventListener("click", () => {
  DOM.chatArea.classList.remove("slide-in");
  DOM.sidebar.classList.remove("slide-out");
  document.querySelectorAll(".user-item").forEach(el => el.classList.remove("active"));
});

window.addEventListener("resize", () => {
  if (!isMobile()) {
    DOM.sidebar.classList.remove("slide-out");
    DOM.chatArea.classList.remove("slide-in");
  }
});

// ══════════════════════════════════════════════════════
// TASK 1 — PWA INSTALL PROMPT (localStorage, once only)
// Bug fixed: was using sessionStorage → showed every tab
// Now uses localStorage with "pwaPromptShown" key
// ══════════════════════════════════════════════════════

let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;

  // Only show if user has never seen OR dismissed the banner
  const alreadyShown = localStorage.getItem("pwaPromptShown");
  if (!alreadyShown) {
    DOM.pwaBanner.style.display = "flex";
  }
});

DOM.pwaInstallBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  DOM.pwaBanner.style.display = "none";
  localStorage.setItem("pwaPromptShown", "1"); // never show again
  if (outcome === "accepted") toast("Nexus installed! 🎉", "success");
});

DOM.pwaCloseBtn.addEventListener("click", () => {
  DOM.pwaBanner.style.display = "none";
  localStorage.setItem("pwaPromptShown", "1"); // dismissed = never show again
});

window.addEventListener("appinstalled", () => {
  DOM.pwaBanner.style.display = "none";
  localStorage.setItem("pwaPromptShown", "1");
  toast("Nexus added to home screen!", "success");
});
