const { openStorage } = require("./storage_cli");

const EVENT_WEIGHTS = {
  homework_grade_confirmed: 0.45,
  knowledge_test_evaluate: 0.35,
  dify_diagnosis: 0.25,
  ai_diagnosis: 0.22,
  ai_question: 0.12,
  manual_mastery_update: 0.2,
  legacy_mastery_evidence: 0.15,
  wrong_note: 0.08
};

function normalizeScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  if (score > 1 && score <= 100) return Number((score / 100).toFixed(4));
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

function masteryStatus(score) {
  if (score < 0.35) return "未掌握";
  if (score < 0.58) return "模糊";
  if (score < 0.78) return "基本掌握";
  return "精通";
}

function ensureProfile(db, userId) {
  db.learningProfiles = Array.isArray(db.learningProfiles) ? db.learningProfiles : [];
  let profile = db.learningProfiles.find((item) => item.userId === userId);
  if (!profile) {
    const user = (db.users || []).find((item) => item.id === userId) || {};
    profile = {
      userId,
      role: user.role || "student",
      level: "待诊断",
      goals: [],
      questionCount: 0,
      practiceCount: 0,
      gradedCount: 0,
      studyMinutes: 0,
      mastery: {},
      weakPoints: [],
      recentActivity: [],
      updatedAt: new Date().toISOString()
    };
    db.learningProfiles.push(profile);
  }
  profile.mastery = profile.mastery && typeof profile.mastery === "object" ? profile.mastery : {};
  profile.weakPoints = Array.isArray(profile.weakPoints) ? profile.weakPoints : [];
  return profile;
}

function aggregate(db) {
  const events = Array.isArray(db.learningEvents) ? db.learningEvents : [];
  const groups = new Map();
  events.forEach((event) => {
    const score = normalizeScore(event.score);
    const studentId = String(event.studentId || "").trim();
    const topic = String(event.knowledgePoint || "").trim();
    if (!studentId || !topic || score === null) return;
    const subject = String(event.subject || "").trim();
    const key = `${studentId}\u0000${subject}\u0000${topic}`;
    if (!groups.has(key)) {
      groups.set(key, {
        studentId,
        subject,
        knowledgePoint: topic,
        graphId: event.graphId || "",
        nodeId: event.nodeId || "",
        weightedScore: 0,
        totalWeight: 0,
        evidenceCount: 0,
        lastEventId: "",
        updatedAt: ""
      });
    }
    const group = groups.get(key);
    const weight = EVENT_WEIGHTS[event.eventType] || 0.1;
    group.weightedScore += score * weight;
    group.totalWeight += weight;
    group.evidenceCount += 1;
    if (String(event.occurredAt || event.createdAt || "") >= String(group.updatedAt || "")) {
      group.lastEventId = event.id || "";
      group.updatedAt = event.occurredAt || event.createdAt || new Date().toISOString();
      group.graphId = event.graphId || group.graphId;
      group.nodeId = event.nodeId || group.nodeId;
    }
  });

  const snapshots = Array.from(groups.values()).map((group) => {
    const score = group.totalWeight ? Number((group.weightedScore / group.totalWeight).toFixed(4)) : null;
    return {
      studentId: group.studentId,
      subject: group.subject,
      knowledgePoint: group.knowledgePoint,
      graphId: group.graphId,
      nodeId: group.nodeId,
      score,
      status: score === null ? "待诊断" : masteryStatus(score),
      evidenceCount: group.evidenceCount,
      lastEventId: group.lastEventId,
      updatedAt: group.updatedAt || new Date().toISOString()
    };
  });

  db.studentMastery = snapshots;
  snapshots.forEach((snapshot) => {
    const profile = ensureProfile(db, snapshot.studentId);
    profile.mastery[snapshot.knowledgePoint] = {
      score: snapshot.score,
      status: snapshot.status,
      evidence: [{
        text: `Aggregated from ${snapshot.evidenceCount} learning events`,
        at: snapshot.updatedAt
      }],
      updatedAt: snapshot.updatedAt
    };
    const weak = new Set(profile.weakPoints || []);
    if (Number(snapshot.score || 0) < 0.58) weak.add(snapshot.knowledgePoint);
    else weak.delete(snapshot.knowledgePoint);
    profile.weakPoints = Array.from(weak).slice(0, 12);
    profile.updatedAt = new Date().toISOString();
  });

  return snapshots;
}

function main() {
  const store = openStorage();
  try {
    const db = store.read();
    const snapshots = aggregate(db);
    store.write(db);
    console.log(`student mastery snapshots: ${snapshots.length}`);
    console.log(`database updated: ${store.metadata().path}`);
  } finally {
    store.close?.();
  }
}

main();
