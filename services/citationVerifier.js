const crypto = require("crypto");

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function verifyCitation(citation = {}, hit = null) {
  const quote = compact(citation.quote);
  const sourceText = compact(hit?.text || hit?.quote || "");
  const sourceId = hit?.chunkId || (hit?.graphId && hit?.nodeId ? `${hit.graphId}:${hit.nodeId}` : "");
  const verified = Boolean(sourceId && quote && sourceText && sourceText.includes(quote));
  return {
    ...citation,
    sourceId: sourceId || citation.sourceId || "",
    contentSha256: sourceText ? digest(sourceText) : "",
    verification: {
      status: verified ? "verified" : "unverified",
      method: verified ? "source-quote-exact" : "source-not-available-or-quote-mismatch",
      verifiedAt: new Date().toISOString()
    }
  };
}

function verifiedCitationsFromHits(hits = []) {
  return hits.map((hit, index) => verifyCitation({
    id: `S${index + 1}`,
    type: hit.type,
    title: hit.title,
    sourceName: hit.sourceName,
    subject: hit.subject,
    chapter: hit.chapter,
    page: hit.page,
    quote: hit.quote,
    materialId: hit.materialId,
    ownerId: hit.ownerId,
    global: Boolean(hit.global),
    classId: hit.classId || "",
    ragChannel: hit.ragChannel || "",
    graphId: hit.graphId,
    nodeId: hit.nodeId
  }, hit));
}

function verifyExternalCitations(citations = [], hits = []) {
  return citations.map((citation) => {
    const matched = hits.find((hit) => (
      (citation.materialId && citation.materialId === hit.materialId)
      || (citation.graphId && citation.nodeId && citation.graphId === hit.graphId && citation.nodeId === hit.nodeId)
    ));
    return verifyCitation(citation, matched);
  });
}

module.exports = { verifiedCitationsFromHits, verifyExternalCitations };
