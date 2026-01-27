// src/services/syncService.js
const axios = require("axios");
const { pool } = require("../db");
const { buildDailyFeatures } = require("../utils/transform");
const { saveSnapshotSummary } = require("./rawSnapshotService");
const { filterActividadesByWindow } = require("../utils/timeWindow");
const fs = require("fs");

// ------------------------------
// Helpers
// ------------------------------
function getActId(a) {
  // En tu API de actividades normalmente es a.id
  return a?.id ?? a?.actividad_id ?? a?.activity_id ?? null;
}

// ---- fetch RAW completo (solo en RAM) ----
async function fetchActividadesRaw(start, end) {
  const { data } = await axios.get(process.env.WL_ACTIVIDADES_URL, {
    params: { start, end },
  });
  return data; // {success, data:[...]}
}

async function fetchRevisionesRaw(start, end) {
  const { data } = await axios.get(process.env.WL_REVISIONES_URL, {
    params: { start, end },
  });
  return data; // en tu caso: { success:true, data:{ colaboradores:[...] ... } }
}

// ---- normalize arrays para el transform ----
function normalizeActividades(actividadesRaw) {
  return Array.isArray(actividadesRaw?.data) ? actividadesRaw.data : [];
}

/**
 * Tu API de revisiones NO regresa lista plana.
 * Regresa un REPORTE agrupado:
 * data.colaboradores[].items.actividades[].terminadas[]
 *
 * Aquí lo aplanamos a:
 * [
 *   {
 *     revision_id,
 *     actividad_id,
 *     actividad_titulo,
 *     assignee_id,
 *     assignee_name,
 *     terminada,
 *     confirmada,
 *     nombre,
 *     fuente
 *   },
 *   ...
 * ]
 */
function normalizeRevisiones(revisionesRaw) {
  if (!revisionesRaw) return [];

  // Caso 1: ya viene como arreglo plano
  if (Array.isArray(revisionesRaw?.data)) return revisionesRaw.data;
  if (Array.isArray(revisionesRaw)) return revisionesRaw;

  // Caso 2: viene como REPORTE (tu caso real)
  const data = revisionesRaw?.data;
  const colaboradores = Array.isArray(data?.colaboradores) ? data.colaboradores : [];
  const flat = [];

  for (const col of colaboradores) {
    const assignee_id = col?.idAsignee ?? null;
    const assignee_name = col?.name ?? null;

    const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];
    for (const act of acts) {
      const actividad_id = act?.id ?? null;
      const actividad_titulo = act?.titulo ?? null;

      // ✅ terminadas[]
      const terminadas = Array.isArray(act?.terminadas) ? act.terminadas : [];
      for (const rev of terminadas) {
        flat.push({
          revision_id: rev?.id ?? null,
          actividad_id,
          actividad_titulo,
          assignee_id,
          assignee_name,
          terminada: !!rev?.terminada,
          confirmada: !!rev?.confirmada,
          nombre: rev?.nombre ?? null,
          fuente: "terminadas",
        });
      }

      // ✅ por si tu API también manda confirmadas[]
      const confirmadas = Array.isArray(act?.confirmadas) ? act.confirmadas : [];
      for (const rev of confirmadas) {
        flat.push({
          revision_id: rev?.id ?? null,
          actividad_id,
          actividad_titulo,
          assignee_id,
          assignee_name,
          terminada: !!rev?.terminada,
          confirmada: !!rev?.confirmada,
          nombre: rev?.nombre ?? null,
          fuente: "confirmadas",
        });
      }
    }
  }

  return flat;
}

// ---- upsert features ----
async function upsertDailyFeatures(rows) {
  const sql = `
    INSERT INTO daily_user_features
      (user_id, date, minutos_planeados, actividades_planeadas, pendientes_unchecked,
       minutos_trabajados, revisiones_terminadas, revisiones_confirmadas,
       dia_semana, productivo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      minutos_planeados = VALUES(minutos_planeados),
      actividades_planeadas = VALUES(actividades_planeadas),
      pendientes_unchecked = VALUES(pendientes_unchecked),
      minutos_trabajados = VALUES(minutos_trabajados),
      revisiones_terminadas = VALUES(revisiones_terminadas),
      revisiones_confirmadas = VALUES(revisiones_confirmadas),
      dia_semana = VALUES(dia_semana),
      productivo = VALUES(productivo),
      updated_at = CURRENT_TIMESTAMP
  `;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of rows) {
      await conn.execute(sql, [
        r.user_id,
        r.date,
        r.minutos_planeados,
        r.actividades_planeadas,
        r.pendientes_unchecked,
        r.minutos_trabajados,
        r.revisiones_terminadas,
        r.revisiones_confirmadas,
        r.dia_semana,
        r.productivo,
      ]);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ---- iterar por día (reduce volumen por request) ----
function* eachDay(start, end) {
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    yield d.toISOString().slice(0, 10);
  }
}

// ------------------------------
// MAIN SYNC
// ------------------------------
async function syncRange(start, end) {
  let totalActs = 0;
  let totalRevs = 0;
  let totalRows = 0;
  let totalIgnored = 0;

  for (const day of eachDay(start, end)) {
    // 1) Fetch raw
    const actividadesRaw = await fetchActividadesRaw(day, day);
    const revisionesRaw = await fetchRevisionesRaw(day, day);

    // 2) Guardar snapshot compacta
    await Promise.all([
      saveSnapshotSummary({
        source: "actividades",
        start: day,
        end: day,
        apiResponse: actividadesRaw,
      }),
      saveSnapshotSummary({
        source: "revisiones",
        start: day,
        end: day,
        apiResponse: revisionesRaw,
      }),
    ]);

    // 3) Normalizar
    const actividadesAll = normalizeActividades(actividadesRaw);
    const revisionesAll = normalizeRevisiones(revisionesRaw);

    // 4) Filtro 9am-5pm
    const { kept: actividades, minutosPlaneadosEnVentana } =
      filterActividadesByWindow(actividadesAll, day, 9, 17);

    // 5) IDs de actividades en ventana
    const actIds = new Set(actividades.map(getActId).filter(Boolean));

    // 6) Filtrar revisiones SOLO de esas actividades
    const revisiones = revisionesAll.filter((r) => r?.actividad_id && actIds.has(r.actividad_id));

    // 7) Agrupar revisiones por actividad
    const revsByActividad = new Map();
    for (const r of revisiones) {
      const key = r.actividad_id;
      if (!revsByActividad.has(key)) revsByActividad.set(key, []);
      revsByActividad.get(key).push(r);
    }

    // Logs de comprobación
    console.log(
      `[${day}] acts_total=${actividadesAll.length} | acts_9-5=${actividades.length} | mins_9-5=${minutosPlaneadosEnVentana} | revs_total=${revisionesAll.length} | revs_filtradas=${revisiones.length} | revsByActividad=${revsByActividad.size}`
    );

    // 8) Transform
    const dailyRows = buildDailyFeatures({
      actividades,
      revisiones,
      revsByActividad,
      day,
      minutosPlaneadosEnVentana,
    });

    // 9) Validar filas
    const validRows = dailyRows.filter((r) => r.user_id && r.date);
    const ignored = dailyRows.length - validRows.length;

    if (ignored > 0) {
      console.warn(`[sync:${day}] Ignoring ${ignored} rows with missing user_id/date`);
    }

    // 10) Guardar features
    await upsertDailyFeatures(validRows);

    // 11) Totales
    totalActs += actividades.length;
    totalRevs += revisiones.length;
    totalRows += validRows.length;
    totalIgnored += ignored;
  }


  return {
    start,
    end,
    actividades: totalActs,
    revisiones: totalRevs,
    dailyRows: totalRows,
    ignored: totalIgnored,
  };
}

module.exports = { syncRange };
