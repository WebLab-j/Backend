// backend/src/script/exportConteoActividades9a5_dueStart.js
// Uso:
//   node exportConteoActividades9a5_dueStart.js 2026-01-18
//   node exportConteoActividades9a5_dueStart.js today
//   node exportConteoActividades9a5_dueStart.js            (hoy CDMX)

require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const DEFAULT_ACT_URL = "https://wlserver-production.up.railway.app/api/actividades";
const DEFAULT_REV_URL =
  "https://wlserver-production.up.railway.app/api/reportes/revisiones-por-fecha";

const TZ = "America/Mexico_City";
const START_HOUR = 9;
const END_HOUR = 17; // exclusivo
const PRODUCTIVO_MIN = 480;

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
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // noon UTC avoids DST edges
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
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

  const hour = Number(h);
  const minute = Number(min);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  return { date: `${y}-${m}-${d}`, hour, minute };
}

function getTodayISOInTZ(timeZone) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now); // YYYY-MM-DD
}

function resolveDayArg(arg) {
  if (!arg || String(arg).trim() === "" || String(arg).toLowerCase() === "today") {
    return getTodayISOInTZ(TZ);
  }
  return String(arg).trim();
}

function debeExcluirActividad(sched) {
  const titulo = String(sched?.titulo ?? "").toLowerCase();
  const status = String(sched?.status ?? "").toLowerCase();
  const tipo = String(sched?.tipo ?? "").toLowerCase();

  const hit = (s) => s.includes("ftf") || s.includes("00sec");
  return hit(titulo) || hit(status) || hit(tipo);
}

function isDueStartBetween9and5Local(dueStartStr, day, timeZone) {
  if (!dueStartStr) return { ok: false, reason: "no_dueStart" };

  const dt = new Date(dueStartStr);
  const local = getLocalParts(dt, timeZone);
  if (!local) return { ok: false, reason: "bad_date" };

  if (local.date !== day) return { ok: false, reason: `date_mismatch(local=${local.date})` };

  const minutes = local.hour * 60 + local.minute;
  const start = START_HOUR * 60;
  const end = END_HOUR * 60;

  if (minutes < start) return { ok: false, reason: `before_9(local=${local.hour}:${local.minute})` };
  if (minutes >= end) return { ok: false, reason: `after_5(local=${local.hour}:${local.minute})` };

  return { ok: true, reason: "ok" };
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

async function fetchActividadesById(actUrl, startDay, endDay) {
  const { data } = await axios.get(actUrl, { params: { start: startDay, end: endDay } });
  const list = Array.isArray(data?.data) ? data.data : [];
  const byId = new Map();

  for (const a of list) {
    if (!a?.id) continue;
    byId.set(a.id, {
      id: a.id,
      dueStart: a.dueStart ?? null,
      titulo: a.titulo ?? "",
      status: a.status ?? "",
      tipo: a.tipo ?? "",
    });
  }

  return { byId, totalFetched: list.length };
}

async function fetchColaboradores(revUrl, day) {
  const { data } = await axios.get(revUrl, { params: { date: day } });
  return Array.isArray(data?.data?.colaboradores) ? data.data.colaboradores : [];
}

function sumRevisionesYMinutos(col, validActIds) {
  const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];

  let revisiones = 0;
  let minutos = 0;

  const buckets = ["terminadas", "confirmadas", "pendientes"];

  for (const a of acts) {
    const actId = a?.id;
    if (!actId || !validActIds.has(actId)) continue;

    for (const b of buckets) {
      const revs = Array.isArray(a?.[b]) ? a[b] : [];
      for (const r of revs) {
        const dur = Number(r?.duracionMin ?? 0) || 0;
        if (dur > 0) {
          revisiones += 1;
          minutos += dur;
        }
      }
    }
  }

  return { revisiones, minutos };
}

(async () => {
  const day = resolveDayArg(process.argv[2]);

  const ACT_URL = process.env.WL_ACTIVIDADES_URL || DEFAULT_ACT_URL;
  const REV_URL = process.env.WL_REVISIONES_POR_FECHA_URL || DEFAULT_REV_URL;

  // Traer amplio rango por offsets +00:00 en dueStart
  const startDay = addDaysISO(day, -3);
  const endDay = addDaysISO(day, +3);

  try {
    const [actRes, colaboradores] = await Promise.all([
      fetchActividadesById(ACT_URL, startDay, endDay),
      fetchColaboradores(REV_URL, day),
    ]);

    const actividadesById = actRes.byId;

    // Debug global
    let totalActRefs = 0;
    let notFoundInActividades = 0;
    let hasDueStart = 0;
    let excludedByFtf00sec = 0;
    let passedTimeFilter = 0;

    const sampleReasons = [];

    const rows = [];

    for (const col of colaboradores) {
      const userId = col?.idAsignee;
      if (!userId) continue;

      const userName = resolveUserName(col);
      const validActIds = new Set();

      const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];
      for (const a of acts) {
        const actId = a?.id;
        if (!actId) continue;

        totalActRefs++;

        const sched = actividadesById.get(actId);
        if (!sched) {
          notFoundInActividades++;
          continue;
        }

        if (sched.dueStart) hasDueStart++;

        // ✅ Excluir ftf / 00sec (antes de tiempo)
        if (debeExcluirActividad(sched)) {
          excludedByFtf00sec++;
          continue;
        }

        const res = isDueStartBetween9and5Local(sched.dueStart, day, TZ);
        if (res.ok) {
          validActIds.add(actId);
          passedTimeFilter++;
        } else if (sampleReasons.length < 10) {
          sampleReasons.push({ actId, dueStart: sched.dueStart, reason: res.reason });
        }
      }

      const { revisiones, minutos } = sumRevisionesYMinutos(col, validActIds);

      rows.push({
        date: day,
        user_id: userId,
        colaborador: userName,
        actividades_9a5_dueStart: validActIds.size,
        revisiones,
        tiempo_total: minutos,
        productivo: minutos >= PRODUCTIVO_MIN ? 1 : 0,
      });
    }

    const outDir = ensureOutDir();
    const outPath = path.join(outDir, `dataset_${day}_9a5_dueStart.csv`);

    const header = [
      "date",
      "user_id",
      "colaborador",
      "actividades_9a5_dueStart",
      "revisiones",
      "tiempo_total",
      "productivo",
    ];

    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.date,
          r.user_id,
          escCsv(r.colaborador),
          r.actividades_9a5_dueStart,
          r.revisiones,
          r.tiempo_total,
          r.productivo,
        ].join(",")
      );
    }

    fs.writeFileSync(outPath, lines.join("\n"), "utf8");

    console.log("✅ CSV generado:");
    console.log(`📁 ${outPath}`);
    console.log(`👥 Usuarios: ${rows.length}`);
    console.log(`🧾 Actividades traídas de /actividades: ${actRes.totalFetched}`);
    console.log(`🗓️ Rango consultado: ${startDay} → ${endDay}`);
    console.log(`⏱️ Ventana: ${START_HOUR}:00 → ${END_HOUR}:00 (CDMX) | solo dueStart | mismo día`);

    console.log("\n=== DEBUG ===");
    console.log(`Refs de actividades desde el reporte (sum): ${totalActRefs}`);
    console.log(`No encontradas en /actividades (por ID):   ${notFoundInActividades}`);
    console.log(`Con dueStart encontrado:                  ${hasDueStart}`);
    console.log(`Excluidas por ftf/00sec (titulo/status/tipo): ${excludedByFtf00sec}`);
    console.log(`Pasaron filtro 9-5 (dueStart local):      ${passedTimeFilter}`);

    if (sampleReasons.length) {
      console.log("\nEjemplos que NO pasan filtro (con razón):");
      for (const s of sampleReasons) {
        console.log(`- ${s.actId} | dueStart=${s.dueStart} | ${s.reason}`);
      }
    }
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
