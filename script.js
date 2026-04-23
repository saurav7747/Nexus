// ═══════════════════════════════════════════════════════
// script.js — Nexus Chat · Production v4
// Agora SDK replaces raw WebRTC for voice/video calls.
// All existing features (chat, typing, presence, PWA,
// notifications, sounds, branding) are unchanged.
// ═══════════════════════════════════════════════════════

import {
  auth, db, rtdb,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  doc, setDoc, getDoc,
  collection, query, orderBy, where, limit,
  onSnapshot, addDoc, deleteDoc, updateDoc,
  serverTimestamp,
  ref, set, onValue, off,
  onDisconnect, rtdbTimestamp,
} from "./firebase.js";

// ══════════════════════════════════════════════════════
// AGORA CONFIG
// ══════════════════════════════════════════════════════
const AGORA_APP_ID = "db7e691d8b014a7f9737cba88a939b82";

// Agora client instances — created lazily, never duplicated
let agoraClient      = null; // RTC client (audio/video)
let localAudioTrack  = null;
let localVideoTrack  = null;

// ══════════════════════════════════════════════════════
// STATE — single source of truth
// ══════════════════════════════════════════════════════
const state = {
  // Auth
  currentUser:     null,
  currentUserData: null,

  // Chat
  selectedUser:    null,
  chatId:          null,
  messageListener: null,
  userListener:    null,
  typingTimeout:   null,
  typingListener:  null,

  // UI
  rotatorInterval: null,

  // Calls (Agora)
  callId:              null,
  callType:            null,   // "audio" | "video"
  callListener:        null,   // Firestore unsub
  incomingCallId:      null,
  incomingCallData:    null,
  incomingCallListener:null,
  callTimeoutTimer:    null,   // 20-sec no-answer timer
  callTimer:           null,
  callSeconds:         0,
  isCaller:            false,
  micMuted:            false,
  camOff:              false,
  inCall:              false,  // guard: prevent double-join
};

// ══════════════════════════════════════════════════════
// DOM REFERENCES
// ══════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const DOM = {
  intro:    $("intro-screen"),
  auth:     $("auth-screen"),
  app:      $("app-screen"),

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

  searchInput:   $("search-input"),
  userList:      $("user-list"),
  selfName:      $("self-name"),
  selfStatus:    $("self-status"),
  selfAvatar:    $("self-avatar"),
  logoutBtn:     $("logout-btn"),
  headerRotator: $("header-rotator"),

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

  sidebar:       $("sidebar"),
  chatArea:      $("chat-area"),
  mobileBackBtn: $("mobile-back-btn"),

  pwaBanner:     $("pwa-banner"),
  pwaInstallBtn: $("pwa-install-btn"),
  pwaCloseBtn:   $("pwa-close-btn"),

  // Call overlay — voice
  callOverlay:   $("call-overlay"),
  voiceCallUi:   $("voice-call-ui"),
  videoCallUi:   $("video-call-ui"),
  callAvatar:    $("call-avatar"),
  callName:      $("call-name"),
  callStatus:    $("call-status"),
  callTimerEl:   $("call-timer"),
  endCallBtn:    $("end-call-btn"),
  endCallBtnV:   $("end-call-btn-v"),
  micToggleBtn:  $("mic-toggle-btn"),
  camToggleBtn:  $("cam-toggle-btn"),

  // Agora video containers (divs, not <video>)
  remoteVideoBox: $("remote-video-box"),
  localVideoBox:  $("local-video-box"),

  // Incoming call modal
  incomingCallModal:   $("incoming-call-modal"),
  incomingCallerName:  $("incoming-caller-name"),
  incomingCallTypeIcon:$("incoming-call-type-icon"),
  acceptCallBtn:       $("accept-call-btn"),
  rejectCallBtn:       $("reject-call-btn"),

  toastContainer: $("toast-container"),
};

// ══════════════════════════════════════════════════════
// SOUNDS (lazy-loaded)
// ══════════════════════════════════════════════════════
const Sounds = {
  _msg: null, _ringtone: null,
  get msg() {
    if (!this._msg) { this._msg = new Audio("message.mp3"); this._msg.volume = 0.6; }
    return this._msg;
  },
  get ringtone() {
    if (!this._ringtone) {
      this._ringtone = new Audio("ringtone.mp3");
      this._ringtone.loop = true; this._ringtone.volume = 0.7;
    }
    return this._ringtone;
  },
  playMsg()       { this.msg.currentTime = 0; this.msg.play().catch(() => {}); },
  startRingtone() { this.ringtone.currentTime = 0; this.ringtone.play().catch(() => {}); },
  stopRingtone()  { this.ringtone.pause(); this.ringtone.currentTime = 0; },
};

// ══════════════════════════════════════════════════════
// BROWSER NOTIFICATIONS
// ══════════════════════════════════════════════════════
async function requestNotifPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

function sendNotification(title, body) {
  if (!document.hidden) return;
  if (Notification.permission !== "granted") return;
  new Notification(title, { body, icon: "icon-192.png", badge: "icon-192.png" });
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
  return `${String(Math.floor(sec / 60)).padStart(2,"0")}:${String(sec % 60).padStart(2,"0")}`;
}

function getChatId(uid1, uid2) { return [uid1, uid2].sort().join("_"); }

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function showScreen(name) {
  DOM.auth.style.display = "none";
  DOM.app.style.display  = "none";
  if (name === "auth") { DOM.auth.style.display = "flex"; DOM.auth.classList.add("screen-fade-in"); }
  else if (name === "app") { DOM.app.style.display = "flex"; DOM.app.classList.add("screen-fade-in"); }
}

// ══════════════════════════════════════════════════════
// BRANDING — ROTATING HEADER SUBTITLE
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
// AUTH
// ══════════════════════════════════════════════════════
DOM.tabLogin.addEventListener("click", () => {
  DOM.tabLogin.classList.add("active"); DOM.tabSignup.classList.remove("active");
  DOM.formLogin.classList.remove("hidden"); DOM.formSignup.classList.add("hidden");
  DOM.loginError.classList.remove("visible");
});
DOM.tabSignup.addEventListener("click", () => {
  DOM.tabSignup.classList.add("active"); DOM.tabLogin.classList.remove("active");
  DOM.formSignup.classList.remove("hidden"); DOM.formLogin.classList.add("hidden");
  DOM.signupError.classList.remove("visible");
});

DOM.loginBtn.addEventListener("click", async () => {
  const email = DOM.loginEmail.value.trim(), pass = DOM.loginPass.value;
  if (!email || !pass) return showAuthError(DOM.loginError, "Please fill in all fields.");
  DOM.loginBtn.disabled = true;
  try { await signInWithEmailAndPassword(auth, email, pass); }
  catch (e) { showAuthError(DOM.loginError, friendlyAuthError(e.code)); DOM.loginBtn.disabled = false; }
});

DOM.signupBtn.addEventListener("click", async () => {
  const name = DOM.signupName.value.trim(), email = DOM.signupEmail.value.trim(), pass = DOM.signupPass.value;
  if (!name || !email || !pass) return showAuthError(DOM.signupError, "Please fill in all fields.");
  if (pass.length < 6) return showAuthError(DOM.signupError, "Password must be at least 6 characters.");
  DOM.signupBtn.disabled = true;
  try {
    const { user } = await createUserWithEmailAndPassword(auth, email, pass);
    await setDoc(doc(db, "users", user.uid), { name, email, uid: user.uid, createdAt: serverTimestamp() });
  } catch (e) { showAuthError(DOM.signupError, friendlyAuthError(e.code)); DOM.signupBtn.disabled = false; }
});

function showAuthError(el, msg) {
  el.textContent = msg; el.classList.add("visible");
  setTimeout(() => el.classList.remove("visible"), 4000);
}

function friendlyAuthError(code) {
  const map = {
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/email-already-in-use": "Email already registered.",
    "auth/weak-password": "Password is too weak.",
    "auth/invalid-email": "Invalid email address.",
    "auth/too-many-requests": "Too many attempts. Try again later.",
  };
  return map[code] || "Something went wrong. Please try again.";
}

[DOM.loginPass, DOM.loginEmail].forEach(el =>
  el.addEventListener("keydown", e => e.key === "Enter" && DOM.loginBtn.click()));
[DOM.signupPass, DOM.signupEmail, DOM.signupName].forEach(el =>
  el.addEventListener("keydown", e => e.key === "Enter" && DOM.signupBtn.click()));

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

    const presRef = ref(rtdb, `presence/${user.uid}`);
    await set(presRef, { online: true, lastSeen: rtdbTimestamp() });
    onDisconnect(presRef).set({ online: false, lastSeen: rtdbTimestamp() });

    await requestNotifPermission();
    initApp();
    showScreen("app");
  } else {
    await fullCleanup();
    DOM.loginBtn.disabled = DOM.signupBtn.disabled = false;
    showScreen("auth");
  }
});

async function fullCleanup() {
  if (state.messageListener)       { state.messageListener();       state.messageListener       = null; }
  if (state.userListener)          { state.userListener();          state.userListener          = null; }
  if (state.callListener)          { state.callListener();          state.callListener          = null; }
  if (state.incomingCallListener)  { state.incomingCallListener();  state.incomingCallListener  = null; }
  if (state.rotatorInterval)       { clearInterval(state.rotatorInterval); state.rotatorInterval = null; }
  if (state.typingTimeout)         { clearTimeout(state.typingTimeout);    state.typingTimeout   = null; }
  await cleanupAgoraCall();
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
  listenForIncomingCalls();
}

DOM.logoutBtn.addEventListener("click", async () => {
  if (state.currentUser) {
    await set(ref(rtdb, `presence/${state.currentUser.uid}`), { online: false, lastSeen: rtdbTimestamp() });
  }
  await signOut(auth);
});

// ══════════════════════════════════════════════════════
// USER LIST — real-time onSnapshot
// ══════════════════════════════════════════════════════
function listenToUsers() {
  if (state.userListener) { state.userListener(); state.userListener = null; }
  DOM.userList.innerHTML = `
    <div class="skeleton user-skeleton"></div>
    <div class="skeleton user-skeleton"></div>
    <div class="skeleton user-skeleton"></div>`;

  state.userListener = onSnapshot(collection(db, "users"), (snapshot) => {
    const users = [];
    snapshot.forEach(d => { if (d.id !== state.currentUser.uid) users.push({ uid: d.id, ...d.data() }); });
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
      <div class="avatar" id="av-${u.uid}">${initials(u.name)}<span class="status-dot" id="dot-${u.uid}"></span></div>
      <div class="user-info">
        <div class="user-name">${escapeHtml(u.name)}</div>
        <div class="user-status" id="status-text-${u.uid}">Offline</div>
      </div>`;

    onValue(ref(rtdb, `presence/${u.uid}`), snap => {
      const online = snap.val()?.online === true;
      presenceCache[u.uid] = online;
      const dot  = document.getElementById(`dot-${u.uid}`);
      const text = document.getElementById(`status-text-${u.uid}`);
      if (dot)  dot.className = `status-dot${online ? " online" : ""}`;
      if (text) { text.textContent = online ? "Online" : "Offline"; text.className = `user-status${online ? " online-text" : ""}`; }
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
  DOM.messagesContainer.innerHTML = "";

  if (state.messageListener) { state.messageListener(); state.messageListener = null; }
  listenToMessages();
  listenToTyping();
  openChatOnMobile();
  setTimeout(() => DOM.msgInput.focus(), 300);
}

// ══════════════════════════════════════════════════════
// 24H AUTO-DELETE (frontend layer)
// ══════════════════════════════════════════════════════
const MS_24H = 24 * 60 * 60 * 1000;
function isExpired(ts) {
  if (!ts) return false;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return Date.now() - d.getTime() > MS_24H;
}
async function deleteExpiredMsg(id) {
  try { await deleteDoc(doc(db, "chats", state.chatId, "messages", id)); } catch (_) {}
}

// ══════════════════════════════════════════════════════
// MESSAGES — real-time onSnapshot
// ══════════════════════════════════════════════════════
function listenToMessages() {
  const q = query(collection(db, "chats", state.chatId, "messages"), orderBy("createdAt", "asc"));
  let lastDate = null;

  state.messageListener = onSnapshot(q, snap => {
    snap.docChanges().forEach(change => {
      if (change.type === "added") {
        const data = { id: change.doc.id, ...change.doc.data() };
        if (isExpired(data.createdAt)) { deleteExpiredMsg(data.id); return; }

        const msgDate = data.createdAt
          ? data.createdAt.toDate().toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })
          : null;
        if (msgDate && msgDate !== lastDate) {
          lastDate = msgDate;
          const sep = document.createElement("div");
          sep.className = "date-sep"; sep.textContent = msgDate;
          DOM.messagesContainer.appendChild(sep);
        }

        appendMessage(data);

        if (data.senderId !== state.currentUser.uid) {
          Sounds.playMsg();
          sendNotification(data.senderName || "New Message", data.text.slice(0, 60));
        }
        scrollToBottom();
      }
      if (change.type === "removed") {
        const el = document.querySelector(`[data-msg-id="${change.doc.id}"]`);
        if (el) { el.style.animation = "msgFadeOut 0.2s ease forwards"; setTimeout(() => el.remove(), 220); }
      }
    });
  });
}

function appendMessage(data) {
  const isSent = data.senderId === state.currentUser.uid;
  const row    = document.createElement("div");
  row.className = `msg-row ${isSent ? "sent" : "received"}`;
  row.dataset.msgId = data.id;

  const deleteBtn = isSent
    ? `<button class="msg-delete-btn" data-id="${data.id}" title="Delete">
         <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
           <polyline points="3 6 5 6 21 6"/>
           <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
           <path d="M10 11v6M14 11v6M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
         </svg>
       </button>` : "";

  row.innerHTML = `${deleteBtn}<div class="bubble">${escapeHtml(data.text)}<div class="bubble-meta">${formatTime(data.createdAt)}</div></div>`;

  row.querySelector(".msg-delete-btn")?.addEventListener("click", async e => {
    e.stopPropagation();
    try { await deleteDoc(doc(db, "chats", state.chatId, "messages", e.currentTarget.dataset.id)); }
    catch (_) { toast("Could not delete message.", "error"); }
  });

  DOM.messagesContainer.appendChild(row);
}

function scrollToBottom() { DOM.messagesContainer.scrollTop = DOM.messagesContainer.scrollHeight; }

// ══════════════════════════════════════════════════════
// SEND MESSAGE
// ══════════════════════════════════════════════════════
async function sendMessage() {
  const text = DOM.msgInput.value.trim();
  if (!text || !state.chatId) return;
  DOM.msgInput.value = "";
  clearTypingInDB();
  try {
    await addDoc(collection(db, "chats", state.chatId, "messages"), {
      text, senderId: state.currentUser.uid,
      senderName: state.currentUserData.name,
      createdAt: serverTimestamp(),
    });
  } catch (e) { toast("Failed to send message.", "error"); }
}

DOM.sendBtn.addEventListener("click", sendMessage);
DOM.msgInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// ══════════════════════════════════════════════════════
// TYPING INDICATOR — RTDB: typing/{chatId}/{uid}
// ══════════════════════════════════════════════════════
function setTypingInDB(val) {
  if (!state.chatId) return;
  set(ref(rtdb, `typing/${state.chatId}/${state.currentUser.uid}`), val ? true : null);
}
function clearTypingInDB() { setTypingInDB(false); }

DOM.msgInput.addEventListener("input", () => {
  if (!state.chatId) return;
  setTypingInDB(true);
  clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(() => setTypingInDB(false), 1500);
});

function listenToTyping() {
  if (!state.chatId || !state.selectedUser) return;
  const theirRef = ref(rtdb, `typing/${state.chatId}/${state.selectedUser.uid}`);
  const handler  = snap => {
    const isTyping = snap.val() === true;
    if (DOM.chatTypingStatus) DOM.chatTypingStatus.textContent = isTyping ? "typing…" : "";
    if (DOM.typingIndicator)  { DOM.typingIndicator.classList.toggle("visible", isTyping); if (isTyping) scrollToBottom(); }
  };
  onValue(theirRef, handler);
  state.typingListener = { ref: theirRef, handler };
}

function stopTypingListener() {
  if (state.typingListener) { off(state.typingListener.ref, "value", state.typingListener.handler); state.typingListener = null; }
  clearTypingInDB();
}

// ══════════════════════════════════════════════════════
// ╔═════════════════════════════════════════════════╗
// ║  AGORA CALL SYSTEM — Tasks 1–9                 ║
// ║  Voice + Video calling via Agora RTC SDK       ║
// ║  Signaling via Firestore: calls/{callId}       ║
// ╚═════════════════════════════════════════════════╝
// ══════════════════════════════════════════════════════

// ── Helper: get or create Agora client ───────────────
// We create a new client per call and destroy after.
// Mode "rtc" for voice/video. Codec "vp8" is widely supported.
function createAgoraClient() {
  const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

  // Remote user joined → subscribe and play their track
  client.on("user-published", async (remoteUser, mediaType) => {
    await client.subscribe(remoteUser, mediaType);

    if (mediaType === "video") {
      // Play remote video in the designated container div
      remoteUser.videoTrack.play("remote-video-box");
      document.getElementById("remote-video-box")?.classList.add("has-stream");
    }
    if (mediaType === "audio") {
      remoteUser.audioTrack.play();
    }
  });

  client.on("user-unpublished", (remoteUser, mediaType) => {
    if (mediaType === "video") {
      document.getElementById("remote-video-box")?.classList.remove("has-stream");
    }
  });

  client.on("user-left", () => {
    // Remote peer left the channel — end the call
    endAgoraCall(false);
  });

  return client;
}

// ── TASK 1: Initiate a call ───────────────────────────
DOM.voiceCallBtn?.addEventListener("click", () => startCall("audio"));
DOM.videoCallBtn?.addEventListener("click", () => startCall("video"));

async function startCall(type) {
  if (!state.selectedUser) return;
  if (state.inCall) { toast("Already in a call.", "error"); return; }

  state.callType = type;
  state.isCaller = true;

  // channel = chatId (unique per pair of users)
  const channel = getChatId(state.currentUser.uid, state.selectedUser.uid);

  // Create Firestore signaling doc
  // status: "ringing" → "accepted" → "ended" | "rejected"
  const callRef = await addDoc(collection(db, "calls"), {
    callerId:    state.currentUser.uid,
    callerName:  state.currentUserData.name,
    receiverId:  state.selectedUser.uid,
    receiverName:state.selectedUser.name,
    type,
    channel,
    status:      "ringing",
    createdAt:   serverTimestamp(),
  });
  state.callId = callRef.id;

  // Show call UI with "Calling…" status
  showCallUI(type, "Calling…", state.selectedUser.name);

  // Join Agora channel immediately as caller
  await joinAgoraChannel(channel, type);

  // 20-second no-answer timeout (Task 9)
  state.callTimeoutTimer = setTimeout(async () => {
    toast("No answer.", "info");
    await endAgoraCall(true);
  }, 20000);

  // Watch for receiver's response
  state.callListener = onSnapshot(callRef, async snap => {
    const data = snap.data();
    if (!data) return;

    if (data.status === "accepted") {
      clearTimeout(state.callTimeoutTimer);
      DOM.callStatus.textContent = "Connected";
      startCallTimer();
    }

    if (data.status === "rejected") {
      clearTimeout(state.callTimeoutTimer);
      toast(`${state.selectedUser.name} declined the call.`, "error");
      await endAgoraCall(false);
    }

    if (data.status === "ended") {
      clearTimeout(state.callTimeoutTimer);
      await endAgoraCall(false);
    }
  });
}

// ── TASK 2: Listen for incoming calls ────────────────
function listenForIncomingCalls() {
  if (state.incomingCallListener) { state.incomingCallListener(); state.incomingCallListener = null; }

  // Query: calls where I am the receiver and status is "ringing"
  const q = query(
    collection(db, "calls"),
    where("receiverId", "==", state.currentUser.uid),
    where("status",     "==", "ringing"),
    limit(1)
  );

  state.incomingCallListener = onSnapshot(q, snap => {
    snap.docChanges().forEach(change => {
      if (change.type === "added") {
        if (state.inCall) {
          // Already in a call — auto-reject
          updateDoc(doc(db, "calls", change.doc.id), { status: "rejected" }).catch(() => {});
          return;
        }
        const data = change.doc.data();
        state.incomingCallId   = change.doc.id;
        state.incomingCallData = data;

        // TASK 3: play ringtone
        Sounds.startRingtone();

        // Show incoming call popup
        showIncomingModal(data.callerName, data.type);

        // Browser notification
        sendNotification(
          `Incoming ${data.type === "video" ? "Video" : "Voice"} Call`,
          `${data.callerName} is calling you`
        );
      }

      if (change.type === "removed" || change.type === "modified") {
        // Caller cancelled or call ended before answer
        Sounds.stopRingtone();
        hideIncomingModal();
      }
    });
  });
}

// ── Accept incoming call ─────────────────────────────
DOM.acceptCallBtn?.addEventListener("click", async () => {
  if (!state.incomingCallId || !state.incomingCallData) return;

  Sounds.stopRingtone();
  hideIncomingModal();

  const { callId, data } = { callId: state.incomingCallId, data: state.incomingCallData };
  state.callId   = callId;
  state.callType = data.type;
  state.isCaller = false;

  // Show call UI
  showCallUI(data.type, "Connecting…", data.callerName);

  // Join same Agora channel
  await joinAgoraChannel(data.channel, data.type);

  // Update Firestore: status → accepted
  await updateDoc(doc(db, "calls", callId), { status: "accepted" });
  DOM.callStatus.textContent = "Connected";
  startCallTimer();

  // Watch for caller ending the call
  state.callListener = onSnapshot(doc(db, "calls", callId), snap => {
    if (snap.data()?.status === "ended") endAgoraCall(false);
  });
});

// ── TASK 9: Reject incoming call ─────────────────────
DOM.rejectCallBtn?.addEventListener("click", async () => {
  Sounds.stopRingtone();
  hideIncomingModal();
  if (state.incomingCallId) {
    try { await updateDoc(doc(db, "calls", state.incomingCallId), { status: "rejected" }); }
    catch (_) {}
    state.incomingCallId   = null;
    state.incomingCallData = null;
  }
});

// ══════════════════════════════════════════════════════
// TASK 4: JOIN AGORA CHANNEL
// Creates client, publishes local tracks, plays remote
// ══════════════════════════════════════════════════════
async function joinAgoraChannel(channel, type) {
  // Guard: prevent double-join
  if (state.inCall) return;
  state.inCall = true;

  try {
    // Create fresh Agora client
    agoraClient = createAgoraClient();

    // Join: appId, channel, token (null = testing mode), uid (null = auto)
    await agoraClient.join(AGORA_APP_ID, channel, null, null);

    if (type === "audio") {
      // Voice call — microphone only
      localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
      await agoraClient.publish([localAudioTrack]);

    } else {
      // Video call — mic + camera
      [localAudioTrack, localVideoTrack] = await AgoraRTC.createMicrophoneAndCameraTracks();
      await agoraClient.publish([localAudioTrack, localVideoTrack]);

      // Play local video preview in corner box
      localVideoTrack.play("local-video-box");
    }

    console.log("[Agora] Joined channel:", channel);

  } catch (err) {
    console.error("[Agora] Join failed:", err);
    toast("Could not start call. Check permissions.", "error");
    await endAgoraCall(false);
  }
}

// ══════════════════════════════════════════════════════
// TASK 6 + 8: END CALL
// Leaves Agora, updates Firestore, cleans DOM
// ══════════════════════════════════════════════════════
DOM.endCallBtn?.addEventListener("click",  () => endAgoraCall(true));
DOM.endCallBtnV?.addEventListener("click", () => endAgoraCall(true));

async function endAgoraCall(notifyFirestore = true) {
  Sounds.stopRingtone();
  clearTimeout(state.callTimeoutTimer);
  state.callTimeoutTimer = null;

  // TASK 7: update Firestore so the other side auto-closes
  if (notifyFirestore && state.callId) {
    try { await updateDoc(doc(db, "calls", state.callId), { status: "ended" }); }
    catch (_) {}
  }

  await cleanupAgoraCall();
  hideCallUI();
}

// ══════════════════════════════════════════════════════
// TASK 8 + 9: CLEANUP — no memory leaks
// ══════════════════════════════════════════════════════
async function cleanupAgoraCall() {
  // Stop and close local tracks
  if (localAudioTrack) { localAudioTrack.stop(); localAudioTrack.close(); localAudioTrack = null; }
  if (localVideoTrack) { localVideoTrack.stop(); localVideoTrack.close(); localVideoTrack = null; }

  // Leave Agora channel
  if (agoraClient) {
    try { await agoraClient.leave(); } catch (_) {}
    agoraClient.removeAllListeners();
    agoraClient = null;
  }

  // Clean video container divs
  const rb = document.getElementById("remote-video-box");
  const lb = document.getElementById("local-video-box");
  if (rb) { rb.innerHTML = ""; rb.classList.remove("has-stream"); }
  if (lb) { lb.innerHTML = ""; }

  // Unsubscribe Firestore call listener
  if (state.callListener) { state.callListener(); state.callListener = null; }

  // Reset call state
  clearInterval(state.callTimer);
  state.callTimer   = null;
  state.callSeconds = 0;
  state.callId      = null;
  state.callType    = null;
  state.isCaller    = false;
  state.micMuted    = false;
  state.camOff      = false;
  state.inCall      = false;
  state.incomingCallId   = null;
  state.incomingCallData = null;
}

// ══════════════════════════════════════════════════════
// CALL UI HELPERS
// ══════════════════════════════════════════════════════
function showCallUI(type, statusText, peerName = "") {
  DOM.callOverlay.classList.add("active");
  if (DOM.callName)   DOM.callName.textContent   = peerName;
  if (DOM.callAvatar) DOM.callAvatar.textContent = initials(peerName);
  if (DOM.callStatus) DOM.callStatus.textContent = statusText;
  if (DOM.callTimerEl) DOM.callTimerEl.textContent = "00:00";

  DOM.voiceCallUi.style.display = type === "audio" ? "flex" : "none";
  DOM.videoCallUi.style.display = type === "video" ? "flex" : "none";
}

function hideCallUI() {
  DOM.callOverlay.classList.remove("active");
  if (DOM.callTimerEl) DOM.callTimerEl.textContent = "00:00";
  DOM.micToggleBtn?.classList.remove("active");
  DOM.camToggleBtn?.classList.remove("active");
}

function startCallTimer() {
  clearInterval(state.callTimer);
  state.callSeconds = 0;
  state.callTimer = setInterval(() => {
    state.callSeconds++;
    if (DOM.callTimerEl) DOM.callTimerEl.textContent = formatTimer(state.callSeconds);
  }, 1000);
}

// ── Incoming call modal ──────────────────────────────
function showIncomingModal(callerName, type) {
  if (!DOM.incomingCallModal) return;
  if (DOM.incomingCallerName)   DOM.incomingCallerName.textContent   = callerName;
  if (DOM.incomingCallTypeIcon) DOM.incomingCallTypeIcon.textContent = type === "video" ? "📹" : "📞";
  DOM.incomingCallModal.classList.add("active");
}

function hideIncomingModal() {
  DOM.incomingCallModal?.classList.remove("active");
}

// ── Mic toggle ───────────────────────────────────────
DOM.micToggleBtn?.addEventListener("click", () => {
  state.micMuted = !state.micMuted;
  if (localAudioTrack) localAudioTrack.setEnabled(!state.micMuted);
  DOM.micToggleBtn.classList.toggle("active", state.micMuted);
  DOM.micToggleBtn.title = state.micMuted ? "Unmute mic" : "Mute mic";
});

// ── Camera toggle ────────────────────────────────────
DOM.camToggleBtn?.addEventListener("click", () => {
  state.camOff = !state.camOff;
  if (localVideoTrack) localVideoTrack.setEnabled(!state.camOff);
  DOM.camToggleBtn.classList.toggle("active", state.camOff);
  DOM.camToggleBtn.title = state.camOff ? "Turn on camera" : "Turn off camera";
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
// PWA INSTALL — localStorage, once only
// ══════════════════════════════════════════════════════
let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!localStorage.getItem("pwaPromptShown")) DOM.pwaBanner.style.display = "flex";
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
