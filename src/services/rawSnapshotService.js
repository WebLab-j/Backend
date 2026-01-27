const { pool } = require("../db");

function summarizeActividades(apiResponse) {
  const ok = apiResponse?.success === true;
  const list = Array.isArray(apiResponse?.data) ? apiResponse.data : [];

  const porAssignee = {};
  for (const a of list) {
    const assignees = Array.isArray(a.assignees) ? a.assignees : [];
    for (const email of assignees) {
      porAssignee[email] = (porAssignee[email] || 0) + 1;
    }
  }

  return {
    success: ok,
    stats: {
      total: list.length,
      porAssignee
    }
  };
}

function summarizeRevisiones(apiResponse) {
  const list = Array.isArray(apiResponse?.data)
    ? apiResponse.data
    : (Array.isArray(apiResponse) ? apiResponse : []);

  const porAssignee = {};
  for (const r of list) {
    // ajusta cuando veamos el shape real de revisiones
    const email =
      r?.assignee ||
      r?.user ||
      r?.userEmail ||
      r?.email ||
      r?.colaborador ||
      null;

    if (email) porAssignee[email] = (porAssignee[email] || 0) + 1;
  }

  return {
    success: apiResponse?.success === true,
    stats: {
      total: list.length,
      porAssignee
    }
  };
}

async function saveSnapshotSummary({ source, start, end, apiResponse }) {
  const sql = `
    INSERT INTO raw_snapshots (source, start_date, end_date, success, row_count, payload)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      success = VALUES(success),
      row_count = VALUES(row_count),
      payload = VALUES(payload),
      fetched_at = CURRENT_TIMESTAMP
  `;

  const success = apiResponse?.success === true ? 1 : 0;

  let rowCount = 0;
  if (Array.isArray(apiResponse?.data)) rowCount = apiResponse.data.length;
  else if (Array.isArray(apiResponse)) rowCount = apiResponse.length;

  const payload =
    source === "actividades"
      ? summarizeActividades(apiResponse)
      : summarizeRevisiones(apiResponse);

  const conn = await pool.getConnection();
  try {
    await conn.execute(sql, [
      source, start, end, success, rowCount,
      JSON.stringify(payload) // ✅ tiny
    ]);
  } finally {
    conn.release();
  }
}

module.exports = { saveSnapshotSummary };
