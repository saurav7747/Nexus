// ═══════════════════════════════════════════════════════
// script.js — Nexus Chat · Production v3
// Tasks: PWA fix, branding, chat validation, delete,
//        24h auto-delete, notifications+sounds,
//        typing indicator, WebRTC calls, cleanup
// ═══════════════════════════════════════════════════════

import {
  auth, db, rtdb,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  doc, setDoc, getDoc, getDocs,
  collection, query, orderBy, where, limit,
  onSnapshot, addDoc, deleteDoc, updateDoc,
  serverTimestamp, Timestamp,
  ref, set, get, remove, onValue, off,
  onDisconnect, rtdbTimestamp,
} from "./firebase.js";

// ══════════════════════════════════════════════════════
// STATE — single source of truth
// ══════════════════════════════════════════════════════
const state = {
  // Auth
  currentUser:      null,
  currentUserData:  null,

  // Chat
  selectedUser:     null,
  chatId:           null,
  messageListener:  null,   // Unsubscribe fn
  userListener:     null,   // Unsubscribe fn
  typingTimeout:    null,
  typingListener:   null,   // RTDB off() ref

  // UI
  rotatorInterval:  null,

  // Calls (WebRTC)
  peerConnection:   null,
  localStream:      null,
  remoteStream:     null,
  callId:           null,
  callListener:     null,   // Firestore unsubscribe
  callType:         null,   // 'voice' | 'video'
  callTimer:        null,
  callSeconds:      0,
  isCaller:         false,
  micMuted:         false,
  camOff:           false,

  // Incoming call
  incomingCallId:   null,
  incomingCallListener: null,
};

// ══════════════════════════════════════════════════════
// DOM REFERENCES — resolved once at startup
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
  searchInput:   $("search-input"),
  userList:      $("user-list"),
  selfName:      $("self-name"),
  selfStatus:    $("self-status"),
  selfAvatar:    $("self-avatar"),
  logoutBtn:     $("logout-btn"),
  headerRotator: $("header-rotator"),

  // Chat
  chatEmpty:         $("chat-empty"),
  chatView:          $("chat-view"),
  chatHeaderAvatar:  $("chat-header-avatar"),
  chatHeaderName:    $("chat-header-name"),
  chatHeaderStatus:  $("chat-header-status"),
  chatTypingStatus:  $("chat-typing-status"),
  messagesContainer: $("messages-container"),
  msgInput:          $("msg-input"),
  sendBtn:           $("send-btn"),
  typingIndicator:   $("typing-indicator"),
  voiceCallBtn:      $("voice-call-btn"),
  videoCallBtn:      $("video-call-btn"),

  // Mobile
  sidebar:       $("sidebar"),
  chatArea:      $("chat-area"),
  mobileBackBtn: $("mobile-back-btn"),

  // PWA
  pwaBanner:     $("pwa-banner"),
  pwaInstallBtn: $("pwa-install-btn"),
  pwaCloseBtn:   $("pwa-close-btn"),

  // Call overlay
  callOverlay:       $("call-overlay"),
  voiceCallUi:       $("voice-call-ui"),
  videoCallUi:       $("video-call-ui"),
  callAvatar:        $("call-avatar"),
  callName:          $("call-name"),
  callStatus:        $("call-status"),
  callTimerEl:       $("call-timer"),
  endCallBtn:        $("end-call-btn"),
  endCallBtnV:       $("end-call-btn-v"),
  micToggleBtn:      $("mic-toggle-btn"),
  camToggleBtn:      $("cam-toggle-btn"),
  remoteVideo:       $("remote-video"),
  localVideo:        $("local-video"),

  // Incoming call modal
  incomingCallModal:  $("incoming-call-modal"),
  incomingCallerName: $("incoming-caller-name"),
  incomingCallType:   $("incoming-call-type-icon"),
  acceptCallBtn:      $("accept-call-btn"),
  rejectCallBtn:      $("reject-call-btn"),

  // Toast
  toastContainer: $("toast-container"),
};

// ══════════════════════════════════════════════════════
// TASK 6 — SOUNDS (lazy-loaded Audio objects)
// ══════════════════════════════════════════════════════
const Sounds = {
  _msg:       null,
  _ringtone:  null,

  get msg() {
    if (!this._msg) {
      this._msg = new Audio("message.mp3");
      this._msg.volume = 0.6;
    }
    return this._msg;
  },

  get ringtone() {
    if (!this._ringtone) {
      this._ringtone = new Audio("ringtone.mp3");
      this._ringtone.loop   = true;
      this._ringtone.volume = 0.7;
    }
    return this._ringtone;
  },

  playMsg()       { this.msg.currentTime = 0; this.msg.play().catch(() => {}); },
  startRingtone() { this.ringtone.currentTime = 0; this.ringtone.play().catch(() => {}); },
  stopRingtone()  { this.ringtone.pause(); this.ringtone.currentTime = 0; },
};

// ══════════════════════════════════════════════════════
// TASK 6 — BROWSER NOTIFICATIONS
// Only fire when tab is hidden (document.hidden)
// ══════════════════════════════════════════════════════
async function requestNotifPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

function sendNotification(title, body, icon = "icon-192.png") {
  if (!document.hidden) return; // only when tab is in background
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  new Notification(title, { body, icon, badge: "icon-192.png" });
}

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

// chatId = sorted UIDs joined — deterministic for both parties
function getChatId(uid1, uid2) {
  return [uid1, uid2].sort().join("_");
}

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
// ══════════════════════════════════════════════════════
const ROTATOR_TEXTS = [
  "Student Web Developer",
  "Building GoD Apps",
  "Future God 🤟🏻👽",
  "Focused on Clean UI/UX",
  "Turning Ideas into Products",
];
let rotatorIndex = 0;

function startHeaderRotator() {
  if (!DOM.headerRotator) return;
  if (state.rotatorInterval) clearInterval(state.rotatorInterval);

  DOM.headerRotator.textContent = ROTATOR_TEXTS[0];
  DOM.headerRotator.classList.add("rotator-visible");

  state.rotatorInterval = setInterval(() => {
    DOM.headerRotator.classList.remove("rotator-visible");
    setTimeout(() => {
      rotatorIndex = (rotatorIndex + 1) % ROTATOR_TEXTS.length;
      DOM.headerRotator.textContent = ROTATOR_TEXTS[rotatorIndex];
      DOM.headerRotator.classList.add("rotator-visible");
    }, 350);
  }, 3000);
}

// ══════════════════════════════════════════════════════
// AUTH — Tab switching
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

DOM.loginBtn.addEventListener("click", async () => {
  const email = DOM.loginEmail.value.trim();
  const pass  = DOM.loginPass.value;
  if (!email || !pass) return showAuthError(DOM.loginError, "Please fill in all fields.");
  DOM.loginBtn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    showAuthError(DOM.loginError, friendlyAuthError(e.code));
    DOM.loginBtn.disabled = false;
  }
});

DOM.signupBtn.addEventListener("click", async () => {
  const name  = DOM.signupName.value.trim();
  const email = DOM.signupEmail.value.trim();
  const pass  = DOM.signupPass.value;
  if (!name || !email || !pass) return showAuthError(DOM.signupError, "Please fill in all fields.");
  if (pass.length < 6) return showAuthError(DOM.signupError, "Password must be at least 6 characters.");
  DOM.signupBtn.disabled = true;
  try {
    const { user } = await createUserWithEmailAndPassword(auth, email, pass);
    await setDoc(doc(db, "users", user.uid), {
      name, email, uid: user.uid,
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

    const snap = await getDoc(doc(db, "users", user.uid));
    state.currentUserData = snap.exists()
      ? snap.data()
      : { name: user.email, email: user.email, uid: user.uid };

    // Presence
    const presenceRef = ref(rtdb, `presence/${user.uid}`);
    await set(presenceRef, { online: true, lastSeen: rtdbTimestamp() });
    onDisconnect(presenceRef).set({ online: false, lastSeen: rtdbTimestamp() });

    // Request notification permission once
    await requestNotifPermission();

    initApp();
    showScreen("app");
  } else {
    fullCleanup();
    DOM.loginBtn.disabled  = false;
    DOM.signupBtn.disabled = false;
    showScreen("auth");
  }
});

// ── Full cleanup on logout / auth loss ──────────────
function fullCleanup() {
  if (state.messageListener)  { state.messageListener();  state.messageListener  = null; }
  if (state.userListener)     { state.userListener();     state.userListener     = null; }
  if (state.callListener)     { state.callListener();     state.callListener     = null; }
  if (state.incomingCallListener) { state.incomingCallListener(); state.incomingCallListener = null; }
  if (state.rotatorInterval)  { clearInterval(state.rotatorInterval); state.rotatorInterval = null; }
  if (state.typingTimeout)    { clearTimeout(state.typingTimeout); state.typingTimeout = null; }
  cleanupRTCCall();

  state.currentUser     = null;
  state.currentUserData = null;
  state.selectedUser    = null;
  state.chatId          = null;
}

// ══════════════════════════════════════════════════════
// APP INIT
// ══════════════════════════════════════════════════════
function initApp() {
  const u = state.currentUserData;
  DOM.selfAvatar.textContent = initials(u.name);
  DOM.selfName.textContent   = u.name;
  DOM.selfStatus.textContent = "● Online";
  DOM.selfStatus.classList.add("online-text");

  DOM.chatEmpty.style.display = "flex";
  DOM.chatView.classList.remove("active");
  DOM.messagesContainer.innerHTML = "";

  startHeaderRotator();
  listenToUsers();
  listenForIncomingCalls();    // Task 8: watch for incoming call docs
}

DOM.logoutBtn.addEventListener("click", async () => {
  if (state.currentUser) {
    await set(ref(rtdb, `presence/${state.currentUser.uid}`), {
      online: false, lastSeen: rtdbTimestamp(),
    });
  }
  await signOut(auth);
});

// ══════════════════════════════════════════════════════
// USER LIST — onSnapshot (real-time, Task 3)
// ══════════════════════════════════════════════════════
function listenToUsers() {
  if (state.userListener) { state.userListener(); state.userListener = null; }

  DOM.userList.innerHTML = `
    <div class="skeleton user-skeleton"></div>
    <div class="skeleton user-skeleton"></div>
    <div class="skeleton user-skeleton"></div>`;

  const q = collection(db, "users");
  state.userListener = onSnapshot(q, (snapshot) => {
    const users = [];
    snapshot.forEach(d => {
      if (d.id !== state.currentUser.uid) users.push({ uid: d.id, ...d.data() });
    });
    renderUserList(users);
  });
}

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
  // Tear down previous chat typing listener
  stopTypingListener();

  state.selectedUser = u;
  state.chatId       = getChatId(state.currentUser.uid, u.uid);

  document.querySelectorAll(".user-item").forEach(el => el.classList.remove("active"));
  const item = document.querySelector(`.user-item[data-uid="${u.uid}"]`);
  if (item) item.classList.add("active");

  DOM.chatHeaderAvatar.textContent = initials(u.name);
  DOM.chatHeaderName.textContent   = u.name;
  const online = presenceCache[u.uid] === true;
  DOM.chatHeaderStatus.textContent = online ? "Online" : "Offline";
  DOM.chatHeaderStatus.className   = `user-status${online ? " online-text" : ""}`;
  if (DOM.chatTypingStatus) DOM.chatTypingStatus.textContent = "";

  DOM.chatEmpty.style.display = "none";
  DOM.chatView.classList.add("active");
  DOM.messagesContainer.innerHTML = ""; // clean reset

  if (state.messageListener) { state.messageListener(); state.messageListener = null; }
  listenToMessages();
  listenToTyping();       // Task 7

  openChatOnMobile();
  setTimeout(() => DOM.msgInput.focus(), 300);
}

// ══════════════════════════════════════════════════════
// 24H AUTO-DELETE (Frontend layer — Task 5)
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
  } catch (_) {}
}

// ══════════════════════════════════════════════════════
// MESSAGES — Real-time onSnapshot (Task 3)
// ══════════════════════════════════════════════════════
function listenToMessages() {
  const msgsRef = collection(db, "chats", state.chatId, "messages");
  const q       = query(msgsRef, orderBy("createdAt", "asc"));
  let   lastDate = null;

  state.messageListener = onSnapshot(q, snap => {
    snap.docChanges().forEach(change => {

      if (change.type === "added") {
        const data = { id: change.doc.id, ...change.doc.data() };

        // Skip + delete expired
        if (isExpired(data.createdAt)) {
          deleteExpiredMessage(data.id);
          return;
        }

        // Date separator
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

        const isOwn = data.senderId === state.currentUser.uid;
        appendMessage(data);

        // Task 6: sound + notification for incoming messages only
        if (!isOwn) {
          Sounds.playMsg();
          sendNotification(
            data.senderName || "New Message",
            data.text.length > 60 ? data.text.slice(0, 60) + "…" : data.text
          );
        }

        scrollToBottom();
      }

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
// APPEND MESSAGE — with delete button (Task 4)
// ══════════════════════════════════════════════════════
function appendMessage(data) {
  const isSent = data.senderId === state.currentUser.uid;
  const row    = document.createElement("div");
  row.className     = `msg-row ${isSent ? "sent" : "received"}`;
  row.dataset.msgId = data.id;

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

  const btn = row.querySelector(".msg-delete-btn");
  if (btn) {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await deleteDoc(doc(db, "chats", state.chatId, "messages", btn.dataset.id));
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
  clearTypingInDB(); // clear typing on send

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
// TASK 7 — TYPING INDICATOR
// RTDB path: typing/{chatId}/{uid}
// ══════════════════════════════════════════════════════
function typingRefPath() {
  return ref(rtdb, `typing/${state.chatId}/${state.currentUser.uid}`);
}

function setTypingInDB(isTyping) {
  if (!state.chatId) return;
  set(typingRefPath(), isTyping ? true : null);
}

function clearTypingInDB() {
  setTypingInDB(false);
}

DOM.msgInput.addEventListener("input", () => {
  if (!state.chatId) return;
  setTypingInDB(true);

  // Debounce: stop typing after 1.5s of no input
  clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(() => {
    setTypingInDB(false);
  }, 1500);
});

function listenToTyping() {
  if (!state.chatId || !state.selectedUser) return;

  // Watch the OTHER user's typing flag
  const theirRef = ref(rtdb, `typing/${state.chatId}/${state.selectedUser.uid}`);

  const handler = (snap) => {
    const isTyping = snap.val() === true;

    // Update the subtle "Typing…" text under the header name
    if (DOM.chatTypingStatus) {
      DOM.chatTypingStatus.textContent = isTyping ? "typing…" : "";
    }

    // Show / hide the animated typing bubble
    if (DOM.typingIndicator) {
      DOM.typingIndicator.classList.toggle("visible", isTyping);
      if (isTyping) scrollToBottom();
    }
  };

  onValue(theirRef, handler);
  // Store ref so we can call off() when leaving the chat
  state.typingListener = { ref: theirRef, handler };
}

function stopTypingListener() {
  if (state.typingListener) {
    off(state.typingListener.ref, "value", state.typingListener.handler);
    state.typingListener = null;
  }
  // Also clear our own typing flag
  clearTypingInDB();
}

// ══════════════════════════════════════════════════════
// TASK 8 — WebRTC CALLS
// Signaling via Firestore: calls/{callId}
// ══════════════════════════════════════════════════════

// ICE server config — uses free Google STUN
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// ── 8a. Initiate a call ──────────────────────────────
DOM.voiceCallBtn.addEventListener("click", () => initiateCall("voice"));
DOM.videoCallBtn.addEventListener("click", () => initiateCall("video"));

async function initiateCall(type) {
  if (!state.selectedUser) return;

  state.callType = type;
  state.isCaller = true;

  // Get local media
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === "video",
    });
  } catch (err) {
    toast("Microphone/Camera permission denied.", "error");
    return;
  }

  // Show call UI immediately
  showCallUI(type, "Calling…");
  attachLocalVideo();

  // Create RTCPeerConnection
  createPeerConnection();

  // Add local tracks to connection
  state.localStream.getTracks().forEach(track =>
    state.peerConnection.addTrack(track, state.localStream)
  );

  // Create Firestore call document
  const callRef = await addDoc(collection(db, "calls"), {
    callerId:      state.currentUser.uid,
    callerName:    state.currentUserData.name,
    calleeId:      state.selectedUser.uid,
    type,
    status:        "calling",  // calling → accepted → ended
    createdAt:     serverTimestamp(),
    offer:         null,
    answer:        null,
  });
  state.callId = callRef.id;

  // Create SDP offer
  const offer = await state.peerConnection.createOffer();
  await state.peerConnection.setLocalDescription(offer);

  // Write offer to Firestore
  await updateDoc(callRef, {
    offer: { sdp: offer.sdp, type: offer.type },
  });

  // Send ICE candidates to Firestore as they arrive
  state.peerConnection.onicecandidate = async (e) => {
    if (e.candidate) {
      await addDoc(collection(db, "calls", state.callId, "callerCandidates"), e.candidate.toJSON());
    }
  };

  // Listen for answer + callee ICE candidates
  state.callListener = onSnapshot(callRef, async (snap) => {
    const data = snap.data();
    if (!data) return;

    if (data.status === "rejected") {
      toast(`${state.selectedUser.name} rejected the call.`, "error");
      await endCall(false);
      return;
    }

    if (data.status === "ended") {
      await endCall(false);
      return;
    }

    // Set remote description when callee answers
    if (data.answer && !state.peerConnection.remoteDescription) {
      const answer = new RTCSessionDescription(data.answer);
      await state.peerConnection.setRemoteDescription(answer);
      DOM.callStatus.textContent = "Connected";
      startCallTimer();
    }
  });

  // Listen for callee's ICE candidates
  const calleeCands = collection(db, "calls", state.callId, "calleeCandidates");
  onSnapshot(calleeCands, snap => {
    snap.docChanges().forEach(change => {
      if (change.type === "added") {
        const cand = new RTCIceCandidate(change.doc.data());
        state.peerConnection.addIceCandidate(cand).catch(() => {});
      }
    });
  });
}

// ── 8b. Listen for incoming calls ───────────────────
function listenForIncomingCalls() {
  if (state.incomingCallListener) {
    state.incomingCallListener();
    state.incomingCallListener = null;
  }

  const q = query(
    collection(db, "calls"),
    where("calleeId", "==", state.currentUser.uid),
    where("status", "==", "calling"),
    limit(1)
  );

  state.incomingCallListener = onSnapshot(q, snap => {
    snap.docChanges().forEach(change => {
      if (change.type === "added") {
        const data = change.doc.data();
        state.incomingCallId = change.doc.id;
        showIncomingCallModal(data.callerName, data.type);
        Sounds.startRingtone();
        sendNotification(
          `Incoming ${data.type} call`,
          `${data.callerName} is calling you`,
        );
      }
      if (change.type === "removed") {
        // Caller cancelled
        hideIncomingCallModal();
        Sounds.stopRingtone();
      }
    });
  });
}

// ── 8c. Accept call ─────────────────────────────────
DOM.acceptCallBtn?.addEventListener("click", async () => {
  Sounds.stopRingtone();
  hideIncomingCallModal();

  const callId  = state.incomingCallId;
  const callRef = doc(db, "calls", callId);
  const callSnap = await getDoc(callRef);
  const callData = callSnap.data();

  if (!callData) return;

  state.callType  = callData.type;
  state.callId    = callId;
  state.isCaller  = false;

  // Get local media
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callData.type === "video",
    });
  } catch (err) {
    toast("Camera/Mic permission denied.", "error");
    await updateDoc(callRef, { status: "rejected" });
    return;
  }

  showCallUI(callData.type, "Connecting…");
  attachLocalVideo();

  createPeerConnection();

  state.localStream.getTracks().forEach(track =>
    state.peerConnection.addTrack(track, state.localStream)
  );

  state.peerConnection.onicecandidate = async (e) => {
    if (e.candidate) {
      await addDoc(collection(db, "calls", callId, "calleeCandidates"), e.candidate.toJSON());
    }
  };

  // Set remote offer
  const offer = new RTCSessionDescription(callData.offer);
  await state.peerConnection.setRemoteDescription(offer);

  // Create answer
  const answer = await state.peerConnection.createAnswer();
  await state.peerConnection.setLocalDescription(answer);

  await updateDoc(callRef, {
    answer: { sdp: answer.sdp, type: answer.type },
    status: "accepted",
  });

  // Listen for caller's ICE candidates
  const callerCands = collection(db, "calls", callId, "callerCandidates");
  onSnapshot(callerCands, snap => {
    snap.docChanges().forEach(change => {
      if (change.type === "added") {
        const cand = new RTCIceCandidate(change.doc.data());
        state.peerConnection.addIceCandidate(cand).catch(() => {});
      }
    });
  });

  // Watch for call end
  state.callListener = onSnapshot(callRef, snap => {
    if (snap.data()?.status === "ended") endCall(false);
  });

  DOM.callStatus.textContent = "Connected";
  startCallTimer();
});

// ── 8d. Reject call ─────────────────────────────────
DOM.rejectCallBtn?.addEventListener("click", async () => {
  Sounds.stopRingtone();
  hideIncomingCallModal();
  if (state.incomingCallId) {
    try {
      await updateDoc(doc(db, "calls", state.incomingCallId), { status: "rejected" });
    } catch (_) {}
    state.incomingCallId = null;
  }
});

// ── 8e. Create RTCPeerConnection ─────────────────────
function createPeerConnection() {
  // Clean up any old connection first
  if (state.peerConnection) {
    state.peerConnection.close();
    state.peerConnection = null;
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.peerConnection = pc;

  // Remote track → attach to remote video/audio
  state.remoteStream = new MediaStream();
  pc.ontrack = (e) => {
    e.streams[0].getTracks().forEach(track => state.remoteStream.addTrack(track));

    if (DOM.remoteVideo) {
      DOM.remoteVideo.srcObject = state.remoteStream;
    }
  };

  pc.onconnectionstatechange = () => {
    if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
      endCall(false);
    }
  };

  return pc;
}

// ── 8f. Attach local stream to preview ──────────────
function attachLocalVideo() {
  if (DOM.localVideo && state.localStream) {
    DOM.localVideo.srcObject = state.localStream;
    DOM.localVideo.muted     = true;  // no echo
  }
}

// ── 8g. End call ─────────────────────────────────────
DOM.endCallBtn?.addEventListener("click",  () => endCall(true));
DOM.endCallBtnV?.addEventListener("click", () => endCall(true));

async function endCall(notify = true) {
  // Stop ringtone if still ringing
  Sounds.stopRingtone();

  // Update Firestore status
  if (notify && state.callId) {
    try {
      await updateDoc(doc(db, "calls", state.callId), { status: "ended" });
    } catch (_) {}
  }

  cleanupRTCCall();
  hideCallUI();
}

// ── Task 9 — Full RTC cleanup, no memory leaks ───────
function cleanupRTCCall() {
  // Stop all media tracks
  state.localStream?.getTracks().forEach(t => t.stop());
  state.localStream  = null;
  state.remoteStream = null;

  // Close peer connection
  if (state.peerConnection) {
    state.peerConnection.ontrack         = null;
    state.peerConnection.onicecandidate  = null;
    state.peerConnection.onconnectionstatechange = null;
    state.peerConnection.close();
    state.peerConnection = null;
  }

  // Unsubscribe Firestore call listener
  if (state.callListener) { state.callListener(); state.callListener = null; }

  // Clear video elements
  if (DOM.remoteVideo) DOM.remoteVideo.srcObject = null;
  if (DOM.localVideo)  DOM.localVideo.srcObject  = null;

  // Clear call timer
  clearInterval(state.callTimer);
  state.callTimer   = null;
  state.callSeconds = 0;
  state.callId      = null;
  state.isCaller    = false;
  state.micMuted    = false;
  state.camOff      = false;
}

// ══════════════════════════════════════════════════════
// CALL UI HELPERS
// ══════════════════════════════════════════════════════
function showCallUI(type, statusText) {
  DOM.callOverlay.classList.add("active");
  DOM.callName.textContent   = state.selectedUser?.name || "";
  DOM.callAvatar.textContent = initials(state.selectedUser?.name || "");
  DOM.callStatus.textContent = statusText;
  if (DOM.callTimerEl) DOM.callTimerEl.textContent = "00:00";

  DOM.voiceCallUi.style.display = type === "voice" ? "flex" : "none";
  DOM.videoCallUi.style.display = type === "video" ? "flex" : "none";
}

function hideCallUI() {
  DOM.callOverlay.classList.remove("active");
  if (DOM.callTimerEl) DOM.callTimerEl.textContent = "00:00";
  // Reset toggle button states
  DOM.micToggleBtn?.classList.remove("active");
  DOM.camToggleBtn?.classList.remove("active");
}

function startCallTimer() {
  clearInterval(state.callTimer);
  state.callSeconds = 0;
  if (DOM.callTimerEl) DOM.callTimerEl.textContent = "00:00";
  state.callTimer = setInterval(() => {
    state.callSeconds++;
    if (DOM.callTimerEl) DOM.callTimerEl.textContent = formatTimer(state.callSeconds);
  }, 1000);
}

// ── Incoming call modal ──────────────────────────────
function showIncomingCallModal(callerName, type) {
  if (!DOM.incomingCallModal) return;
  DOM.incomingCallerName.textContent = callerName;
  if (DOM.incomingCallType) DOM.incomingCallType.textContent = type === "video" ? "📹" : "📞";
  DOM.incomingCallModal.classList.add("active");
}

function hideIncomingCallModal() {
  DOM.incomingCallModal?.classList.remove("active");
  state.incomingCallId = null;
}

// ── Mic / Cam toggles ────────────────────────────────
DOM.micToggleBtn?.addEventListener("click", () => {
  state.micMuted = !state.micMuted;
  state.localStream?.getAudioTracks().forEach(t => { t.enabled = !state.micMuted; });
  DOM.micToggleBtn.classList.toggle("active", state.micMuted);
});

DOM.camToggleBtn?.addEventListener("click", () => {
  state.camOff = !state.camOff;
  state.localStream?.getVideoTracks().forEach(t => { t.enabled = !state.camOff; });
  DOM.camToggleBtn.classList.toggle("active", state.camOff);
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
  stopTypingListener();
});

window.addEventListener("resize", () => {
  if (!isMobile()) {
    DOM.sidebar.classList.remove("slide-out");
    DOM.chatArea.classList.remove("slide-in");
  }
});

// ══════════════════════════════════════════════════════
// TASK 1 — PWA INSTALL (localStorage, once only)
// ══════════════════════════════════════════════════════
let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!localStorage.getItem("pwaPromptShown")) {
    DOM.pwaBanner.style.display = "flex";
  }
});

DOM.pwaInstallBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  DOM.pwaBanner.style.display = "none";
  localStorage.setItem("pwaPromptShown", "1");
  if (outcome === "accepted") toast("Nexus installed! 🎉", "success");
});

DOM.pwaCloseBtn.addEventListener("click", () => {
  DOM.pwaBanner.style.display = "none";
  localStorage.setItem("pwaPromptShown", "1");
});

window.addEventListener("appinstalled", () => {
  DOM.pwaBanner.style.display = "none";
  localStorage.setItem("pwaPromptShown", "1");
  toast("Nexus added to home screen!", "success");
});
