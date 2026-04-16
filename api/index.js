const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const app = express();

// Middleware
app.use(cors({ origin: "*", methods: ["GET", "POST"], credentials: true }));

app.use((req, res, next) => {
  if (req.body) return next();
  express.json({ limit: "10mb" })(req, res, next);
});

//  Firebase Init
let db;
try {
  console.log("Initializing Firebase...");

  let serviceAccount;
  const localPath = path.join(__dirname, "../serviceAccountKey.json");

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.log("Using Firebase credentials from environment variable");
    let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    try {
      serviceAccount = JSON.parse(raw);
    } catch (e) {
      const decoded = Buffer.from(raw, "base64").toString("utf-8");
      serviceAccount = JSON.parse(decoded);
    }
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(
        /\\n/g,
        "\n",
      );
    }
  } else if (fs.existsSync(localPath)) {
    console.log("Using local serviceAccountKey.json file");
    serviceAccount = require(localPath);
  } else {
    throw new Error("Firebase credentials not found.");
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  db = admin.firestore();
  console.log("Firebase initialized ✅");
} catch (err) {
  console.error("Firebase initialization error:", err);
}

//  Helpers
function calculateStdDev(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => Math.pow(v - mean, 2) + sum, 0) / values.length;
  return Math.sqrt(variance);
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

//  Routes

app.get("/", (req, res) => {
  res.json({
    status: "Tap Logger API is running",
    endpoints: {
      saveTaps: "POST /saveTaps",
      stats: "GET /stats/:sessionId",
      analytics: "GET /analytics",
    },
  });
});

// Save taps
app.post("/saveTaps", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Database not initialized" });

  try {
    const { id, var: deviceType, taps } = req.body;

    if (!id || !deviceType || !taps) {
      return res
        .status(400)
        .json({ error: "Missing fields: id, var (deviceType), taps" });
    }

    let tapArray = [];
    try {
      if (Array.isArray(taps)) {
        tapArray = taps;
      } else if (typeof taps === "string") {
        tapArray = JSON.parse(taps);
      }
    } catch (err) {
      return res
        .status(400)
        .json({ error: "Invalid taps format", details: err.message });
    }

    const interfaceValue =
      tapArray.length > 0 ? tapArray[0].interface || "unknown" : "unknown";

    const sessionRef = db.collection("tap_sessions").doc(id);
    await sessionRef.set(
      {
        sessionId: id,
        deviceType,
        totalTaps: tapArray.length,
        interface: interfaceValue,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const batch = db.batch();
    tapArray.forEach((tap, index) => {
      const tapRef = db.collection("tap_logs").doc();
      batch.set(tapRef, {
        sessionId: id,
        deviceType,
        tapSequenceNumber: tap.tapSequenceNumber || index + 1,
        startTimestamp: tap.startTimestamp || null,
        endTimestamp: tap.endTimestamp || null,
        duration:
          (tap.endTimestamp || Date.now()) - (tap.startTimestamp || Date.now()),
        interface: tap.interface || "unknown",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();

    res.json({ success: true, sessionId: id, tapsCount: tapArray.length });
  } catch (err) {
    console.error("Error saving taps:", err);
    res
      .status(500)
      .json({ error: "Failed to save taps", details: err.message });
  }
});

// Stats endpoint
app.get("/stats/:sessionId", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Database not initialized" });

  try {
    const { sessionId } = req.params;
    const sessionDoc = await db.collection("tap_sessions").doc(sessionId).get();
    if (!sessionDoc.exists)
      return res.status(404).json({ error: "Session not found" });

    const tapsSnapshot = await db
      .collection("tap_logs")
      .where("sessionId", "==", sessionId)
      .get();

    const taps = tapsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({
      session: { id: sessionDoc.id, ...sessionDoc.data() },
      taps,
      count: taps.length,
    });
  } catch (err) {
    console.error("Error fetching stats:", err);
    res
      .status(500)
      .json({ error: "Failed to fetch stats", details: err.message });
  }
});

//  Analytics Endpoint
app.get("/analytics", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Database not initialized" });

  try {
    // --- Query 1: Device Performance ---
    const tapsSnapshot = await db.collection("tap_logs").get();
    let androidDurations = [];
    let pcDurations = [];

    tapsSnapshot.forEach((doc) => {
      const data = doc.data();
      if (!data.deviceType || !data.duration || data.duration <= 0) return;
      if (data.deviceType === "mobile") androidDurations.push(data.duration);
      else if (data.deviceType === "pc") pcDurations.push(data.duration);
    });

    // --- Query 2: Interface Types ---
    const feedbackSnapshot = await db
      .collection("tap_logs")
      .where("interface", "==", "feedbackshown")
      .get();
    const noFeedbackSnapshot = await db
      .collection("tap_logs")
      .where("interface", "==", "nofeedback")
      .get();

    let feedbackDurations = [];
    let noFeedbackDurations = [];

    feedbackSnapshot.forEach((doc) => {
      const d = doc.data();
      if (d.duration > 0) feedbackDurations.push(d.duration);
    });
    noFeedbackSnapshot.forEach((doc) => {
      const d = doc.data();
      if (d.duration > 0) noFeedbackDurations.push(d.duration);
    });

    // --- Query 3: User Completion ---
    const sessionsSnapshot = await db.collection("tap_sessions").get();
    const userMap = {};
    sessionsSnapshot.forEach((doc) => {
      const data = doc.data();
      const userId = data.sessionId.split("_")[0];
      if (!userMap[userId]) userMap[userId] = { totalTaps: 0, sessions: [] };
      userMap[userId].totalTaps += data.totalTaps || 0;
      userMap[userId].sessions.push(data.sessionId);
    });

    let completedBoth = 0;
    let droppedAfterFirst = 0;

    for (const userId in userMap) {
      const total = userMap[userId].totalTaps;
      if (total >= 100) completedBoth++;
      else if (total >= 50) droppedAfterFirst++;
    }

    // --- Response ---
    res.json({
      devicePerformance: {
        android: {
          totalTaps: androidDurations.length,
          meanDuration: parseFloat(mean(androidDurations).toFixed(2)),
          stdDeviation: parseFloat(
            calculateStdDev(androidDurations).toFixed(2),
          ),
          min: androidDurations.length ? Math.min(...androidDurations) : 0,
          max: androidDurations.length ? Math.max(...androidDurations) : 0,
        },
        pc: {
          totalTaps: pcDurations.length,
          meanDuration: parseFloat(mean(pcDurations).toFixed(2)),
          stdDeviation: parseFloat(calculateStdDev(pcDurations).toFixed(2)),
          min: pcDurations.length ? Math.min(...pcDurations) : 0,
          max: pcDurations.length ? Math.max(...pcDurations) : 0,
        },
      },
      interfaceComparison: {
        feedback: {
          totalTaps: feedbackDurations.length,
          meanDuration: parseFloat(mean(feedbackDurations).toFixed(2)),
          stdDeviation: parseFloat(
            calculateStdDev(feedbackDurations).toFixed(2),
          ),
          min: feedbackDurations.length ? Math.min(...feedbackDurations) : 0,
          max: feedbackDurations.length ? Math.max(...feedbackDurations) : 0,
        },
        noFeedback: {
          totalTaps: noFeedbackDurations.length,
          meanDuration: parseFloat(mean(noFeedbackDurations).toFixed(2)),
          stdDeviation: parseFloat(
            calculateStdDev(noFeedbackDurations).toFixed(2),
          ),
          min: noFeedbackDurations.length
            ? Math.min(...noFeedbackDurations)
            : 0,
          max: noFeedbackDurations.length
            ? Math.max(...noFeedbackDurations)
            : 0,
        },
      },
      userCompletion: {
        totalUsers: Object.keys(userMap).length,
        completedBoth,
        droppedAfterFirst,
      },
    });
  } catch (err) {
    console.error("Error fetching analytics:", err);
    res
      .status(500)
      .json({ error: "Failed to fetch analytics", details: err.message });
  }
});

//  Vercel Serverless Handler
module.exports = (req, res) => {
  if (req.body && Buffer.isBuffer(req.body)) {
    try {
      req.body = JSON.parse(req.body.toString("utf8"));
    } catch (_) {
      req.body = {};
    }
  }
  return app(req, res);
};
