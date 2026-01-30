

require("dotenv").config();
const express = require("express");
const axios = require("axios");

const router = express.Router();

const DEFAULT_ACT_URL = "https://wlserver-production.up.railway.app/api/actividades";
const DEFAULT_REV_URL =
  "https://wlserver-production.up.railway.app/api/reportes/revisiones-por-fecha";

const TZ = "America/Mexico_City";
const START_HOUR = 9;
const END_HOUR = 17; // exclusivo

const USERS_SEARCH_URL =
  process.env.WL_USERS_SEARCH_URL ||
  "https://wlserver-production.up.railway.app/api/users/search";

const ALLOW_DOMAINS = new Set(["pprin.com", "practicante.com"]);

// cache en memoria: userId -> { email, name, ts }
const userCache = new Map();
const USER_TTL_MS = 24 * 60 * 60 * 1000;

function domainOf(email) {
  const e = String(email || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  return at >= 0 ? e.slice(at + 1) : "";
}
function allowedByEmail(email) {
  const dom = domainOf(email);
  return ALLOW_DOMAINS.has(dom);
}

async function fetchUserByIdViaSearch(userId) {
  if (!userId) return { email: "", name: "" };

  // cache
  const hit = userCache.get(userId);
  if (hit && Date.now() - hit.ts < USER_TTL_MS) return hit;

  try {
    // usamos q=userId
    const { data } = await axios.get(USERS_SEARCH_URL, { params: { q: userId } });

    const items = Array.isArray(data?.items) ? data.items : [];
    // intenta encontrar el que coincide por _id o id, si no, usa el primero
    const u = items.find(x => x?._id === userId || x?.id === userId) || items[0] || null;

    const email = u?.email || "";
    const name =
      [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() ||
      u?.name ||
      "";

    const norm = { email, name, ts: Date.now() };
    userCache.set(userId, norm);
    return norm;
  } catch (e) {
    // cache negativo corto
    const norm = { email: "", name: "", ts: Date.now() };
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

// ---- FILTRO 1: Por dueStart (PROGRAMADA para hoy, para tiempo real) ----
function isDueStartBetween9and5Local(dueStartStr, day, timeZone) {
  if (!dueStartStr) return { ok: false, reason: "no_dueStart" };

  const dt = new Date(dueStartStr);
  const local = getLocalParts(dt, timeZone);
  if (!local) return { ok: false, reason: "bad_date" };

  // Debe ser el mismo día
  if (local.date !== day) return { ok: false, reason: `date_mismatch` };

  const minutes = local.hour * 60 + local.minute;
  const start = START_HOUR * 60; // 540 (9:00)
  const end = END_HOUR * 60; // 1020 (17:00)

  if (minutes < start) return { ok: false, reason: `before_9` };
  if (minutes >= end) return { ok: false, reason: `after_5` };

  return { ok: true, reason: "ok" };
}

// ---- FILTRO 2: Por fechaCreacion (CUANDO SE HIZO la revisión, para búsqueda específica) ----
function isFechaCreacionBetween9and5Local(fechaCreacionStr, day, timeZone) {
  if (!fechaCreacionStr) return { ok: false, reason: "no_fechaCreacion" };

  const dt = new Date(fechaCreacionStr);
  const local = getLocalParts(dt, timeZone);
  if (!local) return { ok: false, reason: "bad_date" };

  // Debe ser el mismo día
  if (local.date !== day) return { ok: false, reason: `date_mismatch` };

  const minutes = local.hour * 60 + local.minute;
  const start = START_HOUR * 60; // 540 (9:00)
  const end = END_HOUR * 60; // 1020 (17:00)

  if (minutes < start) return { ok: false, reason: `before_9` };
  if (minutes >= end) return { ok: false, reason: `after_5` };

  return { ok: true, reason: "ok" };
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

async function fetchActividades(day) {
  const actUrl = process.env.WL_ACTIVIDADES_URL || DEFAULT_ACT_URL;
  const { data } = await axios.get(actUrl, {
    params: { start: day, end: day },
  });

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

  return byId;
}

async function fetchColaboradores(day) {
  const revUrl = process.env.WL_REVISIONES_POR_FECHA_URL || DEFAULT_REV_URL;
  const { data } = await axios.get(revUrl, { params: { date: day } });
  return Array.isArray(data?.data?.colaboradores) ? data.data.colaboradores : [];
}

// ✅ DETERMINAR SI ES HOY O UNA BÚSQUEDA ESPECÍFICA
function isToday(dateStr, timeZone) {
  const today = getTodayISOInTZ(timeZone);
  return dateStr === today;
}

// ✅ VERSIÓN 1: LÓGICA PARA HOY (tiempo real con dueStart)
function procesarColaboradorDia_HOY(col, day, actividadesById) {
  const userId = col?.idAsignee;
  if (!userId) return null;

  const userName = resolveUserName(col);

  // ---- PASO 1: Obtener IDs de actividades válidas (programadas 9-5 con dueStart) ----
  const validActIds = new Set();

  const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];
  for (const a of acts) {
    const actId = a?.id;
    if (!actId) continue;

    // Obtener datos de la actividad
    const sched = actividadesById.get(actId);
    if (!sched) continue; // No encontrada en /actividades

    // Excluir ftf/00sec
    if (esFtf00secPorTitulo(sched.titulo)) continue;

    // FILTRAR POR dueStart (9-5, programado para HOY)
    const res = isDueStartBetween9and5Local(sched.dueStart, day, TZ);
    if (res.ok) {
      validActIds.add(actId);
    }
  }

  // ---- PASO 2: Contar revisiones SOLO de actividades válidas ----
  let revisiones = 0;
  let revisiones_con_duracion = 0;
  let revisiones_sin_duracion = 0;
  let minutos = 0;

  const buckets = ["terminadas", "confirmadas", "pendientes"];

  for (const a of acts) {
    const actId = a?.id;
    // SOLO procesar actividades válidas
    if (!actId || !validActIds.has(actId)) continue;

    for (const b of buckets) {
      const revs = Array.isArray(a?.[b]) ? a[b] : [];
      for (const r of revs) {
        const dur = Number(r?.duracionMin ?? 0) || 0;

        // Contar TODA revisión de actividad válida
        revisiones += 1;

        // Diferenciar por duración
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

// ✅ VERSIÓN 2 SIN FILTRO DE FECHA/HORA
// Cuenta TODO lo que venga en "terminadas", sin importar día ni horario.
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

    // Si también quieres quitar este filtro, borra estas 2 líneas:
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
    date: day, // queda informativo; ya no se usa para filtrar
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
const EXCLUDE_DOMAINS = new Set(["officlean.com", "aluvri.com"]);
const EXCLUDE_USER_IDS = new Set(["2dad872b594c81c8ae6500026864f907"]);
const EXCLUDE_USER_IDS2 = new Set(["2e6d872b594c8100ac680002df5d84c5"]);
const EXCLUDE_USER_IDS3 = new Set(["2edd872b594c818984190002be5174f1"]);

// ✅ FUNCIÓN AUXILIAR: Procesar un día (reutilizada por /hoy y /rango)
async function procesarDia(day, useBusquedaLogic = false) {
  try {
    // DETECTAR LÓGICA A USAR
    const isCurrentDay = isToday(day, TZ);
    const useFechaCreacion = useBusquedaLogic || !isCurrentDay;
    
    console.log(`[procesarDia] ${day} - isCurrentDay: ${isCurrentDay} - useFechaCreacion: ${useFechaCreacion}`);

    // ---- PASO 1: Obtener actividades del día ----
    const actividadesById = await fetchActividades(day);

    // ---- PASO 2: Obtener colaboradores y revisiones ----
    let colaboradores = await fetchColaboradores(day);


    //// Resolver emails por userId (solo usando /users/search)
const userIds = colaboradores.map(c => c?.idAsignee).filter(Boolean);
const usersInfo = await resolveUsersMap(userIds, 4); // baja a 2-3 si te da 429

// Filtrar: SOLO permitir dominios pprin.com y practicante.com
colaboradores = colaboradores.filter((col) => {
  const userId = col?.idAsignee;
  if (!userId) return false;

  // tus exclusiones por ID siguen funcionando
  if (EXCLUDE_USER_IDS.has(userId) || EXCLUDE_USER_IDS2.has(userId) || EXCLUDE_USER_IDS3.has(userId)) {
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

    // ---- PASO 3: Procesar cada colaborador (ELIGIENDO LA LÓGICA CORRECTA) ----
    let rows;
    if (useFechaCreacion) {
      // BÚSQUEDA: Usar fechaCreacion (lo que se hizo realmente ese día)
      console.log(`[procesarDia] Usando lógica BÚSQUEDA (fechaCreacion)`);
      rows = colaboradores
        .map((c) => procesarColaboradorDia_BUSQUEDA(c, day, actividadesById))
        .filter(Boolean);
    } else {
      // HOY: Usar dueStart (lo programado para hoy)
      console.log(`[procesarDia] Usando lógica HOY (dueStart)`);
      rows = colaboradores
        .map((c) => procesarColaboradorDia_HOY(c, day, actividadesById))
        .filter(Boolean);
    }

    // ---- PASO 4: Predicción por usuario (paralelo) ----
    const users = await Promise.all(
      rows.map(async (r) => ({
        ...r,
        prediccion: await predecirConModelo(r),
      }))
    );

    // Ordena por minutos desc
    users.sort((a, b) => (b.tiempo_total || 0) - (a.tiempo_total || 0));

    return { date: day, users };
  } catch (err) {
    console.error(`[procesarDia] Error en ${day}:`, err.message);
    return { date: day, users: [], error: err.message };
  }
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function normalizeRevision(r) {
  if (!r || typeof r !== "object") return null;

  // "nombre" depende de tu API WL; si no existe, queda null.
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
    raw: r, // si no lo quieres, quítalo
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

/**
 * ✅ DETALLE:
 * - HOY => usa dueStart 9-5 para filtrar ACTIVIDADES, y trae revisiones de esas actividades (sin filtrar fechaCreacion)
 * - PASADO => usa fechaCreacion (y opcional 9-5) para filtrar REVISIONES del día
 *
 * Query opcional:
 * - ?hours=work  => pasado: fechaCreacion 9-5
 * - ?hours=all   => pasado: todo el día (solo por fecha)
 */
async function procesarDetalleUsuarioDia(userId, day, useBusquedaLogic = false, hours = "all")
 {
  const isCurrentDay = isToday(day, TZ);
  const useFechaCreacion = useBusquedaLogic || !isCurrentDay;

  const actividadesById = await fetchActividades(day);
  let colaboradores = await fetchColaboradores(day);

  const info = await fetchUserByIdViaSearch(userId);

  // Exclusiones
  if (EXCLUDE_USER_IDS.has(userId) || EXCLUDE_USER_IDS2.has(userId) || EXCLUDE_USER_IDS3.has(userId)) {
    return {
      date: day,
      user: { user_id: userId, colaborador: "", email: info.email || "" },
      actividades: [],
      resumen: { actividades: 0, revisiones: 0, revisiones_con_duracion: 0, revisiones_sin_duracion: 0, tiempo_total: 0 },
      prediccion: null,
      meta: { useFechaCreacion, isCurrentDay, reason: "excluded_id" },
    };
  }

  if (!allowedByEmail(info.email || "")) {
    return {
      date: day,
      user: { user_id: userId, colaborador: "", email: info.email || "" },
      actividades: [],
      resumen: { actividades: 0, revisiones: 0, revisiones_con_duracion: 0, revisiones_sin_duracion: 0, tiempo_total: 0 },
      prediccion: null,
      meta: { useFechaCreacion, isCurrentDay, reason: "excluded_domain" },
    };
  }

  const col = colaboradores.find((c) => c?.idAsignee === userId) || null;

  if (!col) {
    return {
      date: day,
      user: { user_id: userId, colaborador: info.name || userId, email: info.email || "" },
      actividades: [],
      resumen: { actividades: 0, revisiones: 0, revisiones_con_duracion: 0, revisiones_sin_duracion: 0, tiempo_total: 0 },
      prediccion: null,
      meta: { useFechaCreacion, isCurrentDay, reason: "no_data" },
    };
  }

  const userName = resolveUserName(col) || info.name || userId;
  const acts = safeArray(col?.items?.actividades);
  const buckets = ["terminadas", "confirmadas", "pendientes"];

  // ✅ HOY: calcular actividades válidas por dueStart 9–5
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

  // ✅ PASADO: filtro de revisiones por fechaCreacion del día (+ horario si hours=work)
const passRevisionFilterPasado = (rev) => {
  const fc = rev?.fechaCreacion ?? rev?.createdAt ?? null;
  if (!fc) return false;

  const local = getLocalParts(new Date(fc), TZ);
  if (!local || local.date !== day) return false; // ✅ mismo día

  // ✅ si quieres opcional 9-5, solo cuando hours=work
  if (hours === "work") {
    return isFechaCreacionBetween9and5Local(fc, day, TZ).ok;
  }

  return true; // ✅ hours=all => todo el día
};

  const actividadesDetalle = [];

  for (const a of acts) {
    const actId = a?.id;
    if (!actId) continue;

    const sched = actividadesById.get(actId);
    const titulo = sched?.titulo || a?.titulo || "";

    if (esFtf00secPorTitulo(titulo)) continue;

    // ✅ HOY: solo actividades válidas por dueStart
    if (!useFechaCreacion && !validActIdsHoy.has(actId)) continue;

const revisiones = { terminadas: [], confirmadas: [], pendientes: [] };

if (useFechaCreacion) {
  // ✅ HISTORIAL: SOLO TERMINADAS y SIN FILTROS (ni hora ni fechaCreacion)
  const terminadas = safeArray(a?.terminadas);

  for (const r of terminadas) {
    const norm = normalizeRevision(r);
    if (norm) revisiones.terminadas.push(norm);
  }
} else {
  // ✅ HOY: trae TODO lo que venga (terminadas/confirmadas/pendientes)
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

    // si no hay revisiones del día (pasado), no incluyas la actividad
    if (total === 0) continue;

    actividadesDetalle.push({
      id: actId,
      titulo,
      dueStart: sched?.dueStart ?? null,
      revisiones,
    });
  }

  // Resumen
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
    user: { user_id: userId, colaborador: userName, email: info.email || "" },
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


// ✅ RUTA 1: Un día específico
/**
 * GET /api/productividad/hoy (sin ?date) → Hoy en vivo con dueStart
 * GET /api/productividad/hoy?date=2025-01-25 → Búsqueda específica con fechaCreacion
 */
router.get("/hoy", async (req, res) => {
  try {
    const dateParam = String(req.query.date || "").trim();
    const day = dateParam || getTodayISOInTZ(TZ);
    
    // Si pasó un ?date específico, usar lógica de BÚSQUEDA
    const useBusquedaLogic = !!dateParam;
    
    const resultado = await procesarDia(day, useBusquedaLogic);
    return res.json({ date: resultado.date, users: resultado.users });
  } catch (err) {
    const msg = err?.message || String(err);
    return res.status(500).json({ error: msg });
  }
});

// ✅ RUTA 2: Rango de fechas
/**
 * GET /api/productividad/rango?start=YYYY-MM-DD&end=YYYY-MM-DD
 * - Itera cada día del rango
 * - Automáticamente detecta: si es HOY usa dueStart, si es pasado usa fechaCreacion
 * - Devuelve array de días con usuarios procesados
 */
router.get("/rango", async (req, res) => {
  try {
    const start = String(req.query.start || "").trim();
    const end = String(req.query.end || "").trim();

    if (!start || !end) {
      return res.status(400).json({ error: "start y end son requeridos (YYYY-MM-DD)" });
    }

    // Generar array de fechas
    const fechas = [];
    const inicioDate = new Date(start);
    const finDate = new Date(end);

    for (let d = new Date(inicioDate); d <= finDate; d.setDate(d.getDate() + 1)) {
      const fechaStr = d.toISOString().slice(0, 10);
      fechas.push(fechaStr);
    }

    console.log(`[Rango] Procesando ${fechas.length} días desde ${start} hasta ${end}`);

    // Procesar cada día en paralelo (lógica automática: HOY vs BÚSQUEDA)
    const dataPorDia = await Promise.all(
      fechas.map((day) => procesarDia(day, false)) // false = dejar que auto-detecte
    );

    console.log(`[Rango] Completado: ${dataPorDia.length} días procesados`);

    return res.json({
      start,
      end,
      totalDias: fechas.length,
      diasConDatos: dataPorDia.filter((d) => d.users.length > 0).length,
      daily_data: dataPorDia,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    return res.status(500).json({ error: msg });
  }
});

router.get("/usuario/:userId", async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "userId requerido" });

    const dateParam = String(req.query.date || "").trim();
    const day = dateParam || getTodayISOInTZ(TZ);

    // ✅ Si el día pedido ES HOY, NO forzar búsqueda.
    const isCurrentDay = isToday(day, TZ);
    const useBusquedaLogic = !!dateParam && !isCurrentDay;

    // hours solo aplica para pasado; para hoy lo ignoramos (da igual)
    const hours = String(req.query.hours || "work").trim();

    const detalle = await procesarDetalleUsuarioDia(userId, day, useBusquedaLogic, hours);
    return res.json(detalle);
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});


module.exports = router;