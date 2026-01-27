const { DateTime } = require("luxon");

function toDateKey(isoString) {
  return DateTime.fromISO(isoString, { setZone: true })
    .setZone(process.env.TZ || "America/Mexico_City")
    .toFormat("yyyy-LL-dd");
}

function diffMinutes(startISO, endISO) {
  if (!startISO || !endISO) return 0;
  const a = DateTime.fromISO(startISO, { setZone: true });
  const b = DateTime.fromISO(endISO, { setZone: true });
  const minutes = Math.round(b.diff(a, "minutes").minutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

function normalizeActivityStatus(statusRaw = "") {
  const s = String(statusRaw).toUpperCase();
  if (s.includes("SUSP")) return "SUSPENDIDO";
  if (s.includes("TERMI") || s.includes("DONE") || s.includes("HECHO")) return "TERMINADO";
  return "PENDIENTE";
}

function normalizeReviewStatus(statusRaw = "") {
  const s = String(statusRaw).toUpperCase();
  if (s.includes("CONF")) return "CONFIRMADA";
  if (s.includes("TERMI") || s.includes("DONE") || s.includes("FINAL")) return "TERMINADA";
  return "OTRO";
}

function dayOfWeekFromDateKey(dateKey) {
  const dt = DateTime.fromFormat(dateKey, "yyyy-LL-dd", { zone: process.env.TZ || "America/Mexico_City" });
  const lux = dt.weekday; // 1..7
  return lux % 7; // domingo=0
}

function buildDailyFeatures({ actividades = [], revisiones = [] }) {
  const map = new Map();

  function getRow(userId, dateKey) {
    const key = `${userId}|${dateKey}`;
    if (!map.has(key)) {
      map.set(key, {
        user_id: userId,
        date: dateKey,

        minutos_planeados: 0,
        actividades_planeadas: 0,
        pendientes_unchecked: 0,

        minutos_trabajados: 0,
        revisiones_terminadas: 0,
        revisiones_confirmadas: 0,

        dia_semana: dayOfWeekFromDateKey(dateKey),
        productivo: 0,
      });
    }
    return map.get(key);
  }

  // Actividades (planeación)
  for (const act of actividades) {
    const assignees = Array.isArray(act.assignees) ? act.assignees : [];
    const dueStart = act.dueStart;
    const dueEnd = act.dueEnd;

    if (!dueStart || !dueEnd) continue;

    const dateKey = toDateKey(dueStart);
    const plannedMin = diffMinutes(dueStart, dueEnd);

    const pendientes = Array.isArray(act.pendientes) ? act.pendientes : [];
    const unchecked = pendientes.filter(p => p && p.checked === false).length;

    // por si luego lo usas
    void normalizeActivityStatus(act.status);

    for (const userId of assignees) {
      const row = getRow(userId, dateKey);
      row.actividades_planeadas += 1;
      row.minutos_planeados += plannedMin;
      row.pendientes_unchecked += unchecked;
    }
  }

  // Revisiones (trabajo real)
  for (const r of revisiones) {
    // AJUSTA cuando me pases un ejemplo real exacto de revisiones:
    const userId = r.assigneeEmail || r.assignee || r.user || r.email || r.asignadoA;
    const start = r.fechaCreacion || r.start || r.inicio;
    const end = r.fechaFinTerminada || r.end || r.fin;

    if (!userId || !start) continue;

    const dateKey = toDateKey(start);
    const minutes = end ? diffMinutes(start, end) : 0;

    const st = normalizeReviewStatus(r.status || r.estatus || r.estado);

    const row = getRow(userId, dateKey);
    row.minutos_trabajados += minutes;
    if (st === "TERMINADA") row.revisiones_terminadas += 1;
    if (st === "CONFIRMADA") row.revisiones_confirmadas += 1;
  }

  // Etiqueta productivo (regla MVP)
  for (const row of map.values()) {
    const planeado = row.minutos_planeados || 0;
    const trabajado = row.minutos_trabajados || 0;
    const ratio = planeado > 0 ? trabajado / planeado : 0;
    row.productivo = (trabajado >= 240 || ratio >= 0.60) ? 1 : 0;
  }

  return Array.from(map.values());
}

module.exports = { buildDailyFeatures };
