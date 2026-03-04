// utils/productivityDataset.js

function safeNum(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function countArray(a) {
  return Array.isArray(a) ? a.length : 0;
}

/**
 * Suma duracionMin dentro de una lista de items
 */
function sumDuracionMin(list) {
  if (!Array.isArray(list)) return 0;
  return list.reduce((acc, it) => acc + safeNum(it?.duracionMin), 0);
}

/**
 * Recorre actividades[] y acumula counts + minutes de pendientes/confirmadas/terminadas
 */
function aggregateFromActividades(actividades) {
  let pendingCount = 0;
  let confirmedCount = 0;
  let doneCount = 0;

  let pendingMinutes = 0;
  let confirmedMinutes = 0;
  let doneMinutes = 0;

  const acts = Array.isArray(actividades) ? actividades : [];
  for (const act of acts) {
    const pendientes = act?.pendientes ?? [];
    const confirmadas = act?.confirmadas ?? [];
    const terminadas = act?.terminadas ?? [];

    pendingCount += countArray(pendientes);
    confirmedCount += countArray(confirmadas);
    doneCount += countArray(terminadas);

    pendingMinutes += sumDuracionMin(pendientes);
    confirmedMinutes += sumDuracionMin(confirmadas);
    doneMinutes += sumDuracionMin(terminadas);
  }

  return {
    activitiesCount: acts.length,
    pendingCount,
    confirmedCount,
    doneCount,
    pendingMinutes,
    confirmedMinutes,
    doneMinutes,
    // totalMinutes: todo lo que tiene duracionMin (tú puedes elegir)
    totalMinutes: pendingMinutes + confirmedMinutes + doneMinutes,
    // effectiveMinutes: solo terminadas (útil para productividad "real")
    effectiveMinutes: doneMinutes,
  };
}

/**
 * Clasificación (label) basada en reglas simples.
 * Ajusta estos thresholds a tus reglas reales.
 */
function classifyDay({ effectiveMinutes, doneCount }) {
  // Ejemplo simple: productivo si >= 6h o muchas terminadas
  if (effectiveMinutes >= 360 || doneCount >= 20) return "productivo";
  if (effectiveMinutes >= 180 || doneCount >= 8) return "regular";
  return "no_productivo";
}

/**
 * Convierte el "raw cache" (como tu respuesta raw.peek) a dataset rows.
 *
 * Espera estructura similar a:
 * {
 *   raw: {
 *     colaboradoresRaw: [
 *        { idAsignee, name, items: { actividades: [...] } }
 *     ]
 *   }
 * }
 */
function rawCacheToDatasetRows(rawCache, dayISO) {
  const colaboradores = rawCache?.raw?.colaboradoresRaw ?? [];
  const rows = [];

  for (const col of colaboradores) {
    const userId = col?.idAsignee ?? null;
    if (!userId) continue;

    const name = col?.name ?? null;
    const actividades = col?.items?.actividades ?? [];

    const agg = aggregateFromActividades(actividades);

    // Decide qué "tiempo" usar como feature principal
    // - totalMinutes: incluye pendientes/confirmadas/terminadas
    // - effectiveMinutes: solo terminadas
    const timeMinutes = agg.totalMinutes; // <- cambia a agg.effectiveMinutes si prefieres

    const labelToday = classifyDay({
      effectiveMinutes: agg.effectiveMinutes,
      doneCount: agg.doneCount,
    });

    rows.push({
      date: dayISO,
      user_id: userId,
      name,
      activities_count: agg.activitiesCount,
      pending_count: agg.pendingCount,
      confirmed_count: agg.confirmedCount,
      done_count: agg.doneCount,
      time_minutes: timeMinutes,
      effective_minutes: agg.effectiveMinutes,
      label_today: labelToday,
    });
  }

  return rows;
}

/**
 * Opcional: convertir a CSV
 */
function rowsToCSV(rows) {
  if (!rows.length) return "date,user_id,name,activities_count,pending_count,confirmed_count,done_count,time_minutes,effective_minutes,label_today\n";

  const header = Object.keys(rows[0]).join(",");
  const lines = rows.map((r) =>
    Object.keys(r)
      .map((k) => {
        const v = r[k];
        const s = v === null || v === undefined ? "" : String(v);
        // escape CSV simple
        return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(",")
  );

  return [header, ...lines].join("\n") + "\n";
}

module.exports = {
  rawCacheToDatasetRows,
  rowsToCSV,
  classifyDay, // por si quieres usar tu lógica real aquí
};