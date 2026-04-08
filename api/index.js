const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const app = express();

// Middleware
app.use(cors({ origin: "*", methods: ["GET", "POST"], credentials: true }));

// Guard against double body parsing (Vercel pre-parses the body)
app.use((req, res, next) => {
  if (req.body) return next();
  express.json({ limit: "10mb" })(req, res, next);
});

// ---------------- Firebase Init ----------------
let db;
try {
  console.log("Initializing Firebase...");

  let serviceAccount;

  // Use local serviceAccountKey.json if exists
  const localPath = path.join(__dirname, "../serviceAccountKey.json");
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Production: use environment variable
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
  } else if (fs.existsSync(path.join(__dirname, "../serviceAccountKey.json"))) {
    // Local development: use local file
    console.log("Using local serviceAccountKey.json file");
    serviceAccount = require(path.join(__dirname, "../serviceAccountKey.json"));
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

// ---------------- Routes ----------------

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "Tap Logger API is running",
    endpoints: {
      saveTaps: "POST /saveTaps",
      stats: "GET /stats/:sessionId",
    },
  });
});

// Save taps
app.post("/saveTaps", async (req, res) => {
  try {
    const { id, var: deviceType, taps } = req.body;

    if (!id || !deviceType || !taps) {
      return res
        .status(400)
        .json({ error: "Missing fields: id, var (deviceType), taps" });
    }

    // Parse taps
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

    // Save session
    const sessionRef = db.collection("tap_sessions").doc(id);
    await sessionRef.set(
      {
        sessionId: id,
        deviceType,
        totalTaps: tapArray.length,
        interfaceVariations: [
          ...new Set(tapArray.map((t) => t.interface || "unknown")),
        ],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // Save individual taps
    const batch = db.batch();
    tapArray.forEach((tap, index) => {
      const tapRef = db.collection("tap_logs").doc();
      batch.set(tapRef, {
        sessionId: id,
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

    res.json({
      success: true,
      sessionId: id,
      tapsCount: tapArray.length,
    });
  } catch (err) {
    console.error("Error saving taps:", err);
    res
      .status(500)
      .json({ error: "Failed to save taps", details: err.message });
  }
});

// Stats endpoint
app.get("/stats/:sessionId", async (req, res) => {
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

// ---------------- Vercel Serverless Handler ----------------
module.exports = (req, res) => {
  // Vercel may send body as a Buffer — ensure it's parsed
  if (req.body && Buffer.isBuffer(req.body)) {
    try {
      req.body = JSON.parse(req.body.toString("utf8"));
    } catch (_) {
      req.body = {};
    }
  }
  return app(req, res);
};
