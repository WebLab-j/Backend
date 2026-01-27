require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");

/** -------------------------
 *  Filtros y helpers de tiempo
 *  ------------------------- */
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

/** -------------------------
 *  Obtener IDs de actividades válidas del día
 *  ------------------------- */
async function obtenerActividadesValidasIds(dayStr, actividadesUrl) {
  try {
    const { data: actividadesRaw } = await axios.get(actividadesUrl, {
      params: { start: dayStr, end: dayStr }
    });
    
    const actividadesAll = Array.isArray(actividadesRaw?.data) ? actividadesRaw.data : [];
    const { wStart, wEnd } = buildWindow(dayStr, 9, 17);
    
    const idsValidos = new Set();
    let totalActs = 0;
    let descartadasHorario = 0;
    let descartadasFtf = 0;
    let sinFechas = 0;
    
    // DEBUG: Mostrar primeras 3 actividades
    console.log("\n🔍 DEBUG - Primeras 3 actividades:");
    actividadesAll.slice(0, 3).forEach((a, i) => {
      console.log(`   [${i+1}] ID: ${a.id}`);
      console.log(`       Título: ${a.titulo?.substring(0, 50)}...`);
      console.log(`       dueStart: ${a.dueStart}`);
      console.log(`       dueEnd: ${a.dueEnd}`);
    });
    
    for (const a of actividadesAll) {
      totalActs++;
      const s = toDate(a.dueStart);
      const e = toDate(a.dueEnd);
      
      if (!s || !e) {
        sinFechas++;
        continue;
      }
      
      // FILTRO 1: Verificar overlap con 9am-5pm
      const mins = overlapMinutes(s, e, wStart, wEnd);
      if (mins <= 0) {
        descartadasHorario++;
        continue;
      }
      
      // FILTRO 2: Excluir ftf/00sec
      if (debeExcluirActividad(a.titulo)) {
        descartadasFtf++;
        continue;
      }
      
      if (a.id) idsValidos.add(a.id);
    }
    
    return { 
      idsValidos, 
      stats: {
        total: totalActs,
        validas: idsValidos.size,
        sinFechas,
        descartadasHorario,
        descartadasFtf
      }
    };
  } catch (error) {
    console.error(`\n❌ Error obteniendo actividades: ${error.message}`);
    console.error(`   URL: ${actividadesUrl}?start=${dayStr}&end=${dayStr}`);
    return { 
      idsValidos: new Set(), 
      stats: {
        total: 0,
        validas: 0,
        sinFechas: 0,
        descartadasHorario: 0,
        descartadasFtf: 0
      }
    };
  }
}

/** -------------------------
 *  Procesar revisiones (solo de actividades válidas)
 *  ------------------------- */
function procesarRevisionesPorUsuario(raw, idsValidos) {
  const data = raw?.data;
  const colaboradores = Array.isArray(data?.colaboradores) ? data.colaboradores : [];
  
  // 1. Obtener TODOS los usuarios
  const todosLosUsuarios = new Map();
  for (const col of colaboradores) {
    if (col?.idAsignee) {
      todosLosUsuarios.set(col.idAsignee, col?.name || col.idAsignee);
    }
  }
  
  // 2. Procesar revisiones
  const byUser = new Map();
  let revisionesDescartadasActividad = 0;
  let revisionesDescartadasDuracion = 0;
  let revisionesValidas = 0;

  for (const col of colaboradores) {
    const assignee_id = col?.idAsignee;
    const assignee_name = col?.name;
    
    if (!assignee_id) continue;

    const acts = Array.isArray(col?.items?.actividades) ? col.items.actividades : [];
    
    for (const act of acts) {
      const actividad_id = act?.id;
      
      // FILTRO: Solo procesar actividades válidas
      if (!actividad_id || !idsValidos.has(actividad_id)) {
        revisionesDescartadasActividad += 
          (act?.terminadas?.length || 0) + 
          (act?.confirmadas?.length || 0) + 
          (act?.pendientes?.length || 0);
        continue;
      }

      // Inicializar usuario
      if (!byUser.has(assignee_id)) {
        byUser.set(assignee_id, {
          assignee_id,
          assignee_name: assignee_name || assignee_id,
          actividadesSet: new Set(),
          revisiones: 0,
          tiempo_total: 0,
        });
      }

      const userData = byUser.get(assignee_id);
      userData.actividadesSet.add(actividad_id);

      const procesarArr = (arr) => {
        if (!Array.isArray(arr)) return;
        
        for (const rev of arr) {
          const duracion = Number(rev?.duracionMin ?? 0) || 0;
          
          // FILTRO: Solo revisiones con duración > 0
          if (duracion === 0) {
            revisionesDescartadasDuracion++;
            continue;
          }
          
          userData.revisiones += 1;
          userData.tiempo_total += duracion;
          revisionesValidas++;
        }
      };

      procesarArr(act?.terminadas);
      procesarArr(act?.confirmadas);
      procesarArr(act?.pendientes);
    }
  }

  return { 
    byUser, 
    todosLosUsuarios,
    stats: {
      revisionesValidas,
      revisionesDescartadasActividad,
      revisionesDescartadasDuracion
    }
  };
}

/** -------------------------
 *  CSV helpers
 *  ------------------------- */
function escCsv(v) {
  const s = String(v ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n")) 
    return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows) {
  const header = [
    "date", 
    "user_id", 
    "colaborador", 
    "actividades", 
    "revisiones", 
    "tiempo_total", 
    "productivo"
  ];
  const lines = [header.join(",")];
  
  for (const r of rows) {
    lines.push(
      [
        r.date,
        r.user_id,
        r.colaborador,
        r.actividades,
        r.revisiones,
        r.tiempo_total,
        r.productivo,
      ].map(escCsv).join(",")
    );
  }
  return lines.join("\n");
}

/** -------------------------
 *  Iterar días
 *  ------------------------- */
function* eachDay(start, end) {
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    yield d.toISOString().slice(0, 10);
  }
}

/** -------------------------
 *  MAIN
 *  ------------------------- */
(async () => {
  const start = process.argv[2];
  const end = process.argv[3];

  if (!start || !end) {
    console.log("Uso: node src/script/exportDatasetCsv.js YYYY-MM-DD YYYY-MM-DD");
    process.exit(1);
  }

  const ACT_URL = process.env.WL_ACTIVIDADES_URL;
  const REV_FECHA_URL = process.env.WL_REVISIONES_POR_FECHA_URL;

  if (!ACT_URL) {
    console.error("❌ Falta WL_ACTIVIDADES_URL en .env");
    process.exit(1);
  }

  if (!REV_FECHA_URL) {
    console.error("❌ Falta WL_REVISIONES_POR_FECHA_URL en .env");
    process.exit(1);
  }

  const outRows = [];
  let totalDias = 0;

  console.log("\n🚀 Iniciando generación de CSV...");
  console.log(`📅 Rango: ${start} a ${end}\n`);

  for (const day of eachDay(start, end)) {
    totalDias++;
    console.log(`\n${"=".repeat(70)}`);
    console.log(`📅 [${totalDias}] Procesando: ${day}`);
    console.log("=".repeat(70));
    
    try {
      // 1) Obtener IDs de actividades válidas (9am-5pm, sin ftf/00sec)
      console.log("\n📋 Filtrando actividades...");
      const { idsValidos, stats: actStats } = await obtenerActividadesValidasIds(day, ACT_URL);
      
      console.log(`   Total actividades: ${actStats.total}`);
      console.log(`   Sin fechas válidas: ${actStats.sinFechas}`);
      console.log(`   ✅ Válidas (9-5, sin ftf/00sec): ${actStats.validas}`);
      console.log(`   ❌ Descartadas por horario: ${actStats.descartadasHorario}`);
      console.log(`   ❌ Descartadas por ftf/00sec: ${actStats.descartadasFtf}`);

      // 2) Obtener revisiones
      console.log("\n🔍 Procesando revisiones...");
      const { data: revRaw } = await axios.get(REV_FECHA_URL, { params: { date: day } });
      
      // 3) Procesar solo revisiones de actividades válidas
      const { byUser, todosLosUsuarios, stats: revStats } = procesarRevisionesPorUsuario(revRaw, idsValidos);
      
      console.log(`   ✅ Revisiones válidas (>0 min): ${revStats.revisionesValidas}`);
      console.log(`   ❌ Descartadas por actividad no válida: ${revStats.revisionesDescartadasActividad}`);
      console.log(`   ❌ Descartadas por duración = 0: ${revStats.revisionesDescartadasDuracion}`);
      
      console.log(`\n👥 Usuarios:`);
      console.log(`   Total usuarios: ${todosLosUsuarios.size}`);
      console.log(`   Con actividades válidas: ${byUser.size}`);
      console.log(`   Sin actividades válidas: ${todosLosUsuarios.size - byUser.size}`);

      // 4) Generar filas para TODOS los usuarios
      for (const [userId, userName] of todosLosUsuarios) {
        const userData = byUser.get(userId);
        
        if (userData) {
          // Usuario con actividades válidas
          outRows.push({
            date: day,
            user_id: userId,
            colaborador: userData.assignee_name,
            actividades: userData.actividadesSet.size,
            revisiones: userData.revisiones,
            tiempo_total: userData.tiempo_total,
            productivo: userData.tiempo_total >= 480 ? 1 : 0
          });
        } else {
          // Usuario sin actividades válidas
          outRows.push({
            date: day,
            user_id: userId,
            colaborador: userName,
            actividades: 0,
            revisiones: 0,
            tiempo_total: 0,
            productivo: 0
          });
        }
      }

    } catch (error) {
      console.error(`\n❌ Error: ${error.message}`);
    }
  }

  // Guardar CSV
  const outDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outPath = path.join(outDir, `dataset_${start}_a_${end}.csv`);
  fs.writeFileSync(outPath, toCsv(outRows), "utf8");

  console.log("\n" + "=".repeat(70));
  console.log("✅ CSV GENERADO EXITOSAMENTE");
  console.log("=".repeat(70));
  console.log(`📁 Archivo: ${outPath}`);
  console.log(`📊 Total filas: ${outRows.length}`);
  console.log(`📅 Días procesados: ${totalDias}`);
  console.log("\n🔍 Filtros aplicados:");
  console.log("   1. Actividades: horario 9am-5pm (dueStart/dueEnd)");
  console.log("   2. Actividades: sin 'ftf' o '00sec' en título");
  console.log("   3. Revisiones: solo con duracionMin > 0");
  console.log("   4. Productivo: tiempo_total >= 480 min (8 horas)");
  console.log("=".repeat(70) + "\n");
})();