// ═══════════════════════════════════════════════════════
// functions/index.js — Nexus Chat · Cloud Functions
//
// TASK 4: Scalable 24h message auto-delete
// Runs every hour via Firebase Scheduled Functions
//
// SETUP:
//   1. npm install -g firebase-tools
//   2. firebase init functions  (choose JavaScript)
//   3. Replace functions/index.js with this file
//   4. npm install in functions/ folder
//   5. firebase deploy --only functions
// ═══════════════════════════════════════════════════════

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp }  = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

// ── Runs every hour ───────────────────────────────────
exports.deleteExpiredMessages = onSchedule(
  {
    schedule: "every 60 minutes",
    timeZone: "Asia/Kolkata",   // adjust to your timezone
    memory: "256MiB",
  },
  async () => {
    const now      = Date.now();
    const cutoff   = Timestamp.fromMillis(now - 24 * 60 * 60 * 1000); // 24h ago

    console.log(`[cleanup] Running at ${new Date().toISOString()}`);
    console.log(`[cleanup] Deleting messages older than ${cutoff.toDate().toISOString()}`);

    // Get all chat documents
    const chatsSnap = await db.collection("chats").listDocuments();
    let totalDeleted = 0;

    // Process each chat in parallel
    await Promise.all(
      chatsSnap.map(async (chatRef) => {
        // Query expired messages in this chat
        const expiredSnap = await chatRef
          .collection("messages")
          .where("createdAt", "<", cutoff)
          .get();

        if (expiredSnap.empty) return;

        // Batch delete (max 500 per batch)
        const BATCH_SIZE = 400;
        const docs = expiredSnap.docs;

        for (let i = 0; i < docs.length; i += BATCH_SIZE) {
          const batch = db.batch();
          docs.slice(i, i + BATCH_SIZE).forEach(d => batch.delete(d.ref));
          await batch.commit();
        }

        totalDeleted += docs.length;
        console.log(`[cleanup] ${chatRef.id}: deleted ${docs.length} messages`);
      })
    );

    console.log(`[cleanup] Done. Total deleted: ${totalDeleted}`);
  }
);
