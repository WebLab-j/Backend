"use strict";

const actToDays = new Map(); // actividadId -> Set(days)

function addActividadDay(actividadId, day) {
  if (!actividadId || !day) return;
  let set = actToDays.get(actividadId);
  if (!set) {
    set = new Set();
    actToDays.set(actividadId, set);
  }
  set.add(day);
}

function getDaysForActividad(actividadId) {
  const set = actToDays.get(actividadId);
  return set ? Array.from(set) : [];
}

// opcional: limpieza para no crecer infinito
function pruneOlderThan(keepDaysSet) {
  for (const [actId, set] of actToDays.entries()) {
    for (const d of set) if (!keepDaysSet.has(d)) set.delete(d);
    if (set.size === 0) actToDays.delete(actId);
  }
}

module.exports = { addActividadDay, getDaysForActividad, pruneOlderThan };
