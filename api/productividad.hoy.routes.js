// /routes/productividad.js
"use strict";

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const http = require("http");
const https = require("https");

const router = express.Router();

const DEFAULT_ACT_URL =
  "https://wlserver-production-6735.up.railway.app/api/actividades";
const DEFAULT_REV_URL =
  "https://wlserver-production-6735.up.railway.app/api/reportes/revisiones-por-fecha";

const TZ = "America/Mexico_City";
const START_HOUR = 9;
const END_HOUR = 17; // exclusivo
const START_MIN = START_HOUR * 60;
const END_MIN = END_HOUR * 60;

const USERS_SEARCH_URL =
  process.env.WL_USERS_SEARCH_URL ||
  "https://wlserver-production-6735.up.railway.app/api/users/search";

const ALLOW_DOMAINS = new Set(["pprin.com", "practicante.com"]);

const DEBUG = String(process.env.DEBUG_PRODUCTIVIDAD || "").trim() === "1";
function log(...args) {
  if (DEBUG) console.log(...args);
}

// ---- axios (keep-alive + timeout + retry) ----

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

const axiosClient = axios.create({
  timeout: Number(process.env.HTTP_TIMEOUT_MS || 12_000),
  httpAgent,
  httpsAgent,
  maxRedirects: 3,
  validateStatus: (s) => s >= 200 && s < 300,
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableAxiosError(err) {
  const code = err?.code || "";
  const status = err?.response?.status;

  if (status && [408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  if (["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNABORTED"].includes(code))
    return true;

  return false;
}

async function requestWithRetry(fn, { retries = 2, baseDelayMs = 250 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !isRetryableAxiosError(err)) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
}

// ---- caches ----

// userId -> { email, name, phone, ts }
const userCache = new Map();
const USER_TTL_MS = 24 * 60 * 60 * 1000;

// userId -> name
const userNameCache = new Map();

// actividadesCache: day -> { byId: Map, ts }
const actividadesCache = new Map();
const ACT_CACHE_TTL_MS = 5 * 60 * 1000;

// in-flight dedupe: key -> Promise
const inFlight = new Map();

// localPartsCache: tz|minuteBucket -> {date,hour,minute}
const localPartsCache = new Map();
const LOCAL_PARTS_CACHE_MAX = 20_000;

const SWITCH_CUTOFF_HOUR = Number(process.env.SWITCH_CUTOFF_HOUR || 10);

function parseMode(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "agenda" || v === "hecho") return v;
  return "auto";
}

function pruneMapToMaxSize(map, max) {
  if (map.size <= max) return;
  const over = map.size - max;
  let i = 0;
  for (const k of map.keys()) {
    map.delete(k);
    if (++i >= over) break;
  }
}

// ---- domain helpers ----

function domainOf(email) {
  const e = String(email || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  return at >= 0 ? e.slice(at + 1) : "";
}

function allowedByEmail(email) {
  return ALLOW_DOMAINS.has(domainOf(email));
}

// ---- Intl formatters (reuse) ----

const todayFmtByTz = new Map();
function getTodayFormatter(timeZone) {
  let fmt = todayFmtByTz.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    todayFmtByTz.set(timeZone, fmt);
  }
  return fmt;
}

const partsFmtByTz = new Map();
function getPartsFormatter(timeZone) {
  let fmt = partsFmtByTz.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      hourCycle: "h23",
    });
    partsFmtByTz.set(timeZone, fmt);
  }
  return fmt;
}

function getTodayISOInTZ(timeZone) {
  return getTodayFormatter(timeZone).format(new Date());
}

function getLocalParts(dateObj, timeZone) {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return null;

  // cache por minuto (reduce cardinalidad x60)
  const minuteBucket = Math.floor(dateObj.getTime() / 60_000);
  const key = `${timeZone}|${minuteBucket}`;

  const cached = localPartsCache.get(key);
  if (cached) return cached;

  const fmt = getPartsFormatter(timeZone);
  const parts = fmt.formatToParts(dateObj);

  let y, m, d, h, min;
  for (const p of parts) {
    if (p.type === "year") y = p.value;
    else if (p.type === "month") m = p.value;
    else if (p.type === "day") d = p.value;
    else if (p.type === "hour") h = p.value;
    else if (p.type === "minute") min = p.value;
  }
  if (!y || !m || !d || h == null || min == null) return null;

  const value = { date: `${y}-${m}-${d}`, hour: Number(h), minute: Number(min) };
  localPartsCache.set(key, value);
  pruneMapToMaxSize(localPartsCache, LOCAL_PARTS_CACHE_MAX);
  return value;
}

function isBetweenWorkHoursLocal(dateStr, day, timeZone, noDateReason) {
  if (!dateStr) return { ok: false, reason: noDateReason };

  const dt = new Date(dateStr);
  const local = getLocalParts(dt, timeZone);
  if (!local) return { ok: false, reason: "bad_date" };

  if (local.date !== day) return { ok: false, reason: "date_mismatch" };

  const minutes = local.hour * 60 + local.minute;
  if (minutes < START_MIN) return { ok: false, reason: "before_9" };
  if (minutes >= END_MIN) return { ok: false, reason: "after_5" };

  return { ok: true, reason: "ok" };
}

function isDueStartBetween9and5Local(dueStartStr, day, timeZone) {
  return isBetweenWorkHoursLocal(dueStartStr, day, timeZone, "no_dueStart");
}

function isFechaCreacionBetween9and5Local(fechaCreacionStr, day, timeZone) {
  return isBetweenWorkHoursLocal(
    fechaCreacionStr,
    day,
    timeZone,
    "no_fechaCreacion"
  );
}

// regex precompilado
const ftfRegex = /ftf|00sec/i;
function esFtf00secPorTitulo(titulo) {
  return ftfRegex.test(String(titulo ?? ""));
}

// ---- today check ----

function isToday(dateStr, timeZone) {
  return dateStr === getTodayISOInTZ(timeZone);
}

function getDefaultModeForDay(day) {
  if (!isToday(day, TZ)) return "hecho";
  const nowLocal = getLocalParts(new Date(), TZ);
  const hour = nowLocal?.hour ?? 0;
  return hour < SWITCH_CUTOFF_HOUR ? "agenda" : "hecho";
}

// ---- user fetching ----

async function fetchUserByIdViaSearch(userId) {
  if (!userId) return { email: "", name: "", phone: "" };

  const hit = userCache.get(userId);
  const now = Date.now();
  if (hit && now - hit.ts < USER_TTL_MS) return hit;

  try {
    const { data } = await requestWithRetry(() =>
      axiosClient.get(USERS_SEARCH_URL, { params: { q: userId } })
    );

    const items = Array.isArray(data?.items) ? data.items : [];
    const u =
      items.find((x) => x?._id === userId || x?.id === userId) ||
      items[0] ||
      null;

    const email = u?.email || "";
    const phone = u?.phone || "";
    const name =
      [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() ||
      u?.name ||
      "";

    const norm = { email, name, phone, ts: now };
    userCache.set(userId, norm);
    return norm;
  } catch {
    const norm = { email: "", name: "", phone: "", ts: now };
    userCache.set(userId, norm);
    return norm;
  }
}

async function resolveUsersMap(userIds, concurrency = 4) {
  const ids = Array.from(new Set(userIds)).filter(Boolean);
  const out = new Map();
  let i = 0;

  async function worker() {
    while (i < ids.length) {
      const idx = i++;
      const id = ids[idx];
      const info = await fetchUserByIdViaSearch(id);
      out.set(id, info);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, ids.length) },
    () => worker()
  );
  await Promise.all(workers);
  return out;
}

// ---- resolve user name (cache) ----

function resolveUserName(col) {
  if (col?.name) return col.name;

  const userId = col?.idAsignee;
  if (!userId) return "unknown";

  const cached = userNameCache.get(userId);
  if (cached) return cached;

  const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];
  for (const a of acts) {
    for (const bucket of ["terminadas", "confirmadas", "pendientes"]) {
      const revs = Array.isArray(a?.[bucket]) ? a[bucket] : [];
      for (const r of revs) {
        const asg = Array.isArray(r?.assignees) ? r.assignees : [];
        const hit = asg.find((x) => x?.id === userId && x?.name);
        if (hit?.name) {
          userNameCache.set(userId, hit.name);
          return hit.name;
        }
      }
    }
  }

  const fallback = userId || "unknown";
  userNameCache.set(userId, fallback);
  return fallback;
}

// ---- data fetching (with in-flight dedupe) ----

async function deduped(key, fn) {
  const hit = inFlight.get(key);
  if (hit) return hit;

  const p = (async () => {
    try {
      return await fn();
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, p);
  return p;
}

async function fetchActividades(day) {
  const cached = actividadesCache.get(day);
  const now = Date.now();
  if (cached && now - cached.ts < ACT_CACHE_TTL_MS) return cached.byId;

  return deduped(`act:${day}`, async () => {
    const again = actividadesCache.get(day);
    const againNow = Date.now();
    if (again && againNow - again.ts < ACT_CACHE_TTL_MS) return again.byId;

    const actUrl = process.env.WL_ACTIVIDADES_URL || DEFAULT_ACT_URL;

    const { data } = await requestWithRetry(() =>
      axiosClient.get(actUrl, { params: { start: day, end: day } })
    );

    const list = Array.isArray(data?.data) ? data.data : [];
    const byId = new Map();

    for (const a of list) {
      if (!a?.id) continue;
      byId.set(a.id, {
        id: a.id,
        dueStart: a.dueStart ?? null,
        titulo: a.titulo ?? "",
      });
    }

    actividadesCache.set(day, { byId, ts: Date.now() });
    return byId;
  });
}

async function fetchColaboradores(day) {
  return deduped(`col:${day}`, async () => {
    const revUrl = process.env.WL_REVISIONES_POR_FECHA_URL || DEFAULT_REV_URL;

    const { data } = await requestWithRetry(() =>
      axiosClient.get(revUrl, { params: { date: day } })
    );

    return Array.isArray(data?.data?.colaboradores) ? data.data.colaboradores : [];
  });
}

// ---- exclude filters ----

const EXCLUDE_USER_IDS = new Set(["2dad872b594c81c8ae6500026864f907"]);
const EXCLUDE_USER_IDS2 = new Set(["2e6d872b594c8100ac680002df5d84c5"]);
const EXCLUDE_USER_IDS3 = new Set(["2edd872b594c818984190002be5174f1"]);
const ALL_EXCLUDED_IDS = new Set([
  ...EXCLUDE_USER_IDS,
  ...EXCLUDE_USER_IDS2,
  ...EXCLUDE_USER_IDS3,
]);

// ---- concurrency helper (no deps) ----

async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      out[current] = await mapper(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker()
  );
  await Promise.all(workers);
  return out;
}

// ---- HOY (1 pasada) ----

function procesarColaboradorDia_HOY(col, day, actividadesById) {
  const userId = col?.idAsignee;
  if (!userId) return null;

  const userName = resolveUserName(col);

  const validActIds = new Set();
  let revisiones = 0;
  let revisiones_con_duracion = 0;
  let revisiones_sin_duracion = 0;
  let minutos = 0;

  const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];
  const buckets = ["terminadas", "confirmadas", "pendientes"];

  for (const a of acts) {
    const actId = a?.id;
    if (!actId) continue;

    const sched = actividadesById.get(actId);
    if (!sched) continue;

    if (esFtf00secPorTitulo(sched.titulo)) continue;

    const res = isDueStartBetween9and5Local(sched.dueStart, day, TZ);
    if (!res.ok) continue;

    validActIds.add(actId);

    for (const b of buckets) {
      const revs = Array.isArray(a?.[b]) ? a[b] : [];
      for (const r of revs) {
        const dur = Number(r?.duracionMin ?? 0) || 0;
        revisiones += 1;
        if (dur > 0) {
          revisiones_con_duracion += 1;
          minutos += dur;
        } else {
          revisiones_sin_duracion += 1;
        }
      }
    }
  }

  return {
    date: day,
    user_id: userId,
    colaborador: userName,
    actividades: validActIds.size,
    revisiones,
    revisiones_con_duracion,
    revisiones_sin_duracion,
    tiempo_total: minutos,
  };
}

// ---- BÚSQUEDA ----

function procesarColaboradorDia_BUSQUEDA(col, day, actividadesById) {
  const userId = col?.idAsignee;
  if (!userId) return null;

  const userName = resolveUserName(col);

  const actividadesValidas = new Set();
  let revisiones = 0;
  let revisiones_con_duracion = 0;
  let revisiones_sin_duracion = 0;
  let minutos = 0;

  const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];

  for (const a of acts) {
    const actId = a?.id;
    if (!actId) continue;

    const sched = actividadesById.get(actId);
    const titulo = sched?.titulo || a?.titulo || "";

    if (esFtf00secPorTitulo(titulo)) continue;

    const terminadas = Array.isArray(a?.terminadas) ? a.terminadas : [];
    if (terminadas.length === 0) continue;

    actividadesValidas.add(actId);

    for (const r of terminadas) {
      revisiones += 1;
      const dur = Number(r?.duracionMin ?? 0) || 0;
      if (dur > 0) {
        revisiones_con_duracion += 1;
        minutos += dur;
      } else {
        revisiones_sin_duracion += 1;
      }
    }
  }

  return {
    date: day,
    user_id: userId,
    colaborador: userName,
    actividades: actividadesValidas.size,
    revisiones,
    revisiones_con_duracion,
    revisiones_sin_duracion,
    tiempo_total: minutos,
  };
}

async function predecirConModelo(features) {
  const mlBase = process.env.ML_API_BASE || "http://127.0.0.1:8000";
  const url = `${mlBase}/predict`;

  const { data } = await requestWithRetry(
    () =>
      axiosClient.post(url, {
        actividades: features.actividades,
        revisiones_con_duracion: features.revisiones_con_duracion,
        revisiones_sin_duracion: features.revisiones_sin_duracion,
        tiempo_total: features.tiempo_total,
      }),
    { retries: 1 }
  );

  return data;
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function normalizeRevision(r) {
  if (!r || typeof r !== "object") return null;

  const nombre = r.nombre ?? r.name ?? r.titulo ?? r.title ?? null;

  return {
    id: r.id ?? r._id ?? null,
    nombre,
    duracionMin: Number(r?.duracionMin ?? 0) || 0,
    fechaCreacion: r.fechaCreacion ?? r.createdAt ?? null,
    assignees: safeArray(r.assignees).map((a) => ({
      id: a?.id ?? null,
      name: a?.name ?? null,
      email: a?.email ?? null,
    })),
    raw: r,
  };
}

function summarizeActividadBuckets(actividad) {
  const buckets = ["terminadas", "confirmadas", "pendientes"];
  const out = { revisiones: 0, con_duracion: 0, sin_duracion: 0, minutos: 0 };

  for (const b of buckets) {
    const revs = safeArray(actividad?.revisiones?.[b]);
    for (const r of revs) {
      out.revisiones += 1;
      const dur = Number(r?.duracionMin ?? 0) || 0;
      if (dur > 0) {
        out.con_duracion += 1;
        out.minutos += dur;
      } else {
        out.sin_duracion += 1;
      }
    }
  }
  return out;
}

// ✅ Procesar un día
async function procesarDia(day, useBusquedaLogic = false) {
  try {
    const isCurrentDay = isToday(day, TZ);
    const useFechaCreacion = useBusquedaLogic || !isCurrentDay;

    log(
      `[procesarDia] ${day} - isCurrentDay: ${isCurrentDay} - useFechaCreacion: ${useFechaCreacion}`
    );

    const [actividadesById, colaboradoresRaw] = await Promise.all([
      fetchActividades(day),
      fetchColaboradores(day),
    ]);

    const userIds = colaboradoresRaw.map((c) => c?.idAsignee).filter(Boolean);
    const usersInfo = await resolveUsersMap(
      userIds,
      Number(process.env.USERS_CONCURRENCY || 4)
    );

    const colaboradores = colaboradoresRaw.filter((col) => {
      const userId = col?.idAsignee;
      if (!userId) return false;

      if (ALL_EXCLUDED_IDS.has(userId)) {
        log(`[FILTRO] Excluyendo usuario por ID: ${userId}`);
        return false;
      }

      const info = usersInfo.get(userId) || {};
      const email = info.email || "";

      if (!allowedByEmail(email)) {
        log(`[FILTRO] Excluyendo por dominio. userId=${userId} email=${email}`);
        return false;
      }

      return true;
    });

    const rows = useFechaCreacion
      ? colaboradores
          .map((c) => procesarColaboradorDia_BUSQUEDA(c, day, actividadesById))
          .filter(Boolean)
      : colaboradores
          .map((c) => procesarColaboradorDia_HOY(c, day, actividadesById))
          .filter(Boolean);

    const mlConcurrency = Number(process.env.ML_CONCURRENCY || 6);
    const users = await mapLimit(rows, mlConcurrency, async (r) => ({
      ...r,
      prediccion: await predecirConModelo(r),
    }));

    users.sort((a, b) => (b.tiempo_total || 0) - (a.tiempo_total || 0));
    return { date: day, users };
  } catch (err) {
    console.error(`[procesarDia] Error en ${day}:`, err?.message || err);
    return { date: day, users: [], error: err?.message || String(err) };
  }
}

async function procesarDetalleUsuarioDia(
  userId,
  day,
  useBusquedaLogic = false,
  hours = "all"
) {
  const isCurrentDay = isToday(day, TZ);
  const useFechaCreacion = useBusquedaLogic || !isCurrentDay;

  const [actividadesById, colaboradores, info] = await Promise.all([
    fetchActividades(day),
    fetchColaboradores(day),
    fetchUserByIdViaSearch(userId),
  ]);

  if (ALL_EXCLUDED_IDS.has(userId)) {
    return {
      date: day,
      user: {
        user_id: userId,
        colaborador: "",
        email: info.email || "",
        phone: info.phone || "",
      },
      actividades: [],
      resumen: {
        actividades: 0,
        revisiones: 0,
        revisiones_con_duracion: 0,
        revisiones_sin_duracion: 0,
        tiempo_total: 0,
      },
      prediccion: null,
      meta: { useFechaCreacion, isCurrentDay, reason: "excluded_id" },
    };
  }

  if (!allowedByEmail(info.email || "")) {
    return {
      date: day,
      user: {
        user_id: userId,
        colaborador: "",
        email: info.email || "",
        phone: info.phone || "",
      },
      actividades: [],
      resumen: {
        actividades: 0,
        revisiones: 0,
        revisiones_con_duracion: 0,
        revisiones_sin_duracion: 0,
        tiempo_total: 0,
      },
      prediccion: null,
      meta: { useFechaCreacion, isCurrentDay, reason: "excluded_domain" },
    };
  }

  const col = colaboradores.find((c) => c?.idAsignee === userId) || null;

  if (!col) {
    return {
      date: day,
      user: {
        user_id: userId,
        colaborador: info.name || userId,
        email: info.email || "",
        phone: info.phone || "",
      },
      actividades: [],
      resumen: {
        actividades: 0,
        revisiones: 0,
        revisiones_con_duracion: 0,
        revisiones_sin_duracion: 0,
        tiempo_total: 0,
      },
      prediccion: null,
      meta: { useFechaCreacion, isCurrentDay, reason: "no_data" },
    };
  }

  const userName = resolveUserName(col) || info.name || userId;
  const acts = safeArray(col?.items?.actividades);
  const buckets = ["terminadas", "confirmadas", "pendientes"];

  const validActIdsHoy = new Set();
  if (!useFechaCreacion) {
    for (const a of acts) {
      const actId = a?.id;
      if (!actId) continue;

      const sched = actividadesById.get(actId);
      if (!sched) continue;

      if (esFtf00secPorTitulo(sched.titulo)) continue;

      const res = isDueStartBetween9and5Local(sched.dueStart, day, TZ);
      if (res.ok) validActIdsHoy.add(actId);
    }
  }

  const actividadesDetalle = [];

  for (const a of acts) {
    const actId = a?.id;
    if (!actId) continue;

    const sched = actividadesById.get(actId);
    const titulo = sched?.titulo || a?.titulo || "";

    if (esFtf00secPorTitulo(titulo)) continue;
    if (!useFechaCreacion && !validActIdsHoy.has(actId)) continue;

    const revisiones = { terminadas: [], confirmadas: [], pendientes: [] };

    if (useFechaCreacion) {
      const terminadas = safeArray(a?.terminadas);
      for (const r of terminadas) {
        const norm = normalizeRevision(r);
        if (!norm) continue;

        if (hours === "work") {
          const fc = norm?.fechaCreacion;
          if (!fc) continue;
          if (!isFechaCreacionBetween9and5Local(fc, day, TZ).ok) continue;
        }

        revisiones.terminadas.push(norm);
      }
    } else {
      for (const b of buckets) {
        const revs = safeArray(a?.[b]);
        for (const r of revs) {
          const norm = normalizeRevision(r);
          if (norm) revisiones[b].push(norm);
        }
      }
    }

    const total =
      revisiones.terminadas.length +
      revisiones.confirmadas.length +
      revisiones.pendientes.length;

    if (total === 0) continue;

    actividadesDetalle.push({
      id: actId,
      titulo,
      dueStart: sched?.dueStart ?? null,
      revisiones,
    });
  }

  let revisionesCount = 0;
  let conDur = 0;
  let sinDur = 0;
  let minutos = 0;

  for (const act of actividadesDetalle) {
    const s = summarizeActividadBuckets(act);
    revisionesCount += s.revisiones;
    conDur += s.con_duracion;
    sinDur += s.sin_duracion;
    minutos += s.minutos;
  }

  const features = {
    actividades: actividadesDetalle.length,
    revisiones_con_duracion: conDur,
    revisiones_sin_duracion: sinDur,
    tiempo_total: minutos,
  };

  const prediccion = await predecirConModelo(features);

  return {
    date: day,
    user: {
      user_id: userId,
      colaborador: userName,
      email: info.email || "",
      phone: info.phone || "",
    },
    resumen: {
      actividades: features.actividades,
      revisiones: revisionesCount,
      revisiones_con_duracion: conDur,
      revisiones_sin_duracion: sinDur,
      tiempo_total: minutos,
    },
    prediccion,
    actividades: actividadesDetalle,
    meta: { useFechaCreacion, isCurrentDay, hours },
  };
}

// ---- routes ----

// ✅ RUTA 1
router.get("/hoy", async (req, res) => {
  try {
    const dateParam = String(req.query.date || "").trim();
    const day = dateParam || getTodayISOInTZ(TZ);
    const useBusquedaLogic = !!dateParam;

    const resultado = await procesarDia(day, useBusquedaLogic);
    return res.json({ date: resultado.date, users: resultado.users });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

// ✅ RUTA 2
router.get("/rango", async (req, res) => {
  try {
    const start = String(req.query.start || "").trim();
    const end = String(req.query.end || "").trim();

    if (!start || !end) {
      return res
        .status(400)
        .json({ error: "start y end son requeridos (YYYY-MM-DD)" });
    }

    // iterar días evitando DST usando UTC-millis
    const fechas = [];
    const startMs = Date.parse(`${start}T00:00:00.000Z`);
    const endMs = Date.parse(`${end}T00:00:00.000Z`);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
      return res.status(400).json({ error: "rango inválido" });
    }

    for (let ms = startMs; ms <= endMs; ms += 24 * 60 * 60 * 1000) {
      fechas.push(new Date(ms).toISOString().slice(0, 10));
    }

    log(`[Rango] Procesando ${fechas.length} días desde ${start} hasta ${end}`);

    const daysConcurrency = Number(process.env.DAYS_CONCURRENCY || 4);
    const dataPorDia = await mapLimit(fechas, daysConcurrency, async (day) =>
      procesarDia(day, false)
    );

    return res.json({
      start,
      end,
      totalDias: fechas.length,
      diasConDatos: dataPorDia.filter((d) => d.users.length > 0).length,
      daily_data: dataPorDia,
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

router.get("/usuario/:userId", async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "userId requerido" });

    const dateParam = String(req.query.date || "").trim();
    const day = dateParam || getTodayISOInTZ(TZ);

    const hours = String(req.query.hours || "work").trim();

    // mode=agenda|hecho|auto
    const mode = parseMode(req.query.mode);
    const resolvedMode = mode === "auto" ? getDefaultModeForDay(day) : mode;

    // permite "hecho" incluso si es HOY
    const useBusquedaLogic = resolvedMode === "hecho";

    const detalle = await procesarDetalleUsuarioDia(
      userId,
      day,
      useBusquedaLogic,
      hours
    );

    return res.json({
      ...detalle,
      meta: { ...detalle.meta, mode: resolvedMode, cutoffHour: SWITCH_CUTOFF_HOUR },
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

module.exports = router;
