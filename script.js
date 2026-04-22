// ═══════════════════════════════════════════════════════
// script.js — Nexus Chat · Application Logic
// ═══════════════════════════════════════════════════════

import {
  auth, db, rtdb,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  doc, setDoc, getDoc,
  collection, query, orderBy,
  onSnapshot, addDoc, serverTimestamp,
  ref, set, onValue, onDisconnect, rtdbTimestamp,
} from "./firebase.js";

// ── State ────────────────────────────────────────────────
const state = {
  currentUser: null,     // Firebase auth user
  currentUserData: null, // Firestore profile
  selectedUser: null,    // User we're chatting with
  chatId: null,
  messageListener: null, // Unsubscribe fn for messages
  userListener: null,    // Unsubscribe fn for users list
  callTimer: null,
  callSeconds: 0,
};

// ── DOM References ───────────────────────────────────────
const $ = id => document.getElementById(id);

const DOM = {
  // Screens
  intro:    $("intro-screen"),
  auth:     $("auth-screen"),
  app:      $("app-screen"),

  // Auth
  tabLogin:   $("tab-login"),
  tabSignup:  $("tab-signup"),
  formLogin:  $("form-login"),
  formSignup: $("form-signup"),
  loginEmail: $("login-email"),
  loginPass:  $("login-pass"),
  loginBtn:   $("login-btn"),
  loginError: $("login-error"),
  signupName:  $("signup-name"),
  signupEmail: $("signup-email"),
  signupPass:  $("signup-pass"),
  signupBtn:   $("signup-btn"),
  signupError: $("signup-error"),

  // Sidebar
  searchInput:    $("search-input"),
  userList:       $("user-list"),
  selfName:       $("self-name"),
  selfStatus:     $("self-status"),
  selfAvatar:     $("self-avatar"),
  logoutBtn:      $("logout-btn"),

  // Chat
  chatEmpty:       $("chat-empty"),
  chatView:        $("chat-view"),
  chatHeaderAvatar:$("chat-header-avatar"),
  chatHeaderName:  $("chat-header-name"),
  chatHeaderStatus:$("chat-header-status"),
  messagesContainer: $("messages-container"),
  msgInput:        $("msg-input"),
  sendBtn:         $("send-btn"),
  typingIndicator: $("typing-indicator"),
  voiceCallBtn:    $("voice-call-btn"),
  videoCallBtn:    $("video-call-btn"),

  // Mobile navigation
  sidebar:       $("sidebar"),
  chatArea:      $("chat-area"),
  mobileBackBtn: $("mobile-back-btn"),

  // PWA install banner
  pwaBanner:      $("pwa-banner"),
  pwaInstallBtn:  $("pwa-install-btn"),
  pwaCloseBtn:    $("pwa-close-btn"),

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

  // Toast container
  toastContainer: $("toast-container"),
};

// ══════════════════════════════════════════════════════
// UTILITY HELPERS
// ══════════════════════════════════════════════════════

/** Show a toast notification */
function toast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  DOM.toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/** Generate initials from a name */
function initials(name = "") {
  return name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2) || "?";
}

/** Format a Firestore timestamp → time string */
function formatTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Format a call timer in MM:SS */
function formatTimer(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/** Generate a deterministic chat ID from two UIDs */
function getChatId(uid1, uid2) {
  return [uid1, uid2].sort().join("_");
}

/** Switch which screen is visible */
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
// AUTH — Login / Signup
// ══════════════════════════════════════════════════════

// Tab switching
DOM.tabLogin.addEventListener("click", () => {
  DOM.tabLogin.classList.add("active");
  DOM.tabSignup.classList.remove("active");
  DOM.formLogin.classList.remove("hidden");
  DOM.formSignup.classList.add("hidden");
});
DOM.tabSignup.addEventListener("click", () => {
  DOM.tabSignup.classList.add("active");
  DOM.tabLogin.classList.remove("active");
  DOM.formSignup.classList.remove("hidden");
  DOM.formLogin.classList.add("hidden");
});

// Login
DOM.loginBtn.addEventListener("click", async () => {
  const email = DOM.loginEmail.value.trim();
  const pass  = DOM.loginPass.value;
  if (!email || !pass) return showAuthError(DOM.loginError, "Please fill in all fields.");
  DOM.loginBtn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    // onAuthStateChanged handles the rest
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
    // Save profile to Firestore
    await setDoc(doc(db, "users", user.uid), {
      name, email,
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
    "auth/user-not-found":    "No account found with that email.",
    "auth/wrong-password":    "Incorrect password.",
    "auth/email-already-in-use": "Email already registered.",
    "auth/weak-password":     "Password is too weak.",
    "auth/invalid-email":     "Invalid email address.",
    "auth/too-many-requests": "Too many attempts. Try again later.",
  };
  return map[code] || "Something went wrong. Please try again.";
}

// Allow Enter key on inputs
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
    // Load profile from Firestore
    const snap = await getDoc(doc(db, "users", user.uid));
    state.currentUserData = snap.exists() ? snap.data() : { name: user.email, email: user.email };

    // Mark online in Realtime DB + set disconnect handler
    const presenceRef = ref(rtdb, `presence/${user.uid}`);
    await set(presenceRef, { online: true, lastSeen: rtdbTimestamp() });
    onDisconnect(presenceRef).set({ online: false, lastSeen: rtdbTimestamp() });

    initApp();
    showScreen("app");
  } else {
    // Clean up
    if (state.messageListener) state.messageListener();
    if (state.userListener)    state.userListener();
    state.currentUser = null;
    state.currentUserData = null;
    state.selectedUser = null;
    DOM.loginBtn.disabled  = false;
    DOM.signupBtn.disabled = false;
    showScreen("auth");
  }
});

// ══════════════════════════════════════════════════════
// APP INIT — called after login
// ══════════════════════════════════════════════════════

function initApp() {
  const { currentUserData: u, currentUser } = state;

  // Update sidebar footer
  DOM.selfAvatar.textContent = initials(u.name);
  DOM.selfName.textContent   = u.name;
  DOM.selfStatus.textContent = "● Online";
  DOM.selfStatus.classList.add("online-text");

  // Reset chat area
  DOM.chatEmpty.style.display = "flex";
  DOM.chatView.classList.remove("active");

  // Start listening to users collection
  listenToUsers();
}

// ── Logout ───────────────────────────────────────────────
DOM.logoutBtn.addEventListener("click", async () => {
  // Mark offline before signing out
  if (state.currentUser) {
    await set(ref(rtdb, `presence/${state.currentUser.uid}`), {
      online: false, lastSeen: rtdbTimestamp(),
    });
  }
  await signOut(auth);
});

// ══════════════════════════════════════════════════════
// USER LIST — Real-time from Firestore + RTDB presence
// ══════════════════════════════════════════════════════

function listenToUsers() {
  // Show skeletons while loading
  DOM.userList.innerHTML = `
    <div class="skeleton user-skeleton"></div>
    <div class="skeleton user-skeleton"></div>
    <div class="skeleton user-skeleton"></div>`;

  // Listen to Firestore users collection
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

/** Track presence per uid so we can update dots */
const presenceCache = {};

function renderUserList(users) {
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

    // Listen to this user's presence in RTDB
    const presRef = ref(rtdb, `presence/${u.uid}`);
    onValue(presRef, snap => {
      const online = snap.val()?.online === true;
      presenceCache[u.uid] = online;

      const dot  = document.getElementById(`dot-${u.uid}`);
      const text = document.getElementById(`status-text-${u.uid}`);
      if (dot)  { dot.className  = `status-dot ${online ? "online" : ""}`; }
      if (text) {
        text.textContent = online ? "Online" : "Offline";
        text.className   = `user-status ${online ? "online-text" : ""}`;
      }
    });

    item.addEventListener("click", () => selectUser(u));
    DOM.userList.appendChild(item);
  });

  // Re-apply search filter
  filterUsers(DOM.searchInput.value);
}

// Search / filter
DOM.searchInput.addEventListener("input", e => filterUsers(e.target.value));

function filterUsers(query) {
  const q = query.toLowerCase();
  document.querySelectorAll(".user-item").forEach(el => {
    const name = el.querySelector(".user-name")?.textContent.toLowerCase() || "";
    el.style.display = name.includes(q) ? "" : "none";
  });
}

// ══════════════════════════════════════════════════════
// SELECT USER → OPEN CHAT
// ══════════════════════════════════════════════════════

function selectUser(u) {
  state.selectedUser = u;
  state.chatId = getChatId(state.currentUser.uid, u.uid);

  // Highlight active user
  document.querySelectorAll(".user-item").forEach(el => el.classList.remove("active"));
  const item = document.querySelector(`.user-item[data-uid="${u.uid}"]`);
  if (item) item.classList.add("active");

  // Update chat header
  DOM.chatHeaderAvatar.textContent = initials(u.name);
  DOM.chatHeaderName.textContent   = u.name;
  const online = presenceCache[u.uid] === true;
  DOM.chatHeaderStatus.textContent = online ? "Online" : "Offline";
  DOM.chatHeaderStatus.className   = `user-status ${online ? "online-text" : ""}`;

  // Switch to chat view
  DOM.chatEmpty.style.display = "none";
  DOM.chatView.classList.add("active");
  DOM.messagesContainer.innerHTML = "";

  // Unsubscribe old listener, start new one
  if (state.messageListener) state.messageListener();
  listenToMessages();

  // On mobile: slide the chat panel into view
  openChatOnMobile();

  // Focus input (after a small delay on mobile to avoid keyboard lag)
  setTimeout(() => DOM.msgInput.focus(), 300);
}

// ══════════════════════════════════════════════════════
// MESSAGES — Real-time Firestore listener
// ══════════════════════════════════════════════════════

function listenToMessages() {
  const msgsRef = collection(db, "chats", state.chatId, "messages");
  const q = query(msgsRef, orderBy("createdAt", "asc"));

  let lastDate = null;

  state.messageListener = onSnapshot(q, snap => {
    // For incremental updates only process new docs
    snap.docChanges().forEach(change => {
      if (change.type === "added") {
        const data = change.doc.data();
        const msgDate = data.createdAt
          ? data.createdAt.toDate().toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })
          : null;

        // Insert date separator if the day changed
        if (msgDate && msgDate !== lastDate) {
          lastDate = msgDate;
          const sep = document.createElement("div");
          sep.className = "date-sep";
          sep.textContent = msgDate;
          DOM.messagesContainer.appendChild(sep);
        }

        appendMessage(data);
      }
    });
    scrollToBottom();
  });
}

function appendMessage(data) {
  const isSent = data.senderId === state.currentUser.uid;
  const row = document.createElement("div");
  row.className = `msg-row ${isSent ? "sent" : "received"}`;

  row.innerHTML = `
    <div class="bubble">
      ${escapeHtml(data.text)}
      <div class="bubble-meta">${formatTime(data.createdAt)}</div>
    </div>
  `;
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
      createdAt:  serverTimestamp(),
    });
  } catch (e) {
    toast("Failed to send message.", "error");
  }
}

DOM.sendBtn.addEventListener("click", sendMessage);
DOM.msgInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ══════════════════════════════════════════════════════
// TYPING INDICATOR (local demo — extend with RTDB)
// ══════════════════════════════════════════════════════

let typingTimeout = null;
DOM.msgInput.addEventListener("input", () => {
  // In a full implementation, write to RTDB: typing/{chatId}/{uid} = true
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    // typing = false
  }, 1500);
});

// ══════════════════════════════════════════════════════
// CALL UI
// ══════════════════════════════════════════════════════

function openCall(type) {
  if (!state.selectedUser) return;

  DOM.callOverlay.classList.add("active");
  DOM.callName.textContent   = state.selectedUser.name;
  DOM.callAvatar.textContent = initials(state.selectedUser.name);
  DOM.callStatus.textContent = type === "voice" ? "Calling…" : "Video call…";

  if (type === "voice") {
    DOM.voiceCallUi.style.display = "flex";
    DOM.videoCallUi.style.display = "none";
  } else {
    DOM.voiceCallUi.style.display = "none";
    DOM.videoCallUi.style.display = "flex";
    // Try to access camera (graceful degradation)
    tryVideo();
  }

  // Start call timer after a short "connecting" delay
  setTimeout(() => {
    DOM.callStatus.textContent = type === "voice" ? "Connected" : "Video connected";
    startCallTimer();
  }, 2000);
}

function tryVideo() {
  if (navigator.mediaDevices?.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(stream => {
        // In a real WebRTC app: attach stream to <video> elements
        // For now we just show the UI
        stream.getTracks().forEach(t => t.stop()); // release immediately in demo
      })
      .catch(() => {}); // Permission denied — UI still shows
  }
}

function startCallTimer() {
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

// Mic / cam toggle buttons (visual only — extend with WebRTC tracks)
document.querySelectorAll(".ctrl-btn.toggle").forEach(btn => {
  btn.addEventListener("click", () => btn.classList.toggle("active"));
});

// ══════════════════════════════════════════════════════
// MOBILE NAVIGATION
// Sidebar = full screen → tap user → chat slides in
// Back button → chat slides out → sidebar shows
// ══════════════════════════════════════════════════════

const isMobile = () => window.innerWidth <= 768;

/** Called when a user is selected — on mobile: slide chat in */
function openChatOnMobile() {
  if (!isMobile()) return;
  DOM.sidebar.classList.add("slide-out");
  DOM.chatArea.classList.add("slide-in");
}

/** Back button — slide chat out, show sidebar */
DOM.mobileBackBtn.addEventListener("click", () => {
  DOM.chatArea.classList.remove("slide-in");
  DOM.sidebar.classList.remove("slide-out");
  // Also de-select user visually
  document.querySelectorAll(".user-item").forEach(el => el.classList.remove("active"));
});

// Handle window resize (e.g. rotate to landscape)
window.addEventListener("resize", () => {
  if (!isMobile()) {
    // Reset mobile slide classes on desktop
    DOM.sidebar.classList.remove("slide-out");
    DOM.chatArea.classList.remove("slide-in");
  }
});

// Patch selectUser to also trigger mobile slide
const _origSelectUser = selectUser;
// We override the call inside selectUser by hooking into user-item click
// (selectUser is called directly; we add mobile open after it)
// This is handled below by patching the user-item event in renderUserList.

// ══════════════════════════════════════════════════════
// PWA INSTALL PROMPT
// ══════════════════════════════════════════════════════

let deferredInstallPrompt = null;

// Capture the browser's beforeinstallprompt event
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // stop auto mini-bar
  deferredInstallPrompt = e;

  // Show our custom banner (only if not already installed)
  const dismissed = sessionStorage.getItem("pwa-banner-dismissed");
  if (!dismissed) {
    DOM.pwaBanner.style.display = "flex";
  }
});

// Install button clicked
DOM.pwaInstallBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  if (outcome === "accepted") {
    toast("Nexus installed successfully! 🎉", "success");
  }
  deferredInstallPrompt = null;
  DOM.pwaBanner.style.display = "none";
});

// Close banner
DOM.pwaCloseBtn.addEventListener("click", () => {
  DOM.pwaBanner.style.display = "none";
  sessionStorage.setItem("pwa-banner-dismissed", "1");
});

// Hide banner once app is installed
window.addEventListener("appinstalled", () => {
  DOM.pwaBanner.style.display = "none";
  toast("Nexus added to home screen!", "success");
});

// ══════════════════════════════════════════════════════
// SECURITY — XSS prevention
// ══════════════════════════════════════════════════════

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}
