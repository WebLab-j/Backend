// file: src/realtime/rawStore.js
"use strict";

/**
 * Raw cache por día para poder aplicar patch del socket sin volver a pedir a WL.
 * Estructura esperada:
 * - day -> { colaboradoresRaw, actividadesById, ts }
 */
const rawByDay = new Map();

function listDays() {
  return Array.from(rawByDay.keys());
}

function findDaysContainingActividad(actividadId) {
  if (!actividadId) return [];
  const out = [];
  for (const [day, state] of rawByDay.entries()) {
    const byId = state?.actividadesById;
    if (byId instanceof Map && byId.has(actividadId)) out.push(day);
  }
  return out;
}


function hasDayRaw(day) {
  return rawByDay.has(day);
}

function setDayRaw(day, { colaboradoresRaw, actividadesById }) {
  if (!day) return;
  rawByDay.set(day, {
    colaboradoresRaw: Array.isArray(colaboradoresRaw) ? colaboradoresRaw : [],
    actividadesById: actividadesById || new Map(),
    ts: Date.now(),
  });
}

function getDayRaw(day) {
  return rawByDay.get(day) || null;
}

function extractActividadId(payload) {
  return Array.isArray(payload?.actividadesRelacionadas)
    ? payload.actividadesRelacionadas[0] || null
    : null;
}

function extractUserIds(payload) {
  const ids = Array.isArray(payload?.assignees)
    ? payload.assignees.map((a) => a?.id).filter(Boolean)
    : [];
  return Array.from(new Set(ids));
}
function findDaysWithActividad(actividadId) {
  if (!actividadId) return [];
  const days = [];
  for (const [day, state] of rawByDay.entries()) {
    if (state?.actividadesById?.has?.(actividadId)) days.push(day);
  }
  return days;
}

/**
 * Heurística bucket:
 * - confirmacion === true => confirmadas
 * - else si fechaFinTerminada existe => terminadas
 * - else => pendientes
 */
function resolveBucketFromPayload(payload) {
  if (payload?.confirmacion === true) return "confirmadas";

  // ✅ ESTA ES LA CLAVE PARA TU "HECHO"
  if (payload?.terminadaPendienteRevision === true) return "terminadas";

  if (payload?.fechaFinTerminada) return "terminadas";
  return "pendientes";
}

function normalizeRevisionFromEvent(payload) {
  return {
    id: payload?.id ?? payload?._id ?? null,
    nombre: payload?.nombre ?? null,
    duracionMin: Number(payload?.duracionMinActHorasEficientes ?? 0) || 0,
    fechaCreacion: payload?.fechaCreacion ?? payload?.fechaCreacionImportante ?? null,
    assignees: Array.isArray(payload?.assignees)
      ? payload.assignees.map((a) => ({ id: a?.id ?? null, name: a?.name ?? null }))
      : [],
    terminadaPendienteRevision: !!payload?.terminadaPendienteRevision,
    confirmacion: !!payload?.confirmacion,
    rawSocket: payload,
  };
}

function removeFromAllBuckets(act, revisionId) {
  for (const b of ["terminadas", "confirmadas", "pendientes"]) {
    act[b] = Array.isArray(act[b])
      ? act[b].filter((x) => (x?.id ?? x?._id) !== revisionId)
      : [];
  }
}

function upsertIntoBucketList(list, revision) {
  const id = revision?.id;
  if (!id) return list;

  const idx = list.findIndex((x) => (x?.id ?? x?._id) === id);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...revision };
    return list;
  }
  list.push(revision);
  return list;
}

/**
 * Aplica un evento revision_creada/revision_actualizada al raw cache del día.
 * Retorna { touchedUserIds: string[], actividadId }
 */
function applyRevisionEvent(day, payload) {
  const state = getDayRaw(day);
  if (!state) return { touchedUserIds: [], actividadId: null };

  const actividadId = extractActividadId(payload);
  const userIds = extractUserIds(payload);
  if (!actividadId || userIds.length === 0) return { touchedUserIds: [], actividadId };

  const bucket = resolveBucketFromPayload(payload);
  const rev = normalizeRevisionFromEvent(payload);

  for (const uid of userIds) {
    const col = state.colaboradoresRaw.find((c) => c?.idAsignee === uid);
    if (!col) continue;

    if (!col.items) col.items = {};
    if (!Array.isArray(col.items.actividades)) col.items.actividades = [];

    let act = col.items.actividades.find((a) => a?.id === actividadId);
    if (!act) {
      act = { id: actividadId, terminadas: [], confirmadas: [], pendientes: [] };
      col.items.actividades.push(act);
    }

    if (!Array.isArray(act.terminadas)) act.terminadas = [];
    if (!Array.isArray(act.confirmadas)) act.confirmadas = [];
    if (!Array.isArray(act.pendientes)) act.pendientes = [];

    removeFromAllBuckets(act, rev.id);

    // ✅ UNA sola vez
    act[bucket] = upsertIntoBucketList(act[bucket], rev);
  }

  return { touchedUserIds: userIds, actividadId };
}

function removeRevisionFromAllActividades(col, revisionId) {
  const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];
  for (const act of acts) removeFromAllBuckets(act, revisionId);
}

/**
 * Aplica un evento de borrado de revisión al raw cache del día.
 * Retorna { touchedUserIds: string[], actividadId, revisionId }
 */
// file: src/realtime/rawStore.js

/**
 * Aplica un evento de borrado de revisión al raw cache del día.
 * Retorna { touchedUserIds: string[], actividadId, revisionId }
 */
function applyRevisionDeletedEvent(day, payload) {
  const state = getDayRaw(day);
  if (!state) return { touchedUserIds: [], actividadId: null, revisionId: null };

  const revisionId = payload?.id ?? payload?._id ?? null;
  if (!revisionId) return { touchedUserIds: [], actividadId: null, revisionId: null };

  const actividadId = extractActividadId(payload); // puede venir o no
  const userIds = extractUserIds(payload);

  const cols = Array.isArray(state.colaboradoresRaw) ? state.colaboradoresRaw : [];
  const touched = new Set();

  const removeInCol = (col) => {
    if (!col) return false;

    if (!col.items) col.items = {};
    if (!Array.isArray(col.items.actividades)) col.items.actividades = [];

    let changed = false;

    if (actividadId) {
      const act = col.items.actividades.find((a) => a?.id === actividadId);
      if (!act) return false;

      const before =
        (Array.isArray(act.terminadas) ? act.terminadas.length : 0) +
        (Array.isArray(act.confirmadas) ? act.confirmadas.length : 0) +
        (Array.isArray(act.pendientes) ? act.pendientes.length : 0);

      removeFromAllBuckets(act, revisionId);

      const after =
        (Array.isArray(act.terminadas) ? act.terminadas.length : 0) +
        (Array.isArray(act.confirmadas) ? act.confirmadas.length : 0) +
        (Array.isArray(act.pendientes) ? act.pendientes.length : 0);

      changed = after !== before;
    } else {
      // fallback: buscar y remover en todas las actividades del colaborador
      const acts = col.items.actividades;
      for (const act of acts) {
        if (!act) continue;

        const before =
          (Array.isArray(act.terminadas) ? act.terminadas.length : 0) +
          (Array.isArray(act.confirmadas) ? act.confirmadas.length : 0) +
          (Array.isArray(act.pendientes) ? act.pendientes.length : 0);

        removeFromAllBuckets(act, revisionId);

        const after =
          (Array.isArray(act.terminadas) ? act.terminadas.length : 0) +
          (Array.isArray(act.confirmadas) ? act.confirmadas.length : 0) +
          (Array.isArray(act.pendientes) ? act.pendientes.length : 0);

        if (after !== before) changed = true;
      }
    }

    if (changed) touched.add(col?.idAsignee);
    return changed;
  };

  // ✅ Caso 1: si vienen userIds, tocamos solo esos
  if (userIds.length > 0) {
    for (const uid of userIds) {
      const col = cols.find((c) => c?.idAsignee === uid);
      removeInCol(col);
    }
    return { touchedUserIds: Array.from(touched).filter(Boolean), actividadId, revisionId };
  }

  // ✅ Caso 2 (TU CASO): solo llega {id} => recorremos TODOS
  for (const col of cols) removeInCol(col);

  return { touchedUserIds: Array.from(touched).filter(Boolean), actividadId, revisionId };
}

module.exports = {
  setDayRaw,
  getDayRaw,
  hasDayRaw,
  applyRevisionEvent,
  applyRevisionDeletedEvent,
  listDays,
  findDaysContainingActividad,
  findDaysWithActividad,
};
