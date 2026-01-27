// backend/src/script/exportPrueba.js
require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");

/**
 * Genera dataset CSV por día:
 * 1) Filtra actividades: ventana 9-5 (overlap) y excluye ftf/00sec.
 * 2) Toma revisiones solo de actividades válidas y con duracionMin > 0.
 * 3) Exporta CSV con métricas por usuario.
 */

function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildWindow(dayStr, startHour = 9, endHour = 17) {
  const [y, m, d] = dayStr.split("-").map(Number);
  const wStart = new Date(y, m - 1, d, startHour, 0, 0, 0);
  const wEnd = new Date(y, m - 1, d, endHour, 0, 0, 0);
  return { wStart, wEnd };
}

function overlapMinutes(aStart, aEnd, wStart, wEnd) {
  const start = Math.max(aStart.getTime(), wStart.getTime());
  const end = Math.min(aEnd.getTime(), wEnd.getTime());
  return Math.max(0, Math.round((end - start) / 60000));
}

function debeExcluirActividad(titulo) {
  const t = String(titulo ?? "").toLowerCase();
  return t.includes("ftf") || t.includes("00sec");
}

function escCsv(v) {
  const s = String(v ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

(async () => {
  const day = process.argv[2] || "2026-01-14";

  // IMPORTANT: ventana debe existir antes de cualquier uso (evita TDZ)
  const { wStart, wEnd } = buildWindow(day, 9, 17);

  console.log("\n🚀 GENERADOR DE DATASET - PASO A PASO");
  console.log(`📅 Fecha: ${day}\n`);

  const ACT_URL = process.env.WL_ACTIVIDADES_URL;
  const REV_URL = process.env.WL_REVISIONES_POR_FECHA_URL;

  if (!ACT_URL) {
    console.error("❌ Falta WL_ACTIVIDADES_URL en .env");
    console.log(
      "Agrega: WL_ACTIVIDADES_URL=https://wlserver-production.up.railway.app/api/actividades"
    );
    process.exit(1);
  }

  if (!REV_URL) {
    console.error("❌ Falta WL_REVISIONES_POR_FECHA_URL en .env");
    console.log(
      "Agrega: WL_REVISIONES_POR_FECHA_URL=https://wlserver-production.up.railway.app/api/reportes/revisiones-por-fecha"
    );
    process.exit(1);
  }

  try {
    // ==========================================
    // PASO 1: Obtener actividades y filtrar por horario
    // ==========================================
    console.log("📋 PASO 1: Filtrando actividades por horario (9am-5pm)...\n");

    const { data: actRaw } = await axios.get(ACT_URL, {
      params: { start: day, end: day },
    });

    const todasActividades = Array.isArray(actRaw?.data) ? actRaw.data : [];
    console.log(`   Total actividades obtenidas: ${todasActividades.length}`);

    if (todasActividades.length === 0) {
      console.log("⚠️  No hay actividades en el endpoint");
      process.exit(0);
    }

    // Mostrar ejemplo de actividad
    const ej = todasActividades[0];
    console.log(`\n   Ejemplo de actividad:`);
    console.log(`   - ID: ${ej.id}`);
    console.log(`   - Título: ${ej.titulo?.substring(0, 50)}...`);
    console.log(`   - dueStart: ${ej.dueStart}`);
    console.log(`   - dueEnd: ${ej.dueEnd}`);

    const sEj = toDate(ej.dueStart);
    const eEj = toDate(ej.dueEnd);
    if (sEj && eEj) {
      console.log(`   - Hora inicio: ${pad2(sEj.getHours())}:${pad2(sEj.getMinutes())}`);
      console.log(`   - Hora fin: ${pad2(eEj.getHours())}:${pad2(eEj.getMinutes())}`);
      const mins = overlapMinutes(sEj, eEj, wStart, wEnd);
      console.log(`   - Overlap con 9-5: ${mins} minutos`);
    }
    console.log(`   - ¿Es ftf/00sec?: ${debeExcluirActividad(ej.titulo)}\n`);

    // Analizar primeras 10 actividades
    console.log("   🔍 Análisis de primeras 10 actividades:\n");

    let validasEnMuestra = 0;
    for (let i = 0; i < Math.min(10, todasActividades.length); i++) {
      const a = todasActividades[i];
      const s = toDate(a.dueStart);
      const e = toDate(a.dueEnd);

      let razon = "";
      if (!s || !e) razon = "Sin fechas";
      else {
        const mins = overlapMinutes(s, e, wStart, wEnd);
        if (mins <= 0) razon = `Fuera de 9-5 (${pad2(s.getHours())}:${pad2(s.getMinutes())}-${pad2(e.getHours())}:${pad2(e.getMinutes())})`;
        else if (debeExcluirActividad(a.titulo)) razon = "Es ftf/00sec";
        else {
          razon = "✅ VÁLIDA";
          validasEnMuestra++;
        }
      }

      console.log(`   [${i + 1}] ${a.titulo?.substring(0, 40)}... → ${razon}`);
    }

    console.log(`\n   Válidas en muestra: ${validasEnMuestra}/10\n`);

    // Filtrar por horario 9-5 y sin ftf/00sec
    const idsValidos = new Set();
    let sinFechas = 0;
    let fueraHorario = 0;
    let esFtf = 0;

    for (const act of todasActividades) {
      const s = toDate(act.dueStart);
      const e = toDate(act.dueEnd);

      if (!s || !e) {
        sinFechas++;
        continue;
      }

      const mins = overlapMinutes(s, e, wStart, wEnd);
      if (mins <= 0) {
        fueraHorario++;
        continue;
      }

      if (debeExcluirActividad(act.titulo)) {
        esFtf++;
        continue;
      }

      if (act.id) idsValidos.add(act.id);
    }

    console.log("   📊 Resultados del filtrado:");
    console.log(`   ✅ Actividades válidas (9-5, sin ftf/00sec): ${idsValidos.size}`);
    console.log(`   ❌ Sin fechas: ${sinFechas}`);
    console.log(`   ❌ Fuera de horario 9-5: ${fueraHorario}`);
    console.log(`   ❌ Con ftf/00sec: ${esFtf}\n`);

    if (idsValidos.size === 0) {
      console.log("⚠️  No hay actividades válidas después del filtrado");
      process.exit(0);
    }

    // ==========================================
    // PASO 2: Obtener revisiones y filtrar por actividades válidas
    // ==========================================
    console.log("📋 PASO 2: Obteniendo revisiones y filtrando...\n");

    const { data: revRaw } = await axios.get(REV_URL, {
      params: { date: day },
    });

    const colaboradores = Array.isArray(revRaw?.data?.colaboradores) ? revRaw.data.colaboradores : [];
    console.log(`   Total colaboradores: ${colaboradores.length}\n`);

    // Obtener TODOS los usuarios
    const todosUsuarios = new Map();
    for (const col of colaboradores) {
      if (col?.idAsignee) {
        todosUsuarios.set(col.idAsignee, col?.name || col.idAsignee);
      }
    }

    console.log(`   👥 Total usuarios del día: ${todosUsuarios.size}\n`);

    // Procesar revisiones solo de actividades válidas
    const porUsuario = new Map();
    let revisionesTotales = 0;
    let revisionesDescartadasPorActividad = 0;
    let revisionesDescartadasPorDuracion = 0;

    for (const col of colaboradores) {
      const userId = col?.idAsignee;
      const userName = col?.name;

      if (!userId) continue;

      const actividades = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];

      for (const act of actividades) {
        const actId = act?.id;

        // FILTRO: Solo actividades válidas
        if (!actId || !idsValidos.has(actId)) {
          const totalRevs =
            (act?.terminadas?.length || 0) +
            (act?.confirmadas?.length || 0) +
            (act?.pendientes?.length || 0);
          revisionesDescartadasPorActividad += totalRevs;
          continue;
        }

        // Inicializar usuario
        if (!porUsuario.has(userId)) {
          porUsuario.set(userId, {
            user_id: userId,
            colaborador: userName || userId,
            actividadesSet: new Set(),
            revisiones: 0,
            tiempo_total: 0,
          });
        }

        const userData = porUsuario.get(userId);
        userData.actividadesSet.add(actId);

        const procesarRevs = (arr) => {
          if (!Array.isArray(arr)) return;

          for (const rev of arr) {
            revisionesTotales++;
            const duracion = Number(rev?.duracionMin ?? 0) || 0;

            // FILTRO: Solo con duración > 0
            if (duracion === 0) {
              revisionesDescartadasPorDuracion++;
              continue;
            }

            userData.revisiones++;
            userData.tiempo_total += duracion;
          }
        };

        procesarRevs(act?.terminadas);
        procesarRevs(act?.confirmadas);
        procesarRevs(act?.pendientes);
      }
    }

    const revisionesValidas = Array.from(porUsuario.values()).reduce((sum, u) => sum + u.revisiones, 0);

    console.log("   📊 Resultados del procesamiento:");
    console.log(`   ✅ Revisiones con duración > 0: ${revisionesValidas}`);
    console.log(`   ❌ Descartadas por actividad no válida: ${revisionesDescartadasPorActividad}`);
    console.log(`   ❌ Descartadas por duración = 0: ${revisionesDescartadasPorDuracion}\n`);

    console.log(`   👥 Usuarios con actividades válidas: ${porUsuario.size}`);
    console.log(`   👥 Usuarios sin actividades válidas: ${todosUsuarios.size - porUsuario.size}\n`);

    // ==========================================
    // PASO 3: Generar CSV
    // ==========================================
    console.log("📋 PASO 3: Generando CSV...\n");

    const rows = [];

    for (const [userId, userName] of todosUsuarios) {
      const userData = porUsuario.get(userId);

      if (userData) {
        rows.push({
          date: day,
          user_id: userId,
          colaborador: userData.colaborador,
          actividades: userData.actividadesSet.size,
          revisiones: userData.revisiones,
          tiempo_total: userData.tiempo_total,
          productivo: userData.tiempo_total >= 480 ? 1 : 0,
        });
      } else {
        rows.push({
          date: day,
          user_id: userId,
          colaborador: userName,
          actividades: 0,
          revisiones: 0,
          tiempo_total: 0,
          productivo: 0,
        });
      }
    }

    const header = ["date", "user_id", "colaborador", "actividades", "revisiones", "tiempo_total", "productivo"];
    const lines = [header.join(",")];

    for (const row of rows) {
      lines.push(
        [
          row.date,
          row.user_id,
          escCsv(row.colaborador),
          row.actividades,
          row.revisiones,
          row.tiempo_total,
          row.productivo,
        ].join(",")
      );
    }

    const csv = lines.join("\n");

    const outDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const outPath = path.join(outDir, `dataset_${day}.csv`);
    fs.writeFileSync(outPath, csv, "utf8");

    console.log("=".repeat(70));
    console.log("✅ CSV GENERADO EXITOSAMENTE");
    console.log("=".repeat(70));
    console.log(`📁 Archivo: ${outPath}`);
    console.log(`📊 Total usuarios: ${rows.length}`);
    console.log(`📋 Actividades válidas: ${idsValidos.size}`);
    console.log("\n🔍 Filtros aplicados:");
    console.log("   1. Actividades: horario 9am-5pm (dueStart/dueEnd)");
    console.log("   2. Actividades: sin 'ftf' o '00sec' en título");
    console.log("   3. Revisiones: solo con duracionMin > 0");
    console.log("   4. Productivo: tiempo_total >= 480 min (8 horas)");
    console.log("=".repeat(70) + "\n");

    console.log("📄 Primeras 10 filas:\n");
    console.log(lines.slice(0, 11).join("\n"));
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   URL: ${error.config?.url}`);
    }
    console.error(`   Stack: ${error.stack}`);
  }
})();
