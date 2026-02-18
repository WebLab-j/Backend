// file: src/realtime/revisionIndex.js
"use strict";

const index = new Map(); // revisionId -> { days:Set, userIds:Set, actividadId, ts }
const TTL_MS = Number(process.env.REVISION_INDEX_TTL_MS || 6 * 60 * 60 * 1000); // 6h

function now() {
  return Date.now();
}

function prune() {
  const cutoff = now() - TTL_MS;
  for (const [rid, v] of index.entries()) {
    if (!v?.ts || v.ts < cutoff) index.delete(rid);
  }
}

function upsertFromEvent({ revisionId, days, userIds, actividadId }) {
  if (!revisionId) return;
  prune();

  const prev = index.get(revisionId) || { days: new Set(), userIds: new Set(), actividadId: null, ts: now() };

  if (Array.isArray(days)) for (const d of days) if (d) prev.days.add(d);
  if (Array.isArray(userIds)) for (const u of userIds) if (u) prev.userIds.add(u);
  if (actividadId) prev.actividadId = actividadId;

  prev.ts = now();
  index.set(revisionId, prev);
}

function resolve(revisionId) {
  prune();
  const v = index.get(revisionId);
  if (!v) return null;
  return {
    days: Array.from(v.days),
    userIds: Array.from(v.userIds),
    actividadId: v.actividadId,
  };
}

module.exports = { upsertFromEvent, resolve };
