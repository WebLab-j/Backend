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
const { applyRevisionEvent, applyRevisionDeletedEvent, findDaysWithActividad, getDayRaw, hasDayRaw } = require("./realtime/rawStore");
const { upsertFromEvent, resolve } = require("./realtime/revisionIndex");
const http = require("http");
const { initUiSocket, emitDayUpdate, emitBroadcast } = require("./realtime/uiSocket");
const { recomputarFilaUsuario, updateCachedUsers, upsertDetalleCacheFromRawForUsers } = require("../api/productividad.hoy.routes");
// ✅ busca en actividadesCache directamente (siempre disponible si hubo fetch)
const { fetchActividades } = require("../api/productividad.hoy.routes");




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
        if (eventName === "revision_eliminada") {
      console.log(
        "[REVISION ELIMINADA RAW]\n",
        JSON.stringify(
          {
            eventName,
            payload,
            meta,
            payloadKeys: payload ? Object.keys(payload) : []
          },
          null,
          2
        )
      );
    }
        const revisionId = payload?.id ?? payload?._id ?? null;

        const actividadId = Array.isArray(payload?.actividadesRelacionadas)
          ? payload.actividadesRelacionadas[0]
          : null;

        const today = todayISOInTZ();

        let userIds = extractUserIds(payload);
        let days = extractAffectedDays(payload);

        // 2) Resolver incompleto por índice
        if ((days.length === 0 || userIds.length === 0) && revisionId) {
          const fromIdx = resolve(revisionId);
          if (fromIdx) {
            if (days.length === 0) days = Array.isArray(fromIdx.days) ? fromIdx.days : [];
            if (userIds.length === 0) userIds = Array.isArray(fromIdx.userIds) ? fromIdx.userIds : [];
          }
        }

        // 3) Stale marks (lo tuyo)
        if (days.length === 0 && userIds.length === 0) {
          markStaleDay(today);
        } else if (days.length === 0 && userIds.length > 0) {
          for (const uid of userIds) markStaleUser(today, uid);
        } else if (userIds.length === 0) {
          for (const d of days) markStaleDay(d);
        } else {
          for (const d of days) for (const uid of userIds) markStaleUser(d, uid);
        }

        // 4) Decide días a parchear (dias por fechas + dias donde ya existe la actividad en raw)
        // 4) Decide días a parchear (dias por fechas + dias donde ya existe la actividad en raw)
        const patchDaysSet = new Set(days);

        if (actividadId) {
          const daysByActividad = findDaysWithActividad(actividadId);

          for (const d of daysByActividad) {
            // ✅ solo si realmente tenemos RAW en memoria y/o si es cacheable
            if (!hasDayRaw(d)) continue;     // <- necesitas importar hasDayRaw del rawStore
            //if (!canCache(d, TZ)) continue; // <- opcional pero recomendado
            patchDaysSet.add(d);
          }
        }

        if (patchDaysSet.size === 0) patchDaysSet.add(today);
        patchDaysSet.add(today);

        const daysForPatch = Array.from(patchDaysSet);

        // Index (lo tuyo)
        if (eventName === "revision_creada" || eventName === "revision_actualizada") {
          upsertFromEvent({ revisionId, days: [today], userIds, actividadId });
        }

        // ✅ Patch RAW (IMPORTANTE: parchea TODOS los daysForPatch, no solo today)
        const touchedByDay = new Map(); // day -> touchedUserIds[]
        let actividadIdFromPatch = actividadId;

        for (const day of daysForPatch) {
          if (eventName === "revision_creada" || eventName === "revision_actualizada") {
            const r = applyRevisionEvent(day, payload);
            const touched = Array.isArray(r?.touchedUserIds) ? r.touchedUserIds : [];
            if (touched.length > 0) touchedByDay.set(day, touched);
            actividadIdFromPatch = r?.actividadId ?? actividadIdFromPatch;

            if (touched.length > 0) {
              console.log("[RAW PATCH]", { day, eventName, touched, actividadId: actividadIdFromPatch });
            }
          }

          if (eventName === "revision_eliminada") {
            const r = applyRevisionDeletedEvent(day, payload);
            const touched = Array.isArray(r?.touchedUserIds) ? r.touchedUserIds : [];
            if (touched.length > 0) touchedByDay.set(day, touched);

            if (touched.length > 0) {
              console.log("[RAW PATCH]", { day, eventName, touched, revisionId });
            }
          }
        }

        // Si nadie fue tocado en ningún día, no hay nada que hacer
        if (touchedByDay.size === 0) {
  const fallbackDays = (days && days.length) ? days : [today];
  const fallbackUsers = (userIds && userIds.length) ? userIds : [];

  const revisionInfo = {
    nombreActividad: null,
    nombreRevision: payload?.nombre ?? null,
    horario: payload?.dueStart ?? null,
  };

  for (const d of fallbackDays) {
    emitDayUpdate(d, {
      kind: "detalle_changed",
      day: d,
      eventName,               // ✅
      userIds: fallbackUsers,
      actividadId,
      revisionId,
      ts: meta?.ts || new Date().toISOString(),
      revisionInfo,            // ✅
    });
  }
  return;
}

        // ✅ Por cada día tocado: actualiza resultadoDiaCache + detalleCache + emit (si quieres)
        for (const [day, touchedUserIds] of touchedByDay.entries()) {
          const raw = getDayRaw(day);
          if (!raw?.actividadesById || !raw?.colaboradoresRaw) continue;

          // --------- (A) TU LOGICA: recomputar filas y actualizar resultadoDiaCache ----------
          const updatedUsers = [];

          const useFechaCreacion =
            payload?.terminadaPendienteRevision === true ||
            payload?.confirmacion === true ||
            !!payload?.fechaFinTerminada;

          for (const uid of touchedUserIds) {
            try {
              const fila = await recomputarFilaUsuario(
                day,
                useFechaCreacion,
                uid,
                raw.actividadesById,
                raw.colaboradoresRaw,
              );
              if (fila) updatedUsers.push(fila);
            } catch (e) {
              console.error("[recompute]", uid, e?.message);
            }
          }

          if (updatedUsers.length > 0) {
            updateCachedUsers(day, true, updatedUsers);  // hecho
            updateCachedUsers(day, false, updatedUsers); // agenda
          }

          // --------- (B) ✅ AQUI VA LO QUE TU QUIERES: actualizar cache DETALLE con el evento ----------
          // Esto recalcula y sobreescribe el cache del detalle usando el RAW ya parcheado
          try {
            await Promise.all([
              upsertDetalleCacheFromRawForUsers({ day, userIds: touchedUserIds, hours: "work", mode: "agenda" }),
              upsertDetalleCacheFromRawForUsers({ day, userIds: touchedUserIds, hours: "work", mode: "hecho" }),
              // opcional si usas cache por "auto"
              upsertDetalleCacheFromRawForUsers({ day, userIds: touchedUserIds, hours: "work", mode: "auto" }),
            ]);

            console.log("[DETALLE CACHE UPSERT]", { day, users: touchedUserIds.length, modes: ["agenda", "hecho", "auto"] });
          } catch (e) {
            console.error("[DETALLE CACHE UPSERT] error:", e?.message || e);
          }

          // --------- debug correcto de Map (opcional) ----------
          const keysSample =
            raw.actividadesById instanceof Map
              ? Array.from(raw.actividadesById.keys()).slice(0, 3)
              : [];

          const actInfo =
            (raw.actividadesById instanceof Map && actividadIdFromPatch)
              ? raw.actividadesById.get(actividadIdFromPatch)
              : null;

          console.log("[ACTIVIDAD BUSQUEDA]", {
            day,
            actividadIdFromPatch,
            tieneRaw: !!raw,
            tieneActividadesById: raw.actividadesById instanceof Map,
            keys: keysSample,
            encontrada: actInfo ?? null,
          });

          let nombreActividad = null;
let horario = null;

if (raw?.actividadesById instanceof Map && actividadIdFromPatch) {
  const act = raw.actividadesById.get(actividadIdFromPatch);
  if (act) {
    nombreActividad = act?.titulo ?? null;
    horario = act?.dueStart ?? null;
  }
}

// fallback si raw no tiene la actividad
if (!horario) horario = payload?.dueStart ?? null;

const revisionInfo = {
  nombreActividad,
  nombreRevision: payload?.nombre ?? null,
  horario,
};

          // --------- emit al front (puedes mandar señal o datos) ----------
          emitDayUpdate(day, {
  kind: "users_changed",
  day,
  eventName,
  userIds: touchedUserIds,
  actividadId: actividadIdFromPatch,
  revisionId,
  useFechaCreacion,
  ts: meta?.ts || new Date().toISOString(),
  updatedUsers,
  revisionInfo, // ✅
});

emitDayUpdate(day, {
  kind: "detalle_changed",
  day,
  eventName, // ✅ MUY IMPORTANTE
  userIds: touchedUserIds,
  revisionId,
  actividadId: actividadIdFromPatch,
  ts: meta?.ts || new Date().toISOString(),
  revisionInfo, // ✅
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