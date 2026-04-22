// ═══════════════════════════════════════════════════════
// functions/index.js — Nexus Chat · Cloud Functions v2
//
// Function 1: deleteExpiredMessages  — runs every hour
//   Deletes messages older than 24h from all chats
//
// Function 2: cleanupStaleCalls — runs every 15 mins
//   Deletes call docs older than 10 minutes (missed/hung calls)
//
// DEPLOY:
//   firebase init functions  → pick JavaScript
//   cd functions && npm install
//   firebase deploy --only functions
// ═══════════════════════════════════════════════════════

const { onSchedule }    = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

// ── Helper: batch-delete an array of doc refs ─────────
async function batchDelete(docs) {
  if (!docs.length) return 0;
  const BATCH_SIZE = 400; // well under Firestore 500 limit
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    docs.slice(i, i + BATCH_SIZE).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  return docs.length;
}

// ══════════════════════════════════════════════════════
// FUNCTION 1 — Delete messages older than 24h
// Runs: every 60 minutes
// ══════════════════════════════════════════════════════
exports.deleteExpiredMessages = onSchedule(
  {
    schedule:  "every 60 minutes",
    timeZone:  "Asia/Kolkata",
    memory:    "256MiB",
  },
  async () => {
    const cutoff = Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
    console.log(`[msg-cleanup] Cutoff: ${cutoff.toDate().toISOString()}`);

    const chatDocs = await db.collection("chats").listDocuments();
    let totalDeleted = 0;

    await Promise.all(
      chatDocs.map(async (chatRef) => {
        const snap = await chatRef
          .collection("messages")
          .where("createdAt", "<", cutoff)
          .get();
        if (snap.empty) return;
        const deleted = await batchDelete(snap.docs);
        totalDeleted += deleted;
        if (deleted > 0) console.log(`[msg-cleanup] ${chatRef.id}: −${deleted} msgs`);
      })
    );

    console.log(`[msg-cleanup] Done. Total: −${totalDeleted}`);
  }
);

// ══════════════════════════════════════════════════════
// FUNCTION 2 — Clean up stale call documents
// A call doc older than 10min with status != "ended"
// means the caller closed the tab mid-call. Mark ended.
// Runs: every 15 minutes
// ══════════════════════════════════════════════════════
exports.cleanupStaleCalls = onSchedule(
  {
    schedule:  "every 15 minutes",
    timeZone:  "Asia/Kolkata",
    memory:    "128MiB",
  },
  async () => {
    const cutoff = Timestamp.fromMillis(Date.now() - 10 * 60 * 1000); // 10 min ago

    const staleCalls = await db
      .collection("calls")
      .where("createdAt", "<", cutoff)
      .where("status", "in", ["calling", "accepted"])
      .get();

    if (staleCalls.empty) {
      console.log("[call-cleanup] No stale calls.");
      return;
    }

    const batch = db.batch();
    staleCalls.docs.forEach(d => batch.update(d.ref, { status: "ended" }));
    await batch.commit();
    console.log(`[call-cleanup] Marked ${staleCalls.size} stale call(s) as ended.`);
  }
);
