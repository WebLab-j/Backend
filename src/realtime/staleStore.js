"use strict";

/**
 * Stale flags store.
 * - staleAll: todo está potencialmente desactualizado (fallback)
 * - staleDays: día completo está stale
 * - staleUsersByDay: usuarios stale por día
 */

const staleUsersByDay = new Map(); // day -> Set<userId>
const staleDays = new Set(); // day
let staleAll = false;

function markStaleAll() {
  staleAll = true;
}

function markStaleDay(day) {
  if (!day) return;
  staleDays.add(day);
}

function markStaleUser(day, userId) {
  if (!day || !userId) return;
  let set = staleUsersByDay.get(day);
  if (!set) {
    set = new Set();
    staleUsersByDay.set(day, set);
  }
  set.add(userId);
}

/**
 * Peek sin consumir (para que /hoy y /usuario no se "roben" el flag).
 */
function peekStaleForDay(day) {
  return {
    all: staleAll,
    dayStale: staleDays.has(day),
    users: new Set(staleUsersByDay.get(day) || []),
  };
}

function clearStaleUser(day, userId) {
  const set = staleUsersByDay.get(day);
  if (!set) return;
  set.delete(userId);
  if (set.size === 0) staleUsersByDay.delete(day);
}

function clearStaleDay(day) {
  staleDays.delete(day);
  staleUsersByDay.delete(day);
}

function clearAll() {
  staleUsersByDay.clear();
  staleDays.clear();
  staleAll = false;
}

module.exports = {
  markStaleAll,
  markStaleDay,
  markStaleUser,
  peekStaleForDay,
  clearStaleUser,
  clearStaleDay,
  clearAll,
};
