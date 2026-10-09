function clamp(value, min = 0.08, max = 0.98) {
  return Math.max(min, Math.min(max, value));
}

function masteryStatus(score) {
  if (score < 0.35) return "未掌握";
  if (score < 0.58) return "模糊";
  if (score < 0.78) return "基本掌握";
  return "精通";
}

function applyWeightedMasteryEvidence(current = {}, evidence = {}) {
  const prior = Number.isFinite(Number(current.score)) ? Number(current.score) : 0.52;
  const score = evidence.score === null || evidence.score === undefined || evidence.score === "" ? NaN : Number(evidence.score);
  const weight = Math.max(0.05, Math.min(1, Number(evidence.weight || 0.2)));
  const history = Array.isArray(current.evidence) ? current.evidence.slice(-11) : [];
  const usableScore = Number.isFinite(score) ? clamp(score, 0, 1) : prior;
  const weightedScore = clamp((prior * (1 - weight)) + (usableScore * weight));
  history.push({
    text: String(evidence.text || "学习证据").slice(0, 300),
    source: String(evidence.source || "learning_event").slice(0, 80),
    score: Number(usableScore.toFixed(4)),
    weight: Number(weight.toFixed(3)),
    at: evidence.at || new Date().toISOString()
  });
  return {
    score: Number(weightedScore.toFixed(2)),
    status: masteryStatus(weightedScore),
    evidence: history,
    updatedAt: evidence.at || new Date().toISOString()
  };
}

module.exports = { applyWeightedMasteryEvidence, masteryStatus };
