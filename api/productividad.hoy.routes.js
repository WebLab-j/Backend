// /routes/productividad.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { consumeStaleForDay } = require("../src/realtime/staleStore");
const { peekStaleForDay, clearStaleUser, clearStaleDay } = require("../src/realtime/staleStore");
const { setDayRaw, getDayRaw } = require("../src/realtime/rawStore");


const router = express.Router();


const DEFAULT_ACT_URL = "https://wlserver-production-6735.up.railway.app/api/actividades";
const DEFAULT_REV_URL ="https://wlserver-production-6735.up.railway.app/api/reportes/revisiones-por-fecha";

const TZ = "America/Mexico_City";
const START_HOUR = 9;
const END_HOUR = 17; // exclusivo
const START_MIN = START_HOUR * 60;
const END_MIN = END_HOUR * 60;

const USERS_SEARCH_URL =
  process.env.WL_USERS_SEARCH_URL ||"https://wlserver-production-6735.up.railway.app/api/users/search";

const ALLOW_DOMAINS = new Set(["pprin.com", "practicante.com"]);

// ---- caches ----

// cache en memoria: userId -> { email, name, ts }
const userCache = new Map();
const USER_TTL_MS = 24 * 60 * 60 * 1000;

// cache nombre en memoria: userId -> name
const userNameCache = new Map();

// cache actividades por día con TTL
const actividadesCache = new Map(); // day -> { byId: Map, ts }
const ACT_CACHE_TTL_MS = 5 * 60 * 1000;

// cache colaboradores/revisiones por día con TTL
const colaboradoresCache = new Map(); // day -> { colaboradores: any[], ts }
const COLAB_CACHE_TTL_MS = Number(process.env.COLAB_CACHE_TTL_MS || 60_000);


// cache localParts: key -> {date,hour,minute}
const localPartsCache = new Map();
const LOCAL_PARTS_CACHE_MAX = 50_000;

const SWITCH_CUTOFF_HOUR = Number(process.env.SWITCH_CUTOFF_HOUR || 10);

// cache del resultado final /hoy por día
const resultadoDiaCache = new Map(); // day -> { users: any[], ts: number, useFechaCreacion: boolean }
const RESULT_CACHE_TTL_MS = Number(process.env.RESULT_CACHE_TTL_MS || 300000); // 30s

// cache del detalle /usuario/:id por día+userId
const detalleUsuarioCache = new Map(); // key -> { data: any, ts: number }
const DETALLE_CACHE_TTL_MS = Number(process.env.DETALLE_CACHE_TTL_MS || 60_000); // 60s


function isFresh(ts, ttl) {
  return Date.now() - ts < ttl;
}

async function getOrFetchRawDay(day, fetchActividades, fetchColaboradores) {
  const raw = getDayRaw(day);
  if (raw?.colaboradoresRaw && raw?.actividadesById) return raw;

  const [actividadesById, colaboradoresRaw] = await Promise.all([
    fetchActividades(day),
    fetchColaboradores(day),
  ]);

  setDayRaw(day, { colaboradoresRaw, actividadesById });
  return getDayRaw(day);
}

function detalleKey(day, userId, useBusquedaLogic, hours, mode) {
  return `${day}|${userId}|${useBusquedaLogic ? "hecho" : "agenda"}|${hours}|${mode}`;
}

function invalidateDayCaches(day, { actividades = true, colaboradores = true } = {}) {
  if (!day) return;
  if (actividades) actividadesCache.delete(day);
  if (colaboradores) colaboradoresCache.delete(day);
}


function parseMode(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "agenda" || v === "hecho") return v;
  return "auto";
}

function getDefaultModeForDay(day) {
  if (!isToday(day, TZ)) return "hecho";
  const nowLocal = getLocalParts(new Date(), TZ);
  const hour = nowLocal?.hour ?? 0;
  return hour < SWITCH_CUTOFF_HOUR ? "agenda" : "hecho";
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

  const ms = dateObj.getTime();
  const key = `${timeZone}|${ms}`;

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

// ---- FILTRO 1: dueStart ----
function isDueStartBetween9and5Local(dueStartStr, day, timeZone) {
  return isBetweenWorkHoursLocal(dueStartStr, day, timeZone, "no_dueStart");
}

// ---- FILTRO 2: fechaCreacion ----
function isFechaCreacionBetween9and5Local(fechaCreacionStr, day, timeZone) {
  return isBetweenWorkHoursLocal(fechaCreacionStr, day, timeZone, "no_fechaCreacion");
}

// regex precompilado
const ftfRegex = /ftf|00sec/i;
function esFtf00secPorTitulo(titulo) {
  return ftfRegex.test(String(titulo ?? ""));
}

// ---- user fetching ----

async function fetchUserByIdViaSearch(userId) {
  if (!userId) return { email: "", name: "", phone: "" };

  const hit = userCache.get(userId);
  const now = Date.now();
  if (hit && now - hit.ts < USER_TTL_MS) return hit;

  try {
    const { data } = await axios.get(USERS_SEARCH_URL, { params: { q: userId } });

    const items = Array.isArray(data?.items) ? data.items : [];
    const u =
      items.find((x) => x?._id === userId || x?.id === userId) || items[0] || null;

    const email = u?.email || "";
    const phone = u?.phone || "";
    const name =
      [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() || u?.name || "";

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

  const workers = Array.from({ length: Math.min(concurrency, ids.length) }, () => worker());
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

// ---- data fetching ----

async function fetchActividades(day) {
  const cached = actividadesCache.get(day);
  const now = Date.now();
  if (cached && now - cached.ts < ACT_CACHE_TTL_MS) return cached.byId;

  const actUrl = process.env.WL_ACTIVIDADES_URL || DEFAULT_ACT_URL;
  const { data } = await axios.get(actUrl, { params: { start: day, end: day } });

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

  actividadesCache.set(day, { byId, ts: now });
  return byId;
}

async function fetchColaboradores(day) {
  const revUrl = process.env.WL_REVISIONES_POR_FECHA_URL || DEFAULT_REV_URL;
  const { data } = await axios.get(revUrl, { params: { date: day } });
  return Array.isArray(data?.data?.colaboradores) ? data.data.colaboradores : [];
}

// ✅ DETERMINAR SI ES HOY O UNA BÚSQUEDA ESPECÍFICA
function isToday(dateStr, timeZone) {
  return dateStr === getTodayISOInTZ(timeZone);
}

// ---- HOY (misma lógica, optimizada: 1 pasada) ----
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

async function recomputarFilaUsuario(day, useFechaCreacion, userId, actividadesById, colaboradoresRaw) {
  const col = Array.isArray(colaboradoresRaw)
    ? colaboradoresRaw.find((c) => c?.idAsignee === userId) || null
    : null;

  if (!col) return null;

  const base = useFechaCreacion
    ? procesarColaboradorDia_BUSQUEDA(col, day, actividadesById)
    : procesarColaboradorDia_HOY(col, day, actividadesById);

  if (!base) return null;

  return {
    ...base,
    prediccion: await predecirConModelo(base),
  };
}


// ---- BÚSQUEDA (misma lógica) ----
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
  const { data } = await axios.post(url, {
    actividades: features.actividades,
    revisiones_con_duracion: features.revisiones_con_duracion,
    revisiones_sin_duracion: features.revisiones_sin_duracion,
    tiempo_total: features.tiempo_total,
  });
  return data;
}

// ---- FILTRO DE USUARIOS (exclusión) ----
const EXCLUDE_DOMAINS = new Set(["officlean.com", "aluvri.com"]); // (se mantiene aunque no se use)
const EXCLUDE_USER_IDS = new Set(["2dad872b594c81c8ae6500026864f907"]);
const EXCLUDE_USER_IDS2 = new Set(["2e6d872b594c8100ac680002df5d84c5"]);
const EXCLUDE_USER_IDS3 = new Set(["2edd872b594c818984190002be5174f1"]);

// Unificado (más rápido, misma lógica)
const ALL_EXCLUDED_IDS = new Set([...EXCLUDE_USER_IDS, ...EXCLUDE_USER_IDS2, ...EXCLUDE_USER_IDS3]);

// ---- Concurrency helper (sin deps) ----
async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      out[current] = await mapper(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

// ✅ FUNCIÓN AUXILIAR: Procesar un día
async function procesarDia(day, useBusquedaLogic = false) {
  try {
    const isCurrentDay = isToday(day, TZ);
    const useFechaCreacion = useBusquedaLogic || !isCurrentDay;

    console.log(
      `[procesarDia] ${day} - isCurrentDay: ${isCurrentDay} - useFechaCreacion: ${useFechaCreacion}`
    );

    // ✅ paralelo (misma data)
    const [actividadesById, colaboradoresRaw] = await Promise.all([
      fetchActividades(day),
      fetchColaboradores(day),
    ]);
    setDayRaw(day, { colaboradoresRaw, actividadesById });

    console.log("[RAW STORE] setDayRaw", {
  day,
  colaboradores: Array.isArray(colaboradoresRaw) ? colaboradoresRaw.length : 0,
  actividades: actividadesById instanceof Map ? actividadesById.size : 0,
});


    let colaboradores = colaboradoresRaw;
    

    // Resolver emails por userId
    const userIds = colaboradores.map((c) => c?.idAsignee).filter(Boolean);
    const usersInfo = await resolveUsersMap(userIds, Number(process.env.USERS_CONCURRENCY || 4));

    // Filtrar dominios + IDs (misma lógica)
    colaboradores = colaboradores.filter((col) => {
      const userId = col?.idAsignee;
      if (!userId) return false;

      if (ALL_EXCLUDED_IDS.has(userId)) {
        console.log(`[FILTRO] Excluyendo usuario por ID: ${userId}`);
        return false;
      }

      const info = usersInfo.get(userId) || {};
      const email = info.email || "";

      if (!allowedByEmail(email)) {
        console.log(`[FILTRO] Excluyendo por dominio. userId=${userId} email=${email}`);
        return false;
      }

      return true;
    });

    let rows;
    if (useFechaCreacion) {
      console.log(`[procesarDia] Usando lógica BÚSQUEDA (fechaCreacion)`);
      rows = colaboradores
        .map((c) => procesarColaboradorDia_BUSQUEDA(c, day, actividadesById))
        .filter(Boolean);
    } else {
      console.log(`[procesarDia] Usando lógica HOY (dueStart)`);
      rows = colaboradores
        .map((c) => procesarColaboradorDia_HOY(c, day, actividadesById))
        .filter(Boolean);
    }

    // ✅ Limitar concurrencia ML (misma salida, menos saturación)
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

async function procesarDetalleUsuarioDia(userId, day, useBusquedaLogic = false, hours = "all") {
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
      user: { user_id: userId, colaborador: "", email: info.email || "", phone: info.phone || "" },
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
      user: { user_id: userId, colaborador: "", email: info.email || "", phone: info.phone || "" },
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

  const passRevisionFilterPasado = (rev) => {
    const fc = rev?.fechaCreacion ?? rev?.createdAt ?? null;
    if (!fc) return false;

    const local = getLocalParts(new Date(fc), TZ);
    if (!local || local.date !== day) return false;

    if (hours === "work") return isFechaCreacionBetween9and5Local(fc, day, TZ).ok;
    return true;
  };
  void passRevisionFilterPasado;

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
        if (norm) revisiones.terminadas.push(norm);
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
      revisiones.terminadas.length + revisiones.confirmadas.length + revisiones.pendientes.length;

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
    user: { user_id: userId, colaborador: userName, email: info.email || "", phone: info.phone || "" },
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


// /routes/productividad.js
// ... tus requires arriba



function modeKeyFor(useFechaCreacion) {
  return useFechaCreacion ? "hecho" : "agenda";
}

function dayCacheKey(day, useFechaCreacion) {
  return `${day}|${modeKeyFor(useFechaCreacion)}`;
}

function deleteResultadoDiaCacheForDay(day) {
  resultadoDiaCache.delete(`${day}|agenda`);
  resultadoDiaCache.delete(`${day}|hecho`);
}

// ✅ RUTA 1 (con cache + stale por usuario) — ACTUALIZADA
router.get("/hoy", async (req, res) => {
  try {
    const dateParam = String(req.query.date || "").trim();
    const day = dateParam || getTodayISOInTZ(TZ);
    const useBusquedaLogic = !!dateParam;

    const isCurrentDay = isToday(day, TZ);
    const useFechaCreacion = useBusquedaLogic || !isCurrentDay;

    const cacheKey = dayCacheKey(day, useFechaCreacion);
    const cached = resultadoDiaCache.get(cacheKey);

    // 1) cache fresco del mismo modo -> intenta partial rebuild
    if (
      cached &&
      isFresh(cached.ts, RESULT_CACHE_TTL_MS) &&
      cached.useFechaCreacion === useFechaCreacion
    ) {
      const stale = peekStaleForDay(day);

      // stale global/día -> fuerza recompute total
      if (stale.all || stale.dayStale) {
        deleteResultadoDiaCacheForDay(day);
        clearStaleDay(day);
      } else if (stale.users.size > 0) {
        // ✅ AQUÍ ESTÁ EL CAMBIO CLAVE: usa RAW (no WL)
        const raw = await getOrFetchRawDay(day, fetchActividades, fetchColaboradores);
        const actividadesById = raw.actividadesById;
        const colaboradoresRaw = raw.colaboradoresRaw;

        const byUserId = new Map(cached.users.map((u) => [u.user_id, u]));

        for (const uid of stale.users) {
          const updated = await recomputarFilaUsuario(
            day,
            useFechaCreacion,
            uid,
            actividadesById,
            colaboradoresRaw
          );

          if (!updated) byUserId.delete(uid);
          else byUserId.set(uid, updated);

          clearStaleUser(day, uid);
        }

        const users = Array.from(byUserId.values());
        users.sort((a, b) => (b.tiempo_total || 0) - (a.tiempo_total || 0));

        // ✅ cachea el resultado parcial (last-known-good)
        resultadoDiaCache.set(cacheKey, {
          users,
          ts: Date.now(),
          useFechaCreacion,
        });

        return res.json({ date: day, users, meta: { fromCache: true, partial: true } });
      } else {
        // cache hit limpio
        return res.json({ date: day, users: cached.users, meta: { fromCache: true } });
      }
    }

    // 2) sin cache / vencido -> recompute total (aquí sí puedes usar procesarDia)
    const resultado = await procesarDia(day, useBusquedaLogic);

    // ✅ si WL falló, no envenenes cache
    if (resultado?.error) {
      const prev = resultadoDiaCache.get(cacheKey);
      if (prev && prev.users?.length) {
        return res.json({ date: day, users: prev.users, meta: { fromCache: true, degraded: true } });
      }
      return res.status(502).json({ error: "Upstream WL failed", detail: resultado.error });
    }

    resultadoDiaCache.set(cacheKey, {
      users: resultado.users,
      ts: Date.now(),
      useFechaCreacion,
    });

    clearStaleDay(day);
    return res.json({ date: resultado.date, users: resultado.users, meta: { fromCache: false } });
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
      return res.status(400).json({ error: "start y end son requeridos (YYYY-MM-DD)" });
    }

    const fechas = [];
    const inicioDate = new Date(start);
    const finDate = new Date(end);

    for (let d = new Date(inicioDate); d <= finDate; d.setDate(d.getDate() + 1)) {
      fechas.push(d.toISOString().slice(0, 10));
    }

    console.log(`[Rango] Procesando ${fechas.length} días desde ${start} hasta ${end}`);

    // ✅ concurrencia controlada (misma salida)
    const daysConcurrency = Number(process.env.DAYS_CONCURRENCY || 4);
    const dataPorDia = await mapLimit(fechas, daysConcurrency, async (day) => procesarDia(day, false));

    console.log(`[Rango] Completado: ${dataPorDia.length} días procesados`);

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

    // ✅ clave: permite "hecho" incluso si es HOY
    const useBusquedaLogic = resolvedMode === "hecho";

    const detalle = await procesarDetalleUsuarioDia(userId, day, useBusquedaLogic, hours);

    return res.json({
      ...detalle,
      meta: { ...detalle.meta, mode: resolvedMode, cutoffHour: SWITCH_CUTOFF_HOUR },
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});




module.exports = router;
