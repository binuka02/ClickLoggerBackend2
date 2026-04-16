const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

//  Firebase Init
try {
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
    throw new Error(
      "Firebase credentials not found. Provide serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT env var.",
    );
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  console.log("Firebase Admin initialized successfully\n");
} catch (error) {
  console.error("Error initializing Firebase Admin:", error.message);
  process.exit(1);
}

const db = admin.firestore();

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

//  QUERY 1
async function compareDevicePerformance() {
  console.log("=== QUERY 1: Android vs PC Tap Duration Analysis ===\n");

  const tapsSnapshot = await db.collection("tap_logs").get();
  let androidDurations = [];
  let pcDurations = [];

  tapsSnapshot.forEach((doc) => {
    const data = doc.data();
    if (!data.deviceType || !data.duration || data.duration <= 0) return;
    if (data.deviceType === "mobile") androidDurations.push(data.duration);
    else if (data.deviceType === "pc") pcDurations.push(data.duration);
  });

  console.log(` Android Users:`);
  console.log(`   Total taps      : ${androidDurations.length}`);
  console.log(`   Mean duration   : ${mean(androidDurations).toFixed(2)} ms`);
  console.log(
    `   Min             : ${androidDurations.length ? Math.min(...androidDurations) : 0} ms`,
  );
  console.log(
    `   Max             : ${androidDurations.length ? Math.max(...androidDurations) : 0} ms`,
  );

  console.log(`\n PC Users:`);
  console.log(`   Total taps      : ${pcDurations.length}`);
  console.log(`   Mean duration   : ${mean(pcDurations).toFixed(2)} ms`);
  console.log(
    `   Min             : ${pcDurations.length ? Math.min(...pcDurations) : 0} ms`,
  );
  console.log(
    `   Max             : ${pcDurations.length ? Math.max(...pcDurations) : 0} ms`,
  );

  console.log("\n" + "=".repeat(60) + "\n");
}

//  QUERY 2
async function compareInterfaceTypes() {
  console.log("=== QUERY 2: Feedback vs No-Feedback Interface Analysis ===\n");

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

  console.log(` Feedback Interface:`);
  console.log(`   Total taps      : ${feedbackDurations.length}`);
  console.log(`   Mean duration   : ${mean(feedbackDurations).toFixed(2)} ms`);
  console.log(
    `   Min             : ${feedbackDurations.length ? Math.min(...feedbackDurations) : 0} ms`,
  );
  console.log(
    `   Max             : ${feedbackDurations.length ? Math.max(...feedbackDurations) : 0} ms`,
  );

  console.log(`\n No Feedback Interface:`);
  console.log(`   Total taps      : ${noFeedbackDurations.length}`);
  console.log(
    `   Mean duration   : ${mean(noFeedbackDurations).toFixed(2)} ms`,
  );
  console.log(
    `   Min             : ${noFeedbackDurations.length ? Math.min(...noFeedbackDurations) : 0} ms`,
  );
  console.log(
    `   Max             : ${noFeedbackDurations.length ? Math.max(...noFeedbackDurations) : 0} ms`,
  );

  console.log("\n" + "=".repeat(60) + "\n");
}

//  QUERY 3
async function analyzeUserCompletion() {
  console.log("=== QUERY 3: User Completion Analysis ===\n");

  const sessionsSnapshot = await db.collection("tap_sessions").get();
  const userMap = {};

  sessionsSnapshot.forEach((doc) => {
    const data = doc.data();
    const sessionId = data.sessionId;
    const userId = sessionId.split("_")[0];

    if (!userMap[userId]) {
      userMap[userId] = { totalTaps: 0, sessions: [] };
    }

    userMap[userId].totalTaps += data.totalTaps || 0;
    userMap[userId].sessions.push(sessionId);
  });

  let completedBoth = 0;
  let droppedAfterFirst = 0;
  let incomplete = 0;

  for (const userId in userMap) {
    const total = userMap[userId].totalTaps;
    if (total >= 100) completedBoth++;
    else if (total >= 40) droppedAfterFirst++;
    else incomplete++;
  }

  const totalUsers = Object.keys(userMap).length;

  console.log(` Total users                        : ${totalUsers}`);
  console.log(` Completed both rounds (≥100 taps)  : ${completedBoth}`);
  console.log(` Dropped after first round (40–99)  : ${droppedAfterFirst}`);
  console.log(` Incomplete (<40 taps)              : ${incomplete}`);

  console.log("\n" + "=".repeat(60) + "\n");
}

//  Run
async function runAllAnalyses() {
  console.log("\n" + "=".repeat(60));
  console.log("   TAP LOGGER DATA ANALYSIS");
  console.log("=".repeat(60) + "\n");

  try {
    await compareDevicePerformance();
    await compareInterfaceTypes();
    await analyzeUserCompletion();

    console.log(" Analysis Complete!");
    process.exit(0);
  } catch (err) {
    console.error(" Error:", err);
    process.exit(1);
  }
}

runAllAnalyses();
