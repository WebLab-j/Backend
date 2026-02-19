// file: src/server.js
"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");

const { syncRange } = require("./services/syncService");
const { filterActividadesByWindow } = require("./utils/timeWindow");
const { startWlSocketListener } = require("./realtime/wlSocketListener");
const { applyRevisionEvent, applyRevisionDeletedEvent, findDaysWithActividad, getDayRaw } = require("./realtime/rawStore");
const { upsertFromEvent, resolve } = require("./realtime/revisionIndex");
const http = require("http");
const { initUiSocket, emitDayUpdate, emitBroadcast } = require("./realtime/uiSocket");
const { recomputarFilaUsuario, updateCachedUsers } = require("../api/productividad.hoy.routes");



const {
  markStaleAll,
  markStaleDay,
  markStaleUser,
} = require("./realtime/staleStore");


const app = express();
app.use(express.json());

const TZ = process.env.TZ || "America/Mexico_City";

function toDayISOInTZ(dateStr, timeZone = TZ) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;

  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function todayISOInTZ(timeZone = TZ) {
  return toDayISOInTZ(new Date(), timeZone);
}


/**
 * Helpers: ids y días afectados por evento (agenda + hecho)
 */
function extractUserIds(payload) {
  const ids = Array.isArray(payload?.assignees)
    ? payload.assignees.map((a) => a?.id).filter(Boolean)
    : [];
  return Array.from(new Set(ids));
}


/**
 * Devuelve TODOS los días que podrían verse afectados por el evento:
 * - agenda: dueStart
 * - hecho: fechaFinTerminada / fechaCreacion / fechaCreacionImportante (fallback)
 */
function extractAffectedDays(payload) {
  const days = new Set();

  const dueDay = toDayISOInTZ(payload?.dueStart);
  if (dueDay) days.add(dueDay);

  const finDay = toDayISOInTZ(payload?.fechaFinTerminada);
  if (finDay) days.add(finDay);

  const creDay = toDayISOInTZ(payload?.fechaCreacion);
  if (creDay) days.add(creDay);

  const impDay = toDayISOInTZ(payload?.fechaCreacionImportante);
  if (impDay) days.add(impDay);

  return Array.from(days);
}


/**
 * CORS
 * - En prod, usa CORS_ORIGINS="https://a.com,https://b.com"
 * - En dev, fallback a lista hardcodeada.
 */
const defaultAllowedOrigins = [
  "http://localhost:3000",
  "https://analizador-front.vercel.app",
  "https://analizador-weblab.vercel.app",
];

const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const finalAllowedOrigins = allowedOrigins.length ? allowedOrigins : defaultAllowedOrigins;

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (!finalAllowedOrigins.includes(origin)) {
        return callback(new Error("CORS not allowed"), false);
      }
      return callback(null, true);
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  }),
);

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/sync", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: "Faltan query params start y end (YYYY-MM-DD)" });
    }
    const result = await syncRange(start, end);
    return res.json({ success: true, result });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/debug/actividades-9-5", async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, error: "Falta ?date=YYYY-MM-DD" });

    const { data: actividadesRaw } = await axios.get(process.env.WL_ACTIVIDADES_URL, {
      params: { start: date, end: date },
    });

    const actividadesAll = Array.isArray(actividadesRaw?.data) ? actividadesRaw.data : [];
    const { kept, minutosPlaneadosEnVentana } = filterActividadesByWindow(
      actividadesAll,
      date,
      9,
      17,
      ["00Sec", "ftf"],
    );

    return res.json({
      success: true,
      date,
      window: "09:00-17:00",
      total: kept.length,
      minutosPlaneadosEnVentana,
      actividades: kept,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/debug/revisiones-por-actividad-rango", async (req, res) => {
  try {
    const { start, end, actividadId } = req.query;

    if (!start || !end || !actividadId) {
      return res.status(400).json({
        success: false,
        error: "Falta ?start=YYYY-MM-DD&end=YYYY-MM-DD&actividadId=...",
      });
    }

    const { data: revisionesRaw } = await axios.get(process.env.WL_REVISIONES_URL, {
      params: { start, end },
    });

    function normalizeRevisionesRobusto(raw) {
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      if (Array.isArray(raw?.data)) return raw.data;

      const out = [];
      const data = raw?.data;
      const colaboradores = Array.isArray(data?.colaboradores) ? data.colaboradores : [];

      for (const col of colaboradores) {
        const assignee_id = col?.idAsignee ?? null;
        const assignee_name = col?.name ?? null;

        const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];
        for (const act of acts) {
          const actividad_id = act?.id ?? null;
          const actividad_titulo = act?.titulo ?? null;

          const terminadas = Array.isArray(act?.terminadas) ? act.terminadas : [];
          for (const rev of terminadas) {
            out.push({
              revision_id: rev?.id ?? null,
              actividad_id,
              actividad_titulo,
              assignee_id,
              assignee_name,
              terminada: !!rev?.terminada,
              confirmada: !!rev?.confirmada,
              nombre: rev?.nombre ?? null,
              fuente: "reporte:terminadas",
            });
          }

          const confirmadas = Array.isArray(act?.confirmadas) ? act.confirmadas : [];
          for (const rev of confirmadas) {
            out.push({
              revision_id: rev?.id ?? null,
              actividad_id,
              actividad_titulo,
              assignee_id,
              assignee_name,
              terminada: !!rev?.terminada,
              confirmada: !!rev?.confirmada,
              nombre: rev?.nombre ?? null,
              fuente: "reporte:confirmadas",
            });
          }
        }
      }

      const possibleList =
        (Array.isArray(raw?.data?.revisiones) && raw.data.revisiones) ||
        (Array.isArray(raw?.data?.items) && raw.data.items) ||
        null;

      if (possibleList) {
        for (const r of possibleList) {
          const actIds = Array.isArray(r?.actividades)
            ? r.actividades.map((a) => a?.id).filter(Boolean)
            : [];
          for (const actId of actIds) {
            out.push({
              revision_id: r?.id ?? null,
              actividad_id: actId,
              actividad_titulo: null,
              assignee_id: null,
              assignee_name: null,
              terminada: !!r?.terminada,
              confirmada: !!r?.confirmada,
              nombre: r?.nombre ?? null,
              fuente: "lista:actividades[]",
            });
          }
        }
      }

      return out;
    }

    const revisionesAll = normalizeRevisionesRobusto(revisionesRaw);
    const revisiones = revisionesAll.filter((r) => r?.actividad_id === actividadId);

    return res.json({
      success: true,
      start,
      end,
      actividadId,
      total: revisiones.length,
      revisiones,
      debug: { revisionesAll: revisionesAll.length },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * Cron diario
 */
cron.schedule(
  "0 8 * * *",
  async () => {
    try {
      const now = new Date();
      const y = new Date(now);
      y.setDate(now.getDate() - 1);
      const ymd = toDayISOInTZ(y, TZ);
      await syncRange(ymd, ymd);
      console.log("Cron sync ok:", ymd);
    } catch (e) {
      console.error("Cron sync failed:", e.message);
    }
  },
  { timezone: process.env.TZ || "America/Mexico_City" },
);

// Routes
const productividadHoyRoutes = require("../api/productividad.hoy.routes");
app.use("/api/productividad", productividadHoyRoutes);

/**
 * Socket listener
 * ENV: WL_SOCKET_URL=https://wlserver-production-6735.up.railway.app
 */
try {
  const socketUrl = process.env.WL_SOCKET_URL;
  if (socketUrl) {
    startWlSocketListener({
      socketUrl,
      handleEvent: async (eventName, payload, meta) => {
        const revisionId = payload?.id ?? payload?._id ?? null;

        const actividadId = Array.isArray(payload?.actividadesRelacionadas)
          ? payload.actividadesRelacionadas[0]
          : null;

        const today = todayISOInTZ();

        let userIds = extractUserIds(payload);
        let days = extractAffectedDays(payload);

        
        // 2) Si viene incompleto (muy común en creada/eliminada), intenta resolver con el índice
        if ((days.length === 0 || userIds.length === 0) && revisionId) {
          const fromIdx = resolve(revisionId);
          if (fromIdx) {
            if (days.length === 0) days = Array.isArray(fromIdx.days) ? fromIdx.days : [];
            if (userIds.length === 0) userIds = Array.isArray(fromIdx.userIds) ? fromIdx.userIds : [];
          }
        }

        // 3) Stale SIN tirar todo el sistema
        if (days.length === 0 && userIds.length === 0) {
          // antes: markStaleAll()  ❌  => esto te obliga a recompute full (WL)
          markStaleDay(today); // ✅ degradado pero seguro
        } else if (days.length === 0 && userIds.length > 0) {
          for (const uid of userIds) markStaleUser(today, uid);
        } else if (userIds.length === 0) {
          for (const d of days) markStaleDay(d);
        } else {
          for (const d of days) for (const uid of userIds) markStaleUser(d, uid);
        }

        // 4) Patch RAW (si days viene vacío, parchea hoy al menos)
        // 4) Patch RAW: además de "days" por fechas, parchea también los días que YA tienen esa actividad en el raw cache
const patchDaysSet = new Set(days);

// Si la actividad existe en raw cache de otros días, esos días también deben parchearse
if (actividadId) {
  const daysByActividad = findDaysWithActividad(actividadId); // <-- ya lo importas arriba
  for (const d of daysByActividad) patchDaysSet.add(d);
}

// fallback seguro
if (patchDaysSet.size === 0) patchDaysSet.add(today);
patchDaysSet.add(today);
const daysForPatch = Array.from(patchDaysSet);

if (eventName === "revision_creada" || eventName === "revision_actualizada") {
  upsertFromEvent({ revisionId, days: [today], userIds, actividadId });
}

// ✅ siempre parchea sobre el RAW de hoy
let touchedUserIds = [];
let actividadIdFromPatch = actividadId;

if (eventName === "revision_creada" || eventName === "revision_actualizada") {
  const r = applyRevisionEvent(today, payload);
  touchedUserIds = Array.isArray(r?.touchedUserIds) ? r.touchedUserIds : [];
  actividadIdFromPatch = r?.actividadId ?? actividadIdFromPatch;
  console.log("[RAW PATCH]", { day: today, eventName, touched: touchedUserIds, actividadId: actividadIdFromPatch });
}

if (eventName === "revision_eliminada") {
  const r = applyRevisionDeletedEvent(today, payload);
  touchedUserIds = Array.isArray(r?.touchedUserIds) ? r.touchedUserIds : [];
  console.log("[RAW PATCH]", { day: today, eventName, touched: touchedUserIds, revisionId });
}

if (touchedUserIds.length > 0) {
  const raw = getDayRaw(today);
  const updatedUsers = [];

  // ✅ determina el modo según el payload
  const useFechaCreacion = payload?.terminadaPendienteRevision === true
    || payload?.confirmacion === true
    || !!payload?.fechaFinTerminada;

  if (raw?.actividadesById && raw?.colaboradoresRaw) {
    for (const uid of touchedUserIds) {
      try {
        const fila = await recomputarFilaUsuario(
          today, useFechaCreacion, uid,
          raw.actividadesById,
          raw.colaboradoresRaw,
        );
        if (fila) updatedUsers.push(fila);
      } catch (e) {
        console.error("[recompute]", uid, e?.message);
      }
    }
  }
  // después de calcular updatedUsers...
// ✅ así debe quedar
if (updatedUsers.length > 0) {
  updateCachedUsers(today, true, updatedUsers);  // modo hecho
  updateCachedUsers(today, false, updatedUsers); // modo agenda
}
  console.log("[EMIT]", { today, updatedUsers: updatedUsers.length });
  emitDayUpdate(today, { // ✅ siempre emite al día de hoy
    kind: "users_changed",
    day: today,
    eventName,
    userIds: touchedUserIds,
    actividadId: actividadIdFromPatch,
    revisionId,
    ts: meta?.ts || new Date().toISOString(),
    updatedUsers,
  });
}
        
        console.log("[STALE MARK]", {
          eventName,
          id: revisionId,
          days,
          userIds,
          actividadId,
          ts: meta?.ts,
          dates: {
            dueStart: payload?.dueStart ?? null,
            fechaFinTerminada: payload?.fechaFinTerminada ?? null,
            fechaCreacion: payload?.fechaCreacion ?? null,
            fechaCreacionImportante: payload?.fechaCreacionImportante ?? null,
          },
        });
      },

    });
  } else {
    console.warn("[wlSocketListener] WL_SOCKET_URL not set, skipping socket listener");
  }
} catch (e) {
  console.error("[wlSocketListener] failed to start:", e?.message || e);
}

// Render: escucha en 0.0.0.0 y process.env.PORT
const port = Number(process.env.PORT || 3001);
const httpServer = http.createServer(app);

// CORS origins: reusa lo que ya tienes
initUiSocket(httpServer, { corsOrigins: finalAllowedOrigins });

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`API running on port ${port}`);
});