// /routes/productividad.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { consumeStaleForDay } = require("../src/realtime/staleStore");
const { peekStaleForDay, clearStaleUser, clearStaleDay } = require("../src/realtime/staleStore");
const { setDayRaw, getDayRaw, hasDayRaw, } = require("../src/realtime/rawStore");
const { setDayScore, getScoreSeriesForUser, getAllUserIds } = require("../src/realtime/productivityHistory");

const router = express.Router();

const seedInFlight = new Map();

const DEFAULT_ACT_URL = "https://wlserver-production.up.railway.app/api/actividades";
const DEFAULT_REV_URL = "https://wlserver-production.up.railway.app/api/reportes/revisiones-por-fecha";

const TZ = "America/Mexico_City";
const START_HOUR = 9;
const END_HOUR = 17;
const START_MIN = START_HOUR * 60;
const END_MIN = END_HOUR * 60;

const USERS_SEARCH_URL =
  process.env.WL_USERS_SEARCH_URL || "https://wlserver-production.up.railway.app/api/users/search";

const ALLOW_DOMAINS = new Set(["pprin.com", "practicante.com"]);

const wlStats = { actividades: 0, colaboradores: 0 };

const seededDays = new Set();

async function buildUsersFromRaw({ day, useFechaCreacion, raw }) {
  const actividadesById = raw.actividadesById;
  let colaboradores = Array.isArray(raw.colaboradoresRaw) ? raw.colaboradoresRaw : [];

  const userIds = colaboradores.map((c) => c?.idAsignee).filter(Boolean);
  const usersInfo = await resolveUsersMap(userIds, Number(process.env.USERS_CONCURRENCY || 4));

  colaboradores = colaboradores.filter((col) => {
    const userId = col?.idAsignee;
    if (!userId) return false;
    if (ALL_EXCLUDED_IDS.has(userId)) return false;

    const info = usersInfo.get(userId) || {};
    const email = info.email || "";
    return allowedByEmail(email);
  });

  const rows = useFechaCreacion
    ? colaboradores.map((c) => {
        const email = usersInfo.get(c?.idAsignee)?.email || "";
        return procesarColaboradorDia_BUSQUEDA(c, day, actividadesById, email);
      }).filter(Boolean)
    : colaboradores.map((c) => {
        const email = usersInfo.get(c?.idAsignee)?.email || "";
        return procesarColaboradorDia_HOY(c, day, actividadesById, email);
      }).filter(Boolean);

  const mlConcurrency = Number(process.env.ML_CONCURRENCY || 6);
  const users = await mapLimit(rows, mlConcurrency, async (r) => ({
    ...r,
    prediccion: await predecirConModelo(r),
  }));

  users.sort((a, b) => (b.tiempo_total || 0) - (a.tiempo_total || 0));
  return users;
}


// ---- FILTROS FECHA/REVISION (NUEVO) ----
const FUTURE_SKEW_MS = Number(process.env.FUTURE_SKEW_MS || 2 * 60 * 1000);

function revisionFechaStr(rev) {
  return rev?.fechaCreacion ?? rev?.createdAt ?? null;
}

function isNotFutureDate(dateStr) {
  if (!dateStr) return false;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return false;
  return t <= (Date.now() + FUTURE_SKEW_MS);
}

function stripFutureRevisionsFromDetalle(detalle, dayIso, timeZone = TZ) {
  if (!detalle || typeof detalle !== "object") return detalle;
  if (!isToday(dayIso, timeZone)) return detalle;

  const actividades = Array.isArray(detalle.actividades) ? detalle.actividades : [];

  const fixedActs = actividades.map((act) => {
    const revs = act?.revisiones || {};
    const out = { terminadas: [], confirmadas: [], pendientes: [] };

    for (const bucket of ["terminadas", "confirmadas", "pendientes"]) {
      const arr = Array.isArray(revs[bucket]) ? revs[bucket] : [];
      out[bucket] = arr.filter((r) => {
        // ✅ Intenta ambas rutas: objeto normalizado y raw
        const fc = r?.fechaCreacion ?? r?.raw?.fechaCreacion ?? r?.raw?.createdAt ?? r?.createdAt ?? null;

        if (!fc) return false;

        const t = new Date(fc).getTime();
        if (Number.isNaN(t)) return false;

        // ❌ Rechaza si es futuro (con margen de 2 min)
        if (t > Date.now() + FUTURE_SKEW_MS) return false;

        // ❌ Rechaza si la fecha local en CDMX es posterior al día consultado
        const local = getLocalParts(new Date(fc), timeZone);
        if (!local) return false;
        if (isoToDayIndexUTC(local.date) > isoToDayIndexUTC(dayIso)) return false;

        return true;
      });
    }

    return { ...act, revisiones: out };
  });

  return { ...detalle, actividades: fixedActs };
}

function isoToDayIndexUTC(isoDay) {
  // isoDay: YYYY-MM-DD (comparación estable, evita DST)
  const [y, m, d] = String(isoDay).split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function isOnOrBeforeDayInTZ(dateStr, dayIso, timeZone) {
  if (!dateStr) return false;

  const local = getLocalParts(new Date(dateStr), timeZone);
  if (!local?.date) return false;

  const revIdx = isoToDayIndexUTC(local.date);
  const dayIdx = isoToDayIndexUTC(dayIso);

  return revIdx <= dayIdx;
}

/**
 * ✅ BÚSQUEDA: permite revisiones del día consultado O días pasados (<= day)
 * y bloquea fechas futuras (vs ahora).
 */
function passRevisionFilterUpToDay(rev, dayIso, timeZone) {
  const fc = revisionFechaStr(rev);
  if (!fc) return false;

  const local = getLocalParts(new Date(fc), timeZone);
  if (!local) return false;
  if (isoToDayIndexUTC(local.date) > isoToDayIndexUTC(dayIso)) return false;

  return true;
}

function isFutureDayInTZ(dayIso, timeZone) {
  // diffDaysInTZ = today - day
  // si day es futuro => today - future = negativo
  return diffDaysInTZ(dayIso, timeZone) < 0;
}

// validar yyyy-mm-dd simple 
function isValidIsoDay(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(day || ""));
}

function passRevisionFilterTodayOnly(rev, dayIso, timeZone) {
  const fc = revisionFechaStr(rev);
  if (!fc) return false;
  if (!isNotFutureDate(fc)) return false;

  const local = getLocalParts(new Date(fc), timeZone);
  return !!local && local.date === dayIso;
}


// ---- caches ----

const userCache = new Map();
const USER_TTL_MS = 24 * 60 * 60 * 1000;

const userNameCache = new Map();

const actividadesCache = new Map();
const ACT_CACHE_TTL_MS = 5 * 60 * 1000;

const colaboradoresCache = new Map();
const COLAB_CACHE_TTL_MS = Number(process.env.COLAB_CACHE_TTL_MS || 60_000);

const localPartsCache = new Map();
const LOCAL_PARTS_CACHE_MAX = 50_000;

const SWITCH_CUTOFF_HOUR = Number(process.env.SWITCH_CUTOFF_HOUR || 10);

const resultadoDiaCache = new Map();
const RESULT_CACHE_TTL_MS = Number(process.env.RESULT_CACHE_TTL_MS || 300000);

const detalleUsuarioCache = new Map();
const DETALLE_CACHE_TTL_MS = Number(process.env.DETALLE_CACHE_TTL_MS || 60_000);


function isFresh(ts, ttl) {
  return Date.now() - ts < ttl;
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

// ✅ DETALLE: solo revisiones del MISMO day (CDMX) y NO futuras
function passRevisionFilterDetalleSameDay(rev, dayIso, timeZone, hours = "all") {
  const fc = revisionFechaStr(rev);
  if (!fc) return false;

  // ❌ bloquear timestamps futuros (aunque sean del mismo día)
  if (!isNotFutureDate(fc)) return false;

  // ✅ exigir que caiga en el mismo día (en TZ CDMX)
  const local = getLocalParts(new Date(fc), timeZone);
  if (!local || local.date !== dayIso) return false;

  // hours=work: 09:00-17:00 local (mismo día)
  if (hours === "work") return isFechaCreacionBetween9and5Local(fc, dayIso, timeZone).ok;

  return true;
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

function isDueStartBetween9and5Local(dueStartStr, day, timeZone) {
  return isBetweenWorkHoursLocal(dueStartStr, day, timeZone, "no_dueStart");
}

function isFechaCreacionBetween9and5Local(fechaCreacionStr, day, timeZone) {
  return isBetweenWorkHoursLocal(fechaCreacionStr, day, timeZone, "no_fechaCreacion");
}

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
  wlStats.actividades += 1;
  console.log("[WL] fetchActividades", { day, count: wlStats.actividades });

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

function isToday(dateStr, timeZone) {
  return dateStr === getTodayISOInTZ(timeZone);
}

// ---- HOY ----
function procesarColaboradorDia_HOY(col, day, actividadesById, email = "") {
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
  // ✅ HOY: solo revisiones del mismo día (CDMX) y NO futuras
  if (!passRevisionFilterTodayOnly(r, day, TZ)) continue;

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
    dominio: domainOf(email),
    actividades: validActIds.size,
    revisiones,
    revisiones_con_duracion,
    revisiones_sin_duracion,
    tiempo_total: minutos,
  };
}

// ---- BÚSQUEDA ----
function procesarColaboradorDia_BUSQUEDA(col, day, actividadesById, email = "") {
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
    dominio: domainOf(email),
    actividades: actividadesValidas.size,
    revisiones,
    revisiones_con_duracion,
    revisiones_sin_duracion,
    tiempo_total: minutos,
  };
}

// ---- recomputar fila (tiempo real) ----
// FIX: ahora resuelve el email para pasar dominio correctamente
async function recomputarFilaUsuario(day, useFechaCreacion, userId, actividadesById, colaboradoresRaw) {
  const col = Array.isArray(colaboradoresRaw)
    ? colaboradoresRaw.find((c) => c?.idAsignee === userId) || null
    : null;

  if (!col) return null;

  const info = await fetchUserByIdViaSearch(userId);
  const email = info?.email || "";

  const base = useFechaCreacion
    ? procesarColaboradorDia_BUSQUEDA(col, day, actividadesById, email)
    : procesarColaboradorDia_HOY(col, day, actividadesById, email);

  if (!base) return null;

  return {
    ...base,
    prediccion: await predecirConModelo(base),
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
const EXCLUDE_DOMAINS = new Set(["officlean.com", "aluvri.com"]);
const EXCLUDE_USER_IDS = new Set(["2dad872b594c81c8ae6500026864f907"]);
const EXCLUDE_USER_IDS2 = new Set(["2e6d872b594c8100ac680002df5d84c5"]);
const EXCLUDE_USER_IDS3 = new Set(["2edd872b594c818984190002be5174f1"]);

const ALL_EXCLUDED_IDS = new Set([...EXCLUDE_USER_IDS, ...EXCLUDE_USER_IDS2, ...EXCLUDE_USER_IDS3]);

// ---- Concurrency helper ----
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


function isBetweenWorkHoursOnlyLocal(dateStr, timeZone, noDateReason = "no_date") {
  if (!dateStr) return { ok: false, reason: noDateReason };

  const dt = new Date(dateStr);
  const local = getLocalParts(dt, timeZone);
  if (!local) return { ok: false, reason: "bad_date" };

  const minutes = local.hour * 60 + local.minute;
  if (minutes < START_MIN) return { ok: false, reason: "before_9" };
  if (minutes >= END_MIN) return { ok: false, reason: "after_5" };

  return { ok: true, reason: "ok" };
}

// ✅ NUEVO: filtro detalle = hoy y anteriores (<= day) y no futuras
// ✅ Acepta: hoy y días pasados. Rechaza: día de mañana en adelante.
// ✅ Acepta: hoy y días pasados. Rechaza: día de mañana en adelante.
function passRevisionFilterDetalleUpToDay(rev, dayIso, timeZone, hours = "all") {
  const fc = revisionFechaStr(rev);
  if (!fc) return false;

  const local = getLocalParts(new Date(fc), timeZone);
  if (!local) return false;
  if (isoToDayIndexUTC(local.date) > isoToDayIndexUTC(dayIso)) return false;

  return true; // ✅ sin filtro de horas — las revisiones no tienen restricción horaria
}

// ✅ FUNCIÓN AUXILIAR: Procesar un día

async function procesarDia(day, useBusquedaLogic = false) {
  try {
    const isCurrentDay = isToday(day, TZ);
    const useFechaCreacion = useBusquedaLogic || !isCurrentDay;

    console.log(
      `[procesarDia] ${day} - isCurrentDay: ${isCurrentDay} - useFechaCreacion: ${useFechaCreacion}`
    );

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

    const userIds = colaboradores.map((c) => c?.idAsignee).filter(Boolean);
    const usersInfo = await resolveUsersMap(userIds, Number(process.env.USERS_CONCURRENCY || 4));

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
      rows = colaboradores.map((c) => {
        const email = usersInfo.get(c?.idAsignee)?.email || "";
        return procesarColaboradorDia_BUSQUEDA(c, day, actividadesById, email);
      }).filter(Boolean);
    } else {
      console.log(`[procesarDia] Usando lógica HOY (dueStart)`);
      rows = colaboradores.map((c) => {
        const email = usersInfo.get(c?.idAsignee)?.email || "";
        return procesarColaboradorDia_HOY(c, day, actividadesById, email);
      }).filter(Boolean);
    }

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
      // Modo "hecho" / día pasado: solo terminadas
      // Si es hoy en modo hecho: filtra futuras. Si es día pasado: acepta todas
      const terminadas = safeArray(a?.terminadas);
      for (const r of terminadas) {
        if (isCurrentDay && !passRevisionFilterUpToDay(r, day, TZ)) continue;
        const norm = normalizeRevision(r);
        if (norm) revisiones.terminadas.push(norm);
      }
    } else {
  for (const b of buckets) {
    const revs = safeArray(a?.[b]);
    for (const r of revs) {
      if (!passRevisionFilterDetalleUpToDay(r, day, TZ)) continue;
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

  // ✅ El resumen se calcula SOBRE los datos ya filtrados
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

  // ✅ Todo ya está filtrado desde el origen — no necesitas un segundo paso
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
    actividades: actividadesDetalle, // ✅ ya limpio desde el loop
    meta: { useFechaCreacion, isCurrentDay, hours },
  };
}

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

const LAST_N_DAYS_CACHE = Number(process.env.LAST_N_DAYS_CACHE || 30);
const WEEK_CACHE_TTL_MS = Number(process.env.WEEK_CACHE_TTL_MS || 30 * 24 * 60 * 60 * 1000);

function parseDayISOToNoonUTC(dayIso) {
  return new Date(`${dayIso}T12:00:00.000Z`);
}

function diffDaysInTZ(dayIso, timeZone) {
  const todayIso = getTodayISOInTZ(timeZone);
  const a = parseDayISOToNoonUTC(todayIso).getTime();
  const b = parseDayISOToNoonUTC(dayIso).getTime();
  return Math.floor((a - b) / (24 * 60 * 60 * 1000));
}

function isInLastNDaysBackExcludingToday(dayIso, timeZone, n = 7) {
  const d = diffDaysInTZ(dayIso, timeZone);
  return d >= 1 && d <= (n - 1);
}

function isTodayDay(dayIso, timeZone) {
  return isToday(dayIso, timeZone);
}

function makeCacheKey(day, useFechaCreacion) {
  return dayCacheKey(day, useFechaCreacion);
}

function canCache(dayIso, timeZone) {
  if (isTodayDay(dayIso, timeZone)) return true;
  return isInLastNDaysBackExcludingToday(dayIso, timeZone, LAST_N_DAYS_CACHE);
}

function ttlForDay(dayIso, timeZone) {
  if (isTodayDay(dayIso, timeZone)) return RESULT_CACHE_TTL_MS;
  return WEEK_CACHE_TTL_MS;
}

function cacheGetIfAllowed(day, useFechaCreacion) {
  if (!canCache(day, TZ)) {
    resultadoDiaCache.delete(makeCacheKey(day, useFechaCreacion));
    return null;
  }

  const key = makeCacheKey(day, useFechaCreacion);
  const hit = resultadoDiaCache.get(key);
  if (!hit) return null;

  const ttl = ttlForDay(day, TZ);
  if (Date.now() - (hit.ts || 0) >= ttl) {
    resultadoDiaCache.delete(key);
    return null;
  }

  return hit;
}

function cacheSetIfAllowed(day, useFechaCreacion, users) {
  if (!canCache(day, TZ)) return;

  const key = makeCacheKey(day, useFechaCreacion);
  resultadoDiaCache.set(key, {
    users,
    ts: Date.now(),
    useFechaCreacion,
  });

  if (Array.isArray(users) && users.length > 0) {
    setDayScore(day, users);
  }
}

const WARMUP_ENABLED = String(process.env.WARMUP_ENABLED || "true").toLowerCase() === "true";
const WARMUP_DAYS = Math.max(2, Math.min(90, Number(process.env.WARMUP_DAYS || LAST_N_DAYS_CACHE || 30)));
const WARMUP_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.WARMUP_CONCURRENCY || 1)));
const WARMUP_HOUR = Number(process.env.WARMUP_HOUR || 9);
const WARMUP_MINUTE = Number(process.env.WARMUP_MINUTE || 0);
const WARMUP_FORCE_AT_9 = String(process.env.WARMUP_FORCE_AT_9 || "false").toLowerCase() === "true";

let warmInFlight = null;
let lastWarmupLocalDay = null;

function addDaysISOInTZ(dayIso, timeZone, days) {
  const base = parseDayISOToNoonUTC(dayIso);
  const moved = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  return getTodayFormatter(timeZone).format(moved);
}

function isWeekend(isoDay) {
  const d = new Date(`${isoDay}T12:00:00.000Z`);
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

function lastNDaysBackExcludingTodayISO(n, timeZone) {
  const out = [];
  const todayIso = getTodayISOInTZ(timeZone);
  let i = 1;
  while (out.length < n - 1) {
    const day = addDaysISOInTZ(todayIso, timeZone, -i);
    if (!isWeekend(day)) out.push(day);
    i++;
    if (i > 90) break;
  }
  return out;
}

function isWarmupMissing() {
  const days = lastNDaysBackExcludingTodayISO(WARMUP_DAYS, TZ);
  for (const day of days) {
    const hit = cacheGetIfAllowed(day, true);
    if (!hit || !Array.isArray(hit.users) || hit.users.length === 0) return true;
  }
  return false;
}

async function warmupLastDaysCaches({ force = false } = {}) {
  if (!WARMUP_ENABLED) return { ok: false, reason: "disabled" };
  if (warmInFlight) return warmInFlight;

  warmInFlight = (async () => {
    const days = lastNDaysBackExcludingTodayISO(WARMUP_DAYS, TZ);

    if (!force && !isWarmupMissing()) {
      return { ok: true, skipped: true, reason: "cache_already_present", days: days.length };
    }

    console.log(`[warmup] start force=${force} days=${days.length} (${days[0]} .. ${days[days.length - 1]})`);

    const results = await mapLimit(days, WARMUP_CONCURRENCY, async (day) => {
      try {
        const r = await procesarDia(day, false);
        if (r?.error) return { day, ok: false, error: r.error };

        cacheSetIfAllowed(day, true, r.users);
        return { day, ok: true, users: r.users?.length || 0 };
      } catch (e) {
        return { day, ok: false, error: e?.message || String(e) };
      }
    });

    const ok = results.filter((x) => x.ok).length;
    const bad = results.length - ok;

    console.log(`[warmup] done ok=${ok} bad=${bad}`);
    return { ok: true, okDays: ok, badDays: bad, results };
  })();

  try {
    return await warmInFlight;
  } finally {
    warmInFlight = null;
  }
}

function toDayIndexUTC(y, m, d) {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function parseISODateParts(iso) {
  const [y, m, d] = String(iso).split("-").map((n) => Number(n));
  return { y, m, d };
}

function utcForLocalTime(timeZone, isoDay, hour, minute) {
  const { y, m, d } = parseISODateParts(isoDay);
  const targetDayIdx = toDayIndexUTC(y, m, d);
  const targetMinutes = targetDayIdx * 1440 + hour * 60 + minute;

  let guess = Date.UTC(y, m - 1, d, hour, minute, 0, 0);

  for (let i = 0; i < 6; i++) {
    const lp = getLocalParts(new Date(guess), timeZone);
    if (!lp) break;

    const { y: ly, m: lm, d: ld } = parseISODateParts(lp.date);
    const localDayIdx = toDayIndexUTC(ly, lm, ld);
    const localMinutes = localDayIdx * 1440 + lp.hour * 60 + lp.minute;

    const deltaMin = localMinutes - targetMinutes;
    if (deltaMin === 0) return guess;

    guess -= deltaMin * 60 * 1000;
  }
  return guess;
}

function msUntilNextDailyRun(timeZone, hour, minute) {
  const now = Date.now();
  const lp = getLocalParts(new Date(now), timeZone);
  if (!lp) return 60_000;

  let targetDay = lp.date;

  const nowMin = lp.hour * 60 + lp.minute;
  const targetMin = hour * 60 + minute;

  if (nowMin >= targetMin) targetDay = addDaysISOInTZ(targetDay, timeZone, 1);

  const targetUtc = utcForLocalTime(timeZone, targetDay, hour, minute);
  const delay = targetUtc - now;
  return delay > 0 ? delay : 60_000;
}

function scheduleDailyWarmup() {
  if (!WARMUP_ENABLED) return;

  const delay = msUntilNextDailyRun(TZ, WARMUP_HOUR, WARMUP_MINUTE);
  console.log(`[warmup@${String(WARMUP_HOUR).padStart(2, "0")}:${String(WARMUP_MINUTE).padStart(2, "0")}] next in ~${Math.round(delay / 60000)} min`);

  setTimeout(async () => {
    try {
      await warmupLastDaysCaches({ force: WARMUP_FORCE_AT_9 });
    } catch (e) {
      console.error("[warmup@daily] fatal:", e?.message || e);
    } finally {
      scheduleDailyWarmup();
    }
  }, delay).unref?.();
}

if (WARMUP_ENABLED) {
  setTimeout(() => {
    warmupLastDaysCaches({ force: false }).catch(() => { });
  }, 2_000).unref?.();

  scheduleDailyWarmup();
}

router.post("/warmup/run", async (req, res) => {
  const force = String(req.query.force || "false").toLowerCase() === "true";
  const r = await warmupLastDaysCaches({ force });
  res.json(r);
});

function pruneResultadoDiaCache() {
  const now = Date.now();

  for (const [key, entry] of resultadoDiaCache.entries()) {
    const day = String(key).split("|")[0] || "";

    if (!canCache(day, TZ)) {
      resultadoDiaCache.delete(key);
      continue;
    }

    const ttl = ttlForDay(day, TZ);
    if (now - Number(entry?.ts || 0) >= ttl) {
      resultadoDiaCache.delete(key);
      continue;
    }
  }
}

const PRUNE_MS = Number(process.env.RESULT_PRUNE_MS || 10 * 60 * 1000);
setInterval(pruneResultadoDiaCache, PRUNE_MS).unref?.();

function detalleTtlForDay(dayIso) {
  return isToday(dayIso, TZ) ? DETALLE_CACHE_TTL_MS : WEEK_CACHE_TTL_MS;
}

function detalleCacheGet(key, dayIso) {
  const hit = detalleUsuarioCache.get(key);
  if (!hit) return null;

  const ttl = detalleTtlForDay(dayIso);
  if (Date.now() - (hit.ts || 0) >= ttl) {
    detalleUsuarioCache.delete(key);
    return null;
  }
  return hit.data;
}

function detalleCacheSet(key, dayIso, data) {
  detalleUsuarioCache.set(key, { data, ts: Date.now() });

  const MAX_DETALLE = Number(process.env.MAX_DETALLE_CACHE || 50_000);
  if (detalleUsuarioCache.size > MAX_DETALLE) {
    const over = detalleUsuarioCache.size - MAX_DETALLE;
    let i = 0;
    for (const k of detalleUsuarioCache.keys()) {
      detalleUsuarioCache.delete(k);
      if (++i >= over) break;
    }
  }
}

function deleteDetalleForDayUser(dayIso, userId) {
  const prefix = `${dayIso}|${userId}|`;
  for (const k of detalleUsuarioCache.keys()) {
    if (String(k).startsWith(prefix)) detalleUsuarioCache.delete(k);
  }
}

// ✅ RUTA 1
router.get("/hoy", async (req, res) => {
  try {
    const dateParam = String(req.query.date || "").trim();
    const day = dateParam || getTodayISOInTZ(TZ);
    const useBusquedaLogic = !!dateParam;

    const isCurrentDay = isToday(day, TZ);
    const useFechaCreacion = useBusquedaLogic || !isCurrentDay;

    const cacheKey = dayCacheKey(day, useFechaCreacion);

    const cached = cacheGetIfAllowed(day, useFechaCreacion);
    const stale = peekStaleForDay(day);

    if (cached && cached.useFechaCreacion === useFechaCreacion) {
      const raw = getDayRaw(day);

      if (!raw?.colaboradoresRaw || !raw?.actividadesById) {
        return res.json({
          date: day,
          users: cached.users,
          meta: {
            fromCache: true,
            rawMissing: true,
            stale: { all: stale.all, dayStale: stale.dayStale, users: stale.users.size },
          },
        });
      }

      if (stale.all || stale.dayStale) {
        const users = await buildUsersFromRaw({ day, useFechaCreacion, raw });
        cacheSetIfAllowed(day, useFechaCreacion, users);
        clearStaleDay(day);
        return res.json({ date: day, users, meta: { fromCache: true, rebuilt: "full_from_raw" } });
      }

      if (stale.users.size > 0) {
        const byUserId = new Map(cached.users.map((u) => [u.user_id, u]));

        for (const uid of stale.users) {
          const updated = await recomputarFilaUsuario(
            day,
            useFechaCreacion,
            uid,
            raw.actividadesById,
            raw.colaboradoresRaw
          );

          if (!updated) byUserId.delete(uid);
          else byUserId.set(uid, updated);

          clearStaleUser(day, uid);
        }

        const users = Array.from(byUserId.values());
        users.sort((a, b) => (b.tiempo_total || 0) - (a.tiempo_total || 0));

        cacheSetIfAllowed(day, useFechaCreacion, users);
        return res.json({ date: day, users, meta: { fromCache: true, rebuilt: "partial_from_raw" } });
      }

      return res.json({ date: day, users: cached.users, meta: { fromCache: true } });
    }

    const raw = getDayRaw(day);
    if (raw?.colaboradoresRaw && raw?.actividadesById) {
      const users = await buildUsersFromRaw({ day, useFechaCreacion, raw });
      cacheSetIfAllowed(day, useFechaCreacion, users);
      if (stale.dayStale || stale.all) clearStaleDay(day);
      return res.json({ date: day, users, meta: { fromCache: true, built: "full_from_raw" } });
    }

    if (seedInFlight.has(day)) {
      await seedInFlight.get(day);
      const raw2 = getDayRaw(day);
      if (raw2?.colaboradoresRaw && raw2?.actividadesById) {
        const users = await buildUsersFromRaw({ day, useFechaCreacion, raw: raw2 });
        cacheSetIfAllowed(day, useFechaCreacion, users);
        return res.json({ date: day, users, meta: { fromCache: false, waited: true } });
      }
    }

    let resolveSeed;
    const seedPromise = new Promise((r) => { resolveSeed = r; });
    seedInFlight.set(day, seedPromise);

    let resultado;
    try {
      resultado = await procesarDia(day, useBusquedaLogic);
    } catch (err) {
      seedInFlight.delete(day);
      resolveSeed();
      return res.status(500).json({ error: err?.message || String(err) });
    }

    seedInFlight.delete(day);
    resolveSeed();

    if (resultado?.error) {
      return res.status(502).json({ error: "Upstream WL failed", detail: resultado.error });
    }

    cacheSetIfAllowed(day, useFechaCreacion, resultado.users);
    clearStaleDay(day);
    return res.json({ date: resultado.date, users: resultado.users, meta: { fromCache: false, seeded: true } });
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

    const mode = parseMode(req.query.mode);
    const resolvedMode = mode === "auto" ? getDefaultModeForDay(day) : mode;

    const useBusquedaLogic = resolvedMode === "hecho";

    const key = detalleKey(day, userId, useBusquedaLogic, hours, resolvedMode);


    // ✅ Cache — ya viene limpio desde el origen, no necesita strip

    if (canCache(day, TZ)) {
      const cached = detalleCacheGet(key, day);
      if (cached) {
        return res.json({ ...cached, meta: { ...(cached.meta || {}), fromCache: true } });
      }
    } else {
      detalleUsuarioCache.delete(key);
    }

    const detalle = await procesarDetalleUsuarioDia(userId, day, useBusquedaLogic, hours);

    const payload = {
      ...detalle,
      meta: { ...detalle.meta, mode: resolvedMode, cutoffHour: SWITCH_CUTOFF_HOUR, fromCache: false },
    };


    if (canCache(day, TZ)) {
      detalleCacheSet(key, day, payload);
    }

    return res.json(payload);
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

router.get("/debug/cache", (req, res) => {
  const day = String(req.query.day || "").trim() || getTodayISOInTZ(TZ);

  const agendaKey = `${day}|agenda`;
  const hechoKey = `${day}|hecho`;

  const agenda = resultadoDiaCache.get(agendaKey);
  const hecho = resultadoDiaCache.get(hechoKey);

  const raw = getDayRaw(day);

  return res.json({
    day,
    keys: { agendaKey, hechoKey },
    cache: {
      agenda: agenda
        ? { exists: true, users: agenda.users?.length || 0, ts: agenda.ts, useFechaCreacion: agenda.useFechaCreacion }
        : { exists: false },
      hecho: hecho
        ? { exists: true, users: hecho.users?.length || 0, ts: hecho.ts, useFechaCreacion: hecho.useFechaCreacion }
        : { exists: false },
    },
    raw: {
      exists: !!(raw?.colaboradoresRaw && raw?.actividadesById),
      colaboradores: Array.isArray(raw?.colaboradoresRaw) ? raw.colaboradoresRaw.length : 0,
      actividades: raw?.actividadesById instanceof Map ? raw.actividadesById.size : 0,
    },
  });
});

router.get("/debug/cache/peek", (req, res) => {
  const day = String(req.query.day || "").trim() || getTodayISOInTZ(TZ);
  const mode = String(req.query.mode || "agenda").trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 20)));

  const key = `${day}|${mode === "hecho" ? "hecho" : "agenda"}`;
  const cached = resultadoDiaCache.get(key);

  if (!cached) {
    return res.status(404).json({ day, mode, key, exists: false });
  }

  const users = Array.isArray(cached.users) ? cached.users : [];

  const resumen = {
    users: users.length,
    total_minutos: users.reduce((acc, u) => acc + (Number(u?.tiempo_total) || 0), 0),
    total_revisiones: users.reduce((acc, u) => acc + (Number(u?.revisiones) || 0), 0),
    total_actividades: users.reduce((acc, u) => acc + (Number(u?.actividades) || 0), 0),
  };

  const top = users.slice(0, limit).map((u) => ({
    user_id: u.user_id,
    colaborador: u.colaborador,
    dominio: u.dominio,
    actividades: u.actividades,
    revisiones: u.revisiones,
    tiempo_total: u.tiempo_total,
  }));

  return res.json({
    day,
    mode,
    key,
    ts: cached.ts,
    useFechaCreacion: cached.useFechaCreacion,
    resumen,
    top,
  });
});

function updateCachedUsers(day, useFechaCreacion, updatedUsers) {
  if (!canCache(day, TZ)) return;

  const cacheKey = dayCacheKey(day, useFechaCreacion);

  const cached = cacheGetIfAllowed(day, useFechaCreacion);
  if (!cached) return;

  const byId = new Map((cached.users || []).map((u) => [u.user_id, u]));
  for (const u of updatedUsers) {
    byId.set(u.user_id, { ...(byId.get(u.user_id) || {}), ...u });
  }

  const users = Array.from(byId.values()).sort((a, b) => (b.tiempo_total || 0) - (a.tiempo_total || 0));

  cacheSetIfAllowed(day, useFechaCreacion, users);
}

router.get("/prediccion-manana", async (req, res) => {
  try {
    const userIds = getAllUserIds();

    if (userIds.length === 0) {
      return res.json({
        mensaje: "historial_insuficiente",
        detalle: "Aún no hay historial acumulado. Consulta /hoy al menos 2 días.",
        predicciones: [],
      });
    }

    const PYTHON_URL = process.env.PYTHON_API_URL || "http://localhost:8000";
    const predicciones = [];
    const errores = [];

    for (const userId of userIds) {
      const history = getScoreSeriesForUser(userId);

      if (history.length < 2) {
        continue;
      }

      try {
        const response = await axios.post(`${PYTHON_URL}/predict-tomorrow`, {
          user_id: userId,
          history,
        });

        predicciones.push(response.data);
      } catch (userErr) {
        errores.push({ userId, error: userErr.message });
      }
    }

    if (predicciones.length === 0) {
      return res.json({
        mensaje: "historial_insuficiente",
        detalle: "Ningún usuario tiene al menos 2 días de historial todavía.",
        predicciones: [],
      });
    }

    const productivos = predicciones.filter((p) => p.label === "productivo").length;
    const regulares = predicciones.filter((p) => p.label === "regular").length;
    const noProductivos = predicciones.filter((p) => p.label === "no_productivo").length;

    return res.json({
      mensaje: "ok",
      total_usuarios: predicciones.length,
      resumen_equipo: {
        productivos,
        regulares,
        no_productivos: noProductivos,
      },
      predicciones,
      errores: errores.length > 0 ? errores : undefined,
    });

  } catch (err) {
    console.error("[prediccion-manana] Error:", err.message);
    res.status(500).json({ error: "Error al calcular predicción", detalle: err.message });
  }
});

module.exports = router;
module.exports.recomputarFilaUsuario = recomputarFilaUsuario;
module.exports.updateCachedUsers = updateCachedUsers;
module.exports.fetchActividades = fetchActividades;
