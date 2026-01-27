require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const { syncRange } = require("./services/syncService");

const app = express();
app.use(express.json());
const axios = require("axios");
const { filterActividadesByWindow } = require("./utils/timeWindow");


app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/sync", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: "Faltan query params start y end (YYYY-MM-DD)" });
    }
    const result = await syncRange(start, end);
    res.json({ success: true, result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/debug/actividades-9-5", async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, error: "Falta ?date=YYYY-MM-DD" });

    // 1) traer actividades del día
    const { data: actividadesRaw } = await axios.get(process.env.WL_ACTIVIDADES_URL, {
      params: { start: date, end: date },
    });

    const actividadesAll = Array.isArray(actividadesRaw?.data) ? actividadesRaw.data : [];

    // 2) filtrar 9-5 (y opcional excluir tipos)
    const { kept, minutosPlaneadosEnVentana } =
      filterActividadesByWindow(actividadesAll, date, 9, 17, ["00Sec", "ftf"]);

    res.json({
      success: true,
      date,
      window: "09:00-17:00",
      total: kept.length,
      minutosPlaneadosEnVentana,
      actividades: kept, // ✅ ACTIVIDADES COMPLETAS
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
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

    // --- normalizador robusto ---
    function normalizeRevisionesRobusto(raw) {
      if (!raw) return [];

      // Caso A: ya viene arreglo plano
      if (Array.isArray(raw)) return raw;
      if (Array.isArray(raw?.data)) return raw.data;

      const out = [];

      // Caso B: REPORTE agrupado (tu log: data.colaboradores[].items.actividades[])
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

      // Caso C: si además viene formato "revision con actividades:[{id}]"
      // (lo detectamos si data es array o si data.items existe, etc.)
      // Si tu API lo manda como raw.data.items o raw.data.revisiones, aquí lo puedes adaptar.
      const possibleList =
        (Array.isArray(raw?.data?.revisiones) && raw.data.revisiones) ||
        (Array.isArray(raw?.data?.items) && raw.data.items) ||
        null;

      if (possibleList) {
        for (const r of possibleList) {
          const actIds = Array.isArray(r?.actividades) ? r.actividades.map(a => a?.id).filter(Boolean) : [];
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

    const revisiones = revisionesAll.filter(r => r?.actividad_id === actividadId);

    res.json({
      success: true,
      start,
      end,
      actividadId,
      total: revisiones.length,
      revisiones,
      debug: { revisionesAll: revisionesAll.length },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});



// opcional: cron diario para guardar "ayer" completo
cron.schedule("0 8 * * *", async () => {
  try {
    const now = new Date();
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    const ymd = y.toISOString().slice(0, 10);

    await syncRange(ymd, ymd);
    console.log("Cron sync ok:", ymd);
  } catch (e) {
    console.error("Cron sync failed:", e.message);
  }
}, { timezone: process.env.TZ || "America/Mexico_City" });

const port = Number(process.env.PORT || 3001);
const productividadHoyRoutes = require("../api/productividad.hoy.routes");

app.use("/api/productividad", productividadHoyRoutes);

app.listen(port, () => console.log(`API running on http://localhost:${port}`));
