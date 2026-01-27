
// /**
//  * GET /api/productividad/hoy?date=YYYY-MM-DD (opcional)
//  * GET /api/productividad/rango?start=YYYY-MM-DD&end=YYYY-MM-DD
//  * - Consulta actividades por fecha (para obtener dueStart)
//  * - Filtra actividades que estén programadas 9-5 (dueStart)
//  * - Excluye ftf y 00sec
//  * - Calcula actividades/revisiones/minutos por usuario
//  * - Calcula revisiones_con_duracion y revisiones_sin_duracion
//  * - Llama al microservicio ML (/predict) por usuario
//  * - Devuelve array listo para cards en React
//  */
// require("dotenv").config();
// const express = require("express");
// const axios = require("axios");

// const router = express.Router();

// const DEFAULT_ACT_URL = "https://wlserver-production.up.railway.app/api/actividades";
// const DEFAULT_REV_URL =
//   "https://wlserver-production.up.railway.app/api/reportes/revisiones-por-fecha";

// const TZ = "America/Mexico_City";
// const START_HOUR = 9;
// const END_HOUR = 17; // exclusivo

// function getTodayISOInTZ(timeZone) {
//   const now = new Date();
//   const fmt = new Intl.DateTimeFormat("en-CA", {
//     timeZone,
//     year: "numeric",
//     month: "2-digit",
//     day: "2-digit",
//   });
//   return fmt.format(now);
// }

// function getLocalParts(dateObj, timeZone) {
//   if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return null;
//   const fmt = new Intl.DateTimeFormat("en-CA", {
//     timeZone,
//     year: "numeric",
//     month: "2-digit",
//     day: "2-digit",
//     hour: "2-digit",
//     minute: "2-digit",
//     hour12: false,
//     hourCycle: "h23",
//   });
//   const parts = fmt.formatToParts(dateObj);
//   const get = (type) => parts.find((p) => p.type === type)?.value;

//   const y = get("year");
//   const m = get("month");
//   const d = get("day");
//   const h = get("hour");
//   const min = get("minute");
//   if (!y || !m || !d || h == null || min == null) return null;

//   return { date: `${y}-${m}-${d}`, hour: Number(h), minute: Number(min) };
// }

// // ---- Filtro por dueStart (cuándo está PROGRAMADA) ----
// function isDueStartBetween9and5Local(dueStartStr, day, timeZone) {
//   if (!dueStartStr) return { ok: false, reason: "no_dueStart" };

//   const dt = new Date(dueStartStr);
//   const local = getLocalParts(dt, timeZone);
//   if (!local) return { ok: false, reason: "bad_date" };

//   // Debe ser el mismo día
//   if (local.date !== day) return { ok: false, reason: `date_mismatch` };

//   const minutes = local.hour * 60 + local.minute;
//   const start = START_HOUR * 60; // 540 (9:00)
//   const end = END_HOUR * 60; // 1020 (17:00)

//   if (minutes < start) return { ok: false, reason: `before_9` };
//   if (minutes >= end) return { ok: false, reason: `after_5` };

//   return { ok: true, reason: "ok" };
// }

// function esFtf00secPorTitulo(titulo) {
//   const t = String(titulo ?? "").toLowerCase();
//   return t.includes("ftf") || t.includes("00sec");
// }

// function resolveUserName(col) {
//   if (col?.name) return col.name;

//   const userId = col?.idAsignee;
//   const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];

//   for (const a of acts) {
//     for (const bucket of ["terminadas", "confirmadas", "pendientes"]) {
//       const revs = Array.isArray(a?.[bucket]) ? a[bucket] : [];
//       for (const r of revs) {
//         const asg = Array.isArray(r?.assignees) ? r.assignees : [];
//         const hit = asg.find((x) => x?.id === userId && x?.name);
//         if (hit?.name) return hit.name;
//       }
//     }
//   }
//   return userId || "unknown";
// }

// async function fetchActividades(day) {
//   const actUrl = process.env.WL_ACTIVIDADES_URL || DEFAULT_ACT_URL;
//   const { data } = await axios.get(actUrl, {
//     params: { start: day, end: day },
//   });

//   const list = Array.isArray(data?.data) ? data.data : [];
//   const byId = new Map();

//   for (const a of list) {
//     if (!a?.id) continue;
//     byId.set(a.id, {
//       id: a.id,
//       dueStart: a.dueStart ?? null,
//       titulo: a.titulo ?? "",
//     });
//   }

//   return byId;
// }

// async function fetchColaboradores(day) {
//   const revUrl = process.env.WL_REVISIONES_POR_FECHA_URL || DEFAULT_REV_URL;
//   const { data } = await axios.get(revUrl, { params: { date: day } });
//   return Array.isArray(data?.data?.colaboradores) ? data.data.colaboradores : [];
// }

// function procesarColaboradorDia(col, day, actividadesById) {
//   const userId = col?.idAsignee;
//   if (!userId) return null;

//   const userName = resolveUserName(col);

//   // ---- PASO 1: Obtener IDs de actividades válidas (programadas 9-5, sin ftf/00sec) ----
//   const validActIds = new Set();

//   const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];
//   for (const a of acts) {
//     const actId = a?.id;
//     if (!actId) continue;

//     // Obtener datos de la actividad
//     const sched = actividadesById.get(actId);
//     if (!sched) continue; // No encontrada en /actividades

//     // Excluir ftf/00sec
//     if (esFtf00secPorTitulo(sched.titulo)) continue;

//     // Filtrar por dueStart 9-5
//     const res = isDueStartBetween9and5Local(sched.dueStart, day, TZ);
//     if (res.ok) {
//       validActIds.add(actId);
//     }
//   }

//   // ---- PASO 2: Contar revisiones SOLO de actividades válidas ----
//   let revisiones = 0;
//   let revisiones_con_duracion = 0;
//   let revisiones_sin_duracion = 0;
//   let minutos = 0;

//   const buckets = ["terminadas", "confirmadas", "pendientes"];

//   for (const a of acts) {
//     const actId = a?.id;
//     // SOLO procesar actividades válidas
//     if (!actId || !validActIds.has(actId)) continue;

//     for (const b of buckets) {
//       const revs = Array.isArray(a?.[b]) ? a[b] : [];
//       for (const r of revs) {
//         const dur = Number(r?.duracionMin ?? 0) || 0;

//         // Contar TODA revisión de actividad válida
//         revisiones += 1;

//         // Diferenciar por duración
//         if (dur > 0) {
//           revisiones_con_duracion += 1;
//           minutos += dur;
//         } else {
//           revisiones_sin_duracion += 1;
//         }
//       }
//     }
//   }

//   return {
//     date: day,
//     user_id: userId,
//     colaborador: userName,
//     actividades: validActIds.size,
//     revisiones,
//     revisiones_con_duracion,
//     revisiones_sin_duracion,
//     tiempo_total: minutos,
//   };
// }

// async function predecirConModelo(features) {
//   const mlBase = process.env.ML_API_BASE || "http://127.0.0.1:8000";
//   const url = `${mlBase}/predict`;
//   const { data } = await axios.post(url, {
//     actividades: features.actividades,
//     revisiones_con_duracion: features.revisiones_con_duracion,
//     revisiones_sin_duracion: features.revisiones_sin_duracion,
//     tiempo_total: features.tiempo_total,
//   });
//   return data;
// }

// // ---- FILTRO DE USUARIOS (exclusión) ----
// const EXCLUDE_DOMAINS = new Set(["officlean.com", "aluvri.com"]);
// const EXCLUDE_USER_IDS = new Set(["2dad872b594c81c8ae6500026864f907"]);
// const EXCLUDE_USER_IDS2 = new Set(["2e6d872b594c8100ac680002df5d84c5"]);
// const EXCLUDE_USER_IDS3 = new Set(["2edd872b594c818984190002be5174f1"]);

// // ✅ FUNCIÓN AUXILIAR: Procesar un día (reutilizada por /hoy y /rango)
// async function procesarDia(day) {
//   try {
//     // ---- PASO 1: Obtener actividades del día ----
//     const actividadesById = await fetchActividades(day);

//     // ---- PASO 2: Obtener colaboradores y revisiones ----
//     let colaboradores = await fetchColaboradores(day);

//     // ---- APLICAR FILTRO DE EXCLUSIÓN DE USUARIOS ----
//     colaboradores = colaboradores.filter((col) => {
//       const userId = col?.idAsignee;

//       if (EXCLUDE_USER_IDS.has(userId)) {
//         console.log(`[FILTRO] Excluyendo usuario por ID: ${userId}`);
//         return false;
//       }
//       if (EXCLUDE_USER_IDS2.has(userId)) {
//         console.log(`[FILTRO] Excluyendo usuario por ID: ${userId}`);
//         return false;
//       }
//       if (EXCLUDE_USER_IDS3.has(userId)) {
//         console.log(`[FILTRO] Excluyendo usuario por ID: ${userId}`);
//         return false;
//       }

//       if (col?.email) {
//         const domain = col.email.split("@")[1];
//         if (EXCLUDE_DOMAINS.has(domain)) {
//           console.log(`[FILTRO] Excluyendo usuario por dominio: ${domain}`);
//           return false;
//         }
//       }

//       return true;
//     });

//     // ---- PASO 3: Procesar cada colaborador ----
//     const rows = colaboradores
//       .map((c) => procesarColaboradorDia(c, day, actividadesById))
//       .filter(Boolean);

//     // ---- PASO 4: Predicción por usuario (paralelo) ----
//     const users = await Promise.all(
//       rows.map(async (r) => ({
//         ...r,
//         prediccion: await predecirConModelo(r),
//       }))
//     );

//     // Ordena por minutos desc
//     users.sort((a, b) => (b.tiempo_total || 0) - (a.tiempo_total || 0));

//     return { date: day, users };
//   } catch (err) {
//     console.error(`[procesarDia] Error en ${day}:`, err.message);
//     return { date: day, users: [], error: err.message };
//   }
// }

// // ✅ RUTA 1: Un día específico (ahora reutiliza procesarDia)
// router.get("/hoy", async (req, res) => {
//   try {
//     const day = String(req.query.date || "").trim() || getTodayISOInTZ(TZ);
//     const resultado = await procesarDia(day);
//     return res.json({ date: resultado.date, users: resultado.users });
//   } catch (err) {
//     const msg = err?.message || String(err);
//     return res.status(500).json({ error: msg });
//   }
// });

// // ✅ RUTA 2: Rango de fechas (IDÉNTICO a /hoy pero para múltiples días)
// /**
//  * GET /api/productividad/rango?start=YYYY-MM-DD&end=YYYY-MM-DD
//  * - Itera cada día del rango
//  * - Aplica EXACTAMENTE la misma lógica que /hoy (sin cambios)
//  * - Devuelve array de días con usuarios procesados
//  */
// router.get("/rango", async (req, res) => {
//   try {
//     const start = String(req.query.start || "").trim();
//     const end = String(req.query.end || "").trim();

//     if (!start || !end) {
//       return res.status(400).json({ error: "start y end son requeridos (YYYY-MM-DD)" });
//     }

//     // Generar array de fechas
//     const fechas = [];
//     const inicioDate = new Date(start);
//     const finDate = new Date(end);

//     for (let d = new Date(inicioDate); d <= finDate; d.setDate(d.getDate() + 1)) {
//       const fechaStr = d.toISOString().slice(0, 10);
//       fechas.push(fechaStr);
//     }

//     console.log(`[Rango] Procesando ${fechas.length} días desde ${start} hasta ${end}`);

//     // Procesar cada día en paralelo (reutilizando la lógica de /hoy)
//     const dataPorDia = await Promise.all(
//       fechas.map((day) => procesarDia(day))
//     );

//     console.log(`[Rango] Completado: ${dataPorDia.length} días procesados`);

//     return res.json({
//       start,
//       end,
//       totalDias: fechas.length,
//       diasConDatos: dataPorDia.filter((d) => d.users.length > 0).length,
//       daily_data: dataPorDia,
//     });
//   } catch (err) {
//     const msg = err?.message || String(err);
//     return res.status(500).json({ error: msg });
//   }
// });

// module.exports = router;




// /**
//  * GET /api/productividad/hoy?date=YYYY-MM-DD (opcional)
//  * GET /api/productividad/rango?start=YYYY-MM-DD&end=YYYY-MM-DD
//  * - Consulta actividades por fecha (para obtener titulo y filtrar ftf/00sec)
//  * - Filtra REVISIONES que se hicieron entre 9-5 (fechaCreacion) ← CAMBIO PRINCIPAL
//  * - Excluye ftf y 00sec
//  * - Calcula actividades/revisiones/minutos por usuario
//  * - Calcula revisiones_con_duracion y revisiones_sin_duracion
//  * - Llama al microservicio ML (/predict) por usuario
//  * - Devuelve array listo para cards en React
//  */
// require("dotenv").config();
// const express = require("express");
// const axios = require("axios");

// const router = express.Router();

// const DEFAULT_ACT_URL = "https://wlserver-production.up.railway.app/api/actividades";
// const DEFAULT_REV_URL =
//   "https://wlserver-production.up.railway.app/api/reportes/revisiones-por-fecha";

// const TZ = "America/Mexico_City";
// const START_HOUR = 9;
// const END_HOUR = 17; // exclusivo

// function getTodayISOInTZ(timeZone) {
//   const now = new Date();
//   const fmt = new Intl.DateTimeFormat("en-CA", {
//     timeZone,
//     year: "numeric",
//     month: "2-digit",
//     day: "2-digit",
//   });
//   return fmt.format(now);
// }

// function getLocalParts(dateObj, timeZone) {
//   if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return null;
//   const fmt = new Intl.DateTimeFormat("en-CA", {
//     timeZone,
//     year: "numeric",
//     month: "2-digit",
//     day: "2-digit",
//     hour: "2-digit",
//     minute: "2-digit",
//     hour12: false,
//     hourCycle: "h23",
//   });
//   const parts = fmt.formatToParts(dateObj);
//   const get = (type) => parts.find((p) => p.type === type)?.value;

//   const y = get("year");
//   const m = get("month");
//   const d = get("day");
//   const h = get("hour");
//   const min = get("minute");
//   if (!y || !m || !d || h == null || min == null) return null;

//   return { date: `${y}-${m}-${d}`, hour: Number(h), minute: Number(min) };
// }

// // ---- Filtro por fechaCreacion (cuándo se HIZO la revisión) ----
// function isFechaCreacionBetween9and5Local(fechaCreacionStr, day, timeZone) {
//   if (!fechaCreacionStr) return { ok: false, reason: "no_fechaCreacion" };

//   const dt = new Date(fechaCreacionStr);
//   const local = getLocalParts(dt, timeZone);
//   if (!local) return { ok: false, reason: "bad_date" };

//   // Debe ser el mismo día
//   if (local.date !== day) return { ok: false, reason: `date_mismatch` };

//   const minutes = local.hour * 60 + local.minute;
//   const start = START_HOUR * 60; // 540 (9:00)
//   const end = END_HOUR * 60; // 1020 (17:00)

//   if (minutes < start) return { ok: false, reason: `before_9` };
//   if (minutes >= end) return { ok: false, reason: `after_5` };

//   return { ok: true, reason: "ok" };
// }

// function esFtf00secPorTitulo(titulo) {
//   const t = String(titulo ?? "").toLowerCase();
//   return t.includes("ftf") || t.includes("00sec");
// }

// function resolveUserName(col) {
//   if (col?.name) return col.name;

//   const userId = col?.idAsignee;
//   const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];

//   for (const a of acts) {
//     for (const bucket of ["terminadas", "confirmadas", "pendientes"]) {
//       const revs = Array.isArray(a?.[bucket]) ? a[bucket] : [];
//       for (const r of revs) {
//         const asg = Array.isArray(r?.assignees) ? r.assignees : [];
//         const hit = asg.find((x) => x?.id === userId && x?.name);
//         if (hit?.name) return hit.name;
//       }
//     }
//   }
//   return userId || "unknown";
// }

// async function fetchActividades(day) {
//   const actUrl = process.env.WL_ACTIVIDADES_URL || DEFAULT_ACT_URL;
//   const { data } = await axios.get(actUrl, {
//     params: { start: day, end: day },
//   });

//   const list = Array.isArray(data?.data) ? data.data : [];
//   const byId = new Map();

//   for (const a of list) {
//     if (!a?.id) continue;
//     byId.set(a.id, {
//       id: a.id,
//       titulo: a.titulo ?? "",
//     });
//   }

//   return byId;
// }

// async function fetchColaboradores(day) {
//   const revUrl = process.env.WL_REVISIONES_POR_FECHA_URL || DEFAULT_REV_URL;
//   const { data } = await axios.get(revUrl, { params: { date: day } });
//   return Array.isArray(data?.data?.colaboradores) ? data.data.colaboradores : [];
// }

// function procesarColaboradorDia(col, day, actividadesById) {
//   const userId = col?.idAsignee;
//   if (!userId) return null;

//   const userName = resolveUserName(col);

//   // ---- Contar actividades y revisiones válidas ----
//   const actividadesValidas = new Set();
//   let revisiones = 0;
//   let revisiones_con_duracion = 0;
//   let revisiones_sin_duracion = 0;
//   let minutos = 0;

//   const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];
//   const buckets = ["terminadas", "confirmadas", "pendientes"];

//   for (const a of acts) {
//     const actId = a?.id;
//     if (!actId) continue;

//     // Obtener titulo de la actividad (puede no estar en /actividades si es histórica)
//     const sched = actividadesById.get(actId);
//     const titulo = sched?.titulo || a?.titulo || "";

//     // Excluir ftf/00sec
//     if (esFtf00secPorTitulo(titulo)) continue;

//     let tieneRevisionValida = false;

//     for (const b of buckets) {
//       const revs = Array.isArray(a?.[b]) ? a[b] : [];
//       for (const r of revs) {
//         // ✅ FILTRAR POR fechaCreacion 9-5 (en lugar de dueStart)
//         const fechaCreacion = r?.fechaCreacion;
//         const res = isFechaCreacionBetween9and5Local(fechaCreacion, day, TZ);

//         if (res.ok) {
//           tieneRevisionValida = true;
//           revisiones += 1;

//           const dur = Number(r?.duracionMin ?? 0) || 0;
//           if (dur > 0) {
//             revisiones_con_duracion += 1;
//             minutos += dur;
//           } else {
//             revisiones_sin_duracion += 1;
//           }
//         }
//       }
//     }

//     // Solo contar la actividad si tuvo al menos una revisión válida
//     if (tieneRevisionValida) {
//       actividadesValidas.add(actId);
//     }
//   }

//   return {
//     date: day,
//     user_id: userId,
//     colaborador: userName,
//     actividades: actividadesValidas.size,
//     revisiones,
//     revisiones_con_duracion,
//     revisiones_sin_duracion,
//     tiempo_total: minutos,
//   };
// }

// async function predecirConModelo(features) {
//   const mlBase = process.env.ML_API_BASE || "http://127.0.0.1:8000";
//   const url = `${mlBase}/predict`;
//   const { data } = await axios.post(url, {
//     actividades: features.actividades,
//     revisiones_con_duracion: features.revisiones_con_duracion,
//     revisiones_sin_duracion: features.revisiones_sin_duracion,
//     tiempo_total: features.tiempo_total,
//   });
//   return data;
// }

// // ---- FILTRO DE USUARIOS (exclusión) ----
// const EXCLUDE_DOMAINS = new Set(["officlean.com", "aluvri.com"]);
// const EXCLUDE_USER_IDS = new Set(["2dad872b594c81c8ae6500026864f907"]);
// const EXCLUDE_USER_IDS2 = new Set(["2e6d872b594c8100ac680002df5d84c5"]);
// const EXCLUDE_USER_IDS3 = new Set(["2edd872b594c818984190002be5174f1"]);

// // ✅ FUNCIÓN AUXILIAR: Procesar un día (reutilizada por /hoy y /rango)
// async function procesarDia(day) {
//   try {
//     // ---- PASO 1: Obtener actividades del día (para títulos) ----
//     const actividadesById = await fetchActividades(day);

//     // ---- PASO 2: Obtener colaboradores y revisiones ----
//     let colaboradores = await fetchColaboradores(day);

//     // ---- APLICAR FILTRO DE EXCLUSIÓN DE USUARIOS ----
//     colaboradores = colaboradores.filter((col) => {
//       const userId = col?.idAsignee;

//       if (EXCLUDE_USER_IDS.has(userId)) {
//         console.log(`[FILTRO] Excluyendo usuario por ID: ${userId}`);
//         return false;
//       }
//       if (EXCLUDE_USER_IDS2.has(userId)) {
//         console.log(`[FILTRO] Excluyendo usuario por ID: ${userId}`);
//         return false;
//       }
//       if (EXCLUDE_USER_IDS3.has(userId)) {
//         console.log(`[FILTRO] Excluyendo usuario por ID: ${userId}`);
//         return false;
//       }

//       if (col?.email) {
//         const domain = col.email.split("@")[1];
//         if (EXCLUDE_DOMAINS.has(domain)) {
//           console.log(`[FILTRO] Excluyendo usuario por dominio: ${domain}`);
//           return false;
//         }
//       }

//       return true;
//     });

//     // ---- PASO 3: Procesar cada colaborador ----
//     const rows = colaboradores
//       .map((c) => procesarColaboradorDia(c, day, actividadesById))
//       .filter(Boolean);

//     // ---- PASO 4: Predicción por usuario (paralelo) ----
//     const users = await Promise.all(
//       rows.map(async (r) => ({
//         ...r,
//         prediccion: await predecirConModelo(r),
//       }))
//     );

//     // Ordena por minutos desc
//     users.sort((a, b) => (b.tiempo_total || 0) - (a.tiempo_total || 0));

//     return { date: day, users };
//   } catch (err) {
//     console.error(`[procesarDia] Error en ${day}:`, err.message);
//     return { date: day, users: [], error: err.message };
//   }
// }

// // ✅ RUTA 1: Un día específico (ahora reutiliza procesarDia)
// router.get("/hoy", async (req, res) => {
//   try {
//     const day = String(req.query.date || "").trim() || getTodayISOInTZ(TZ);
//     const resultado = await procesarDia(day);
//     return res.json({ date: resultado.date, users: resultado.users });
//   } catch (err) {
//     const msg = err?.message || String(err);
//     return res.status(500).json({ error: msg });
//   }
// });

// // ✅ RUTA 2: Rango de fechas (IDÉNTICO a /hoy pero para múltiples días)
// /**
//  * GET /api/productividad/rango?start=YYYY-MM-DD&end=YYYY-MM-DD
//  * - Itera cada día del rango
//  * - Aplica EXACTAMENTE la misma lógica que /hoy (sin cambios)
//  * - Devuelve array de días con usuarios procesados
//  */
// router.get("/rango", async (req, res) => {
//   try {
//     const start = String(req.query.start || "").trim();
//     const end = String(req.query.end || "").trim();

//     if (!start || !end) {
//       return res.status(400).json({ error: "start y end son requeridos (YYYY-MM-DD)" });
//     }

//     // Generar array de fechas
//     const fechas = [];
//     const inicioDate = new Date(start);
//     const finDate = new Date(end);

//     for (let d = new Date(inicioDate); d <= finDate; d.setDate(d.getDate() + 1)) {
//       const fechaStr = d.toISOString().slice(0, 10);
//       fechas.push(fechaStr);
//     }

//     console.log(`[Rango] Procesando ${fechas.length} días desde ${start} hasta ${end}`);

//     // Procesar cada día en paralelo (reutilizando la lógica de /hoy)
//     const dataPorDia = await Promise.all(
//       fechas.map((day) => procesarDia(day))
//     );

//     console.log(`[Rango] Completado: ${dataPorDia.length} días procesados`);

//     return res.json({
//       start,
//       end,
//       totalDias: fechas.length,
//       diasConDatos: dataPorDia.filter((d) => d.users.length > 0).length,
//       daily_data: dataPorDia,
//     });
//   } catch (err) {
//     const msg = err?.message || String(err);
//     return res.status(500).json({ error: msg });
//   }
// });

// module.exports = router;



/**
 * GET /api/productividad/hoy?date=YYYY-MM-DD (opcional)
 * GET /api/productividad/rango?start=YYYY-MM-DD&end=YYYY-MM-DD
 * 
 * LÓGICA TRIPLE INTELIGENTE:
 * - Si NO pasas ?date (hoy en vivo): Usa dueStart (programado para hoy 9-5)
 * - Si pasas ?date=2025-01-25 (búsqueda específica): Usa fechaCreacion (lo que se hizo 9-5)
 * - Rango: Detecta cada día automáticamente
 * - Excluye ftf y 00sec
 * - Calcula actividades/revisiones/minutos por usuario
 * - Llama al microservicio ML (/predict) por usuario
 * - Devuelve array listo para cards en React
 */
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

// ✅ VERSIÓN 2: LÓGICA PARA BÚSQUEDA ESPECÍFICA (histórico con fechaCreacion)
function procesarColaboradorDia_BUSQUEDA(col, day, actividadesById) {
  const userId = col?.idAsignee;
  if (!userId) return null;

  const userName = resolveUserName(col);

  // ---- Contar actividades y revisiones válidas (filtrando por fechaCreacion) ----
  const actividadesValidas = new Set();
  let revisiones = 0;
  let revisiones_con_duracion = 0;
  let revisiones_sin_duracion = 0;
  let minutos = 0;

  const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];
  const buckets = ["terminadas", "confirmadas", "pendientes"];

  for (const a of acts) {
    const actId = a?.id;
    if (!actId) continue;

    // Obtener titulo de la actividad (puede no estar en /actividades si es histórica)
    const sched = actividadesById.get(actId);
    const titulo = sched?.titulo || a?.titulo || "";

    // Excluir ftf/00sec
    if (esFtf00secPorTitulo(titulo)) continue;

    let tieneRevisionValida = false;

    for (const b of buckets) {
      const revs = Array.isArray(a?.[b]) ? a[b] : [];
      for (const r of revs) {
        // ✅ FILTRAR POR fechaCreacion 9-5 (cuándo se HIZO la revisión)
        const fechaCreacion = r?.fechaCreacion;
        const res = isFechaCreacionBetween9and5Local(fechaCreacion, day, TZ);

        if (res.ok) {
          tieneRevisionValida = true;
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
    }

    // Solo contar la actividad si tuvo al menos una revisión válida
    if (tieneRevisionValida) {
      actividadesValidas.add(actId);
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

    // ---- APLICAR FILTRO DE EXCLUSIÓN DE USUARIOS ----
    colaboradores = colaboradores.filter((col) => {
      const userId = col?.idAsignee;

      if (EXCLUDE_USER_IDS.has(userId)) {
        console.log(`[FILTRO] Excluyendo usuario por ID: ${userId}`);
        return false;
      }
      if (EXCLUDE_USER_IDS2.has(userId)) {
        console.log(`[FILTRO] Excluyendo usuario por ID: ${userId}`);
        return false;
      }
      if (EXCLUDE_USER_IDS3.has(userId)) {
        console.log(`[FILTRO] Excluyendo usuario por ID: ${userId}`);
        return false;
      }

      if (col?.email) {
        const domain = col.email.split("@")[1];
        if (EXCLUDE_DOMAINS.has(domain)) {
          console.log(`[FILTRO] Excluyendo usuario por dominio: ${domain}`);
          return false;
        }
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

module.exports = router;