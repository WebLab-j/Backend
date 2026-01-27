function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function overlapMinutes(aStart, aEnd, wStart, wEnd) {
  const start = Math.max(aStart.getTime(), wStart.getTime());
  const end = Math.min(aEnd.getTime(), wEnd.getTime());
  return Math.max(0, Math.round((end - start) / 60000));
}

// dayStr: "2026-01-03"  (hora LOCAL del servidor)
function buildWindow(dayStr, startHour = 9, endHour = 17) {
  const [y, m, d] = dayStr.split("-").map(Number);
  const wStart = new Date(y, m - 1, d, startHour, 0, 0, 0);
  const wEnd = new Date(y, m - 1, d, endHour, 0, 0, 0);
  return { wStart, wEnd };
}

function filterActividadesByWindow(
  actividades,
  dayStr,
  startHour = 9,
  endHour = 17,
  excludeTypes = ["00Sec", "ftf"]
) {
  const { wStart, wEnd } = buildWindow(dayStr, startHour, endHour);

  const kept = [];
  let minutosPlaneadosEnVentana = 0;

  // normaliza tipos a minúsculas para comparar sin fallar
  const banned = new Set(excludeTypes.map(t => String(t).toLowerCase()));

  for (const a of actividades) {
    const s = toDate(a.dueStart);
    const e = toDate(a.dueEnd);
    if (!s || !e) continue;

    // ✅ filtro por tipo (usa titulo/nombre)
    const text = String(a.titulo ?? a.title ?? a.nombre ?? "").toLowerCase();

    // si contiene "00sec" o "ftf" en el título => se excluye
    const isBanned = [...banned].some(t => text.includes(t));
    if (isBanned) continue;

    const mins = overlapMinutes(s, e, wStart, wEnd);
    if (mins <= 0) continue;

    kept.push({ ...a, minutos_en_ventana: mins });
    minutosPlaneadosEnVentana += mins;
  }

  return { kept, minutosPlaneadosEnVentana };
}


module.exports = { filterActividadesByWindow };
