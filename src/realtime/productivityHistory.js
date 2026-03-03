"use strict";

/**
 * Store en memoria para historial de productividad individual por usuario.
 * Guarda un score por user_id por dia para alimentar el modelo AR(1) individual.
 *
 * Mapeo de clase a score continuo:
 *   productivo (1)     -> 1.0
 *   regular (2)        -> 0.5
 *   no_productivo (0)  -> 0.0
 */

const MAX_DAYS = Number(process.env.HISTORY_MAX_DAYS || 30);

// userId -> Map( day -> { score, clase, ts } )
const historyByUser = new Map();

function claseToScore(clase) {
  if (clase === 1) return 1.0;
  if (clase === 2) return 0.5;
  return 0.0;
}

/**
 * Registra el score de todos los usuarios de un dia.
 * @param {string} day - fecha YYYY-MM-DD
 * @param {Array} users - array de usuarios con prediccion.clase
 */
function setDayScore(day, users) {
  if (!day || !Array.isArray(users) || users.length === 0) return;

  for (const user of users) {
    const userId = user?.user_id;
    const clase = user?.prediccion?.clase;

    if (!userId || clase == null) continue;

    if (!historyByUser.has(userId)) {
      historyByUser.set(userId, new Map());
    }

    const userHistory = historyByUser.get(userId);
    userHistory.set(day, {
      score: claseToScore(clase),
      clase,
      ts: Date.now(),
    });

    pruneUserHistory(userId);
  }
}

/**
 * Devuelve el historial de un usuario ordenado por fecha ascendente.
 * @param {string} userId
 * @returns {Array<{ day: string, score: number, clase: number }>}
 */
function getUserHistory(userId) {
  const userHistory = historyByUser.get(userId);
  if (!userHistory) return [];

  return Array.from(userHistory.entries())
    .map(([day, entry]) => ({ day, score: entry.score, clase: entry.clase }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * Devuelve la serie de scores de un usuario ordenada por fecha ascendente.
 * Usado directamente por el modelo AR(1).
 * @param {string} userId
 * @returns {Array<{ day: string, score: number }>}
 */
function getScoreSeriesForUser(userId) {
  return getUserHistory(userId).map(({ day, score }) => ({ day, score }));
}

/**
 * Devuelve todos los userIds que tienen historial registrado.
 * @returns {Array<string>}
 */
function getAllUserIds() {
  return Array.from(historyByUser.keys());
}

/**
 * Devuelve el historial completo de todos los usuarios.
 * @returns {Object} userId -> Array<{ day, score, clase }>
 */
function getAllUsersHistory() {
  const out = {};
  for (const userId of historyByUser.keys()) {
    out[userId] = getUserHistory(userId);
  }
  return out;
}

/**
 * Elimina entradas que excedan el maximo de dias para un usuario.
 * @param {string} userId
 */
function pruneUserHistory(userId) {
  const userHistory = historyByUser.get(userId);
  if (!userHistory || userHistory.size <= MAX_DAYS) return;

  const sorted = Array.from(userHistory.keys()).sort();
  const excess = userHistory.size - MAX_DAYS;

  for (let i = 0; i < excess; i++) {
    userHistory.delete(sorted[i]);
  }
}

/**
 * Elimina todo el historial.
 */
function clearHistory() {
  historyByUser.clear();
}

/**
 * Devuelve cuantos usuarios tienen historial registrado.
 */
function historySize() {
  return historyByUser.size;
}

module.exports = {
  setDayScore,
  getUserHistory,
  getScoreSeriesForUser,
  getAllUserIds,
  getAllUsersHistory,
  clearHistory,
  historySize,
};