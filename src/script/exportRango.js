// backend/src/script/exportRangoDesdeRevisiones.js
// Uso:
//   node src/script/exportRangoDesdeRevisiones.js 2026-01-08 2026-01-19
//   node src/script/exportRangoDesdeRevisiones.js 2026-01-08 today
//
// Genera CSV con:
// date, user_id, colaborador, actividades, revisiones, tiempo_total, productivo
//
// Filtros:
// - Solo revisiones con duracionMin > 0
// - Excluir actividades cuyo titulo tenga "ftf" o "00sec"
// - (Opcional) Filtrar revisiones por hora 9-5 usando fechaFinTerminada/fechaCreacion (hora local CDMX)

require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const DEFAULT_REV_URL =
  "https://wlserver-production.up.railway.app/api/reportes/revisiones-por-fecha";

const TZ = "America/Mexico_City";
const START_HOUR = 9;
const END_HOUR = 17; // exclusivo
const PRODUCTIVO_MIN = 480;

// Ponlo en true si quieres que SOLO cuenten revisiones hechas 9-5 (por timestamp de revisión)
const FILTRAR_POR_HORA_REVISION = true;

function escCsv(v) {
  const s = String(v ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function ensureOutDir() {
  const outDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  return outDir;
}

function addDaysISO(dayStr, deltaDays) {
  const [y, m, d] = dayStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function getTodayISOInTZ(timeZone) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now);
}

function resolveDayArg(arg) {
  if (!arg || String(arg).trim() === "" || String(arg).toLowerCase() === "today") {
    return getTodayISOInTZ(TZ);
  }
  return String(arg).trim();
}

function enumerateDays(startDay, endDay) {
  const days = [];
  if (startDay > endDay) return enumerateDays(endDay, startDay);
  let cur = startDay;
  while (cur <= endDay) {
    days.push(cur);
    cur = addDaysISO(cur, 1);
  }
  return days;
}

function getLocalParts(dateObj, timeZone) {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return null;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(dateObj);
  const get = (type) => parts.find((p) => p.type === type)?.value;

  const y = get("year");
  const m = get("month");
  const d = get("day");
  const h = get("hour");
  const min = get("minute");
  if (!y || !m || !d || h == null || min == null) return null;

  return { date: `${y}-${m}-${d}`, hour: Number(h), minute: Number(min) };
}

function revisionEnVentana9a5(rev, day) {
  // usamos fechaFinTerminada si existe, si no fechaCreacion
  const ts = rev?.fechaFinTerminada || rev?.fechaCreacion;
  if (!ts) return false;

  const dt = new Date(ts);
  const local = getLocalParts(dt, TZ);
  if (!local) return false;

  // asegurar que cae en el "día" que estamos procesando (local CDMX)
  if (local.date !== day) return false;

  const mins = local.hour * 60 + local.minute;
  return mins >= START_HOUR * 60 && mins < END_HOUR * 60;
}

function esFtf00secPorTitulo(titulo) {
  const t = String(titulo ?? "").toLowerCase();
  return t.includes("ftf") || t.includes("00sec");
}

function resolveUserName(col) {
  if (col?.name) return col.name;

  const userId = col?.idAsignee;
  const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];

  for (const a of acts) {
    for (const bucket of ["terminadas", "confirmadas", "pendientes"]) {
      const revs = Array.isArray(a?.[bucket]) ? a[bucket] : [];
      for (const r of revs) {
        const asg = Array.isArray(r?.assignees) ? r.assignees : [];
        const hit = asg.find((x) => x?.id === userId && x?.name);
        if (hit?.name) return hit.name;
      }
    }
  }
  return userId || "unknown";
}

async function fetchColaboradores(revUrl, day) {
  const { data } = await axios.get(revUrl, { params: { date: day } });
  return Array.isArray(data?.data?.colaboradores) ? data.data.colaboradores : [];
}

function procesarColaboradorDia(col, day) {
  const userId = col?.idAsignee;
  if (!userId) return null;

  const userName = resolveUserName(col);

  let revisiones = 0;
  let minutos = 0;
  const actividadesSet = new Set();

  const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];
  const buckets = ["terminadas", "confirmadas", "pendientes"];

  for (const a of acts) {
    const actId = a?.id;
    const actTitulo = a?.titulo; // en tu estructura sí viene en el reporte
    if (!actId) continue;

    // excluir actividad por título (ftf/00sec)
    if (esFtf00secPorTitulo(actTitulo)) continue;

    for (const b of buckets) {
      const revs = Array.isArray(a?.[b]) ? a[b] : [];
      for (const r of revs) {
        const dur = Number(r?.duracionMin ?? 0) || 0;
        if (dur <= 0) continue;

        if (FILTRAR_POR_HORA_REVISION) {
          if (!revisionEnVentana9a5(r, day)) continue;
        }

        revisiones += 1;
        minutos += dur;
        actividadesSet.add(actId);
      }
    }
  }

  return {
    date: day,
    user_id: userId,
    colaborador: userName,
    actividades: actividadesSet.size,
    revisiones,
    tiempo_total: minutos,
    productivo: minutos >= PRODUCTIVO_MIN ? 1 : 0,
  };
}

(async () => {
  const startDay = resolveDayArg(process.argv[2]);
  const endDay = resolveDayArg(process.argv[3] || process.argv[2]);

  const REV_URL = process.env.WL_REVISIONES_POR_FECHA_URL || DEFAULT_REV_URL;
  const days = enumerateDays(startDay, endDay);

  try {
    console.log(`🗓️ Rango: ${days[0]} → ${days[days.length - 1]} (días=${days.length})`);
    console.log(`⏱️ Filtro hora por revisión 9-5: ${FILTRAR_POR_HORA_REVISION ? "SI" : "NO"}`);

    const rows = [];

    for (const day of days) {
      const colaboradores = await fetchColaboradores(REV_URL, day);

      for (const col of colaboradores) {
        const row = procesarColaboradorDia(col, day);
        if (row) rows.push(row);
      }

      console.log(`  ✅ ${day}: colaboradores=${colaboradores.length} filas acumuladas=${rows.length}`);
    }

    const outDir = ensureOutDir();
    const outPath = path.join(
      outDir,
      `dataset_revisiones_${days[0]}_a_${days[days.length - 1]}_${FILTRAR_POR_HORA_REVISION ? "9a5" : "sinHora"}.csv`
    );

    const header = ["date", "user_id", "colaborador", "actividades", "revisiones", "tiempo_total", "productivo"];
    const lines = [header.join(",")];

    for (const r of rows) {
      lines.push(
        [
          r.date,
          r.user_id,
          escCsv(r.colaborador),
          r.actividades,
          r.revisiones,
          r.tiempo_total,
          r.productivo,
        ].join(",")
      );
    }

    fs.writeFileSync(outPath, lines.join("\n"), "utf8");
    console.log("\n✅ CSV generado:");
    console.log(`📁 ${outPath}`);
    console.log(`🧾 Filas totales: ${rows.length}`);
  } catch (err) {
    console.error("❌ Error:", err?.message || err);
    if (err?.response) {
      console.error("Status:", err.response.status);
      console.error("URL:", err.config?.url);
      console.error("Response:", JSON.stringify(err.response.data).slice(0, 500));
    }
    process.exit(1);
  }
})();
