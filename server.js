const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3020);
const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: new Date().toISOString()
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      estimatedHours: null,
      startedAt: null,
      reworkReason: "",
      createdAt: new Date().toISOString(),
      repairedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      estimatedHours: null,
      startedAt: null,
      reworkReason: "",
      createdAt: new Date().toISOString(),
      repairedAt: null
    }
  ],
  batches: [],
  workstations: [
    {
      id: "ws_demo_1",
      name: "一号修补台",
      dailyCapacityHours: 8,
      createdAt: new Date().toISOString()
    },
    {
      id: "ws_demo_2",
      name: "二号修补台",
      dailyCapacityHours: 6,
      createdAt: new Date().toISOString()
    }
  ]
};

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /workstations",
  "POST /workstations",
  "GET /workstations/:id",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/cancel",
  "POST /batches/:id/complete"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  let db = null;
  try {
    db = JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    db = null;
  }
  if (!db) {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
    return;
  }
  // 旧数据迁移：补齐工位等新增集合
  let changed = false;
  if (!Array.isArray(db.workstations)) {
    db.workstations = initialData.workstations.map((item) => ({ ...item }));
    changed = true;
  }
  for (const key of ["rubbings", "damages", "batches"]) {
    if (!Array.isArray(db[key])) {
      db[key] = [];
      changed = true;
    }
  }
  if (changed) await writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    const error = new Error("拓片不存在");
    error.status = 404;
    throw error;
  }
  return rubbing;
}

// 预计工时登记：支持 { damageId: hours } 或 [{ damageId, hours }]
function parseEstimates(raw) {
  const map = new Map();
  if (Array.isArray(raw)) {
    raw.forEach((item) => {
      if (item && item.damageId !== undefined) map.set(item.damageId, item.hours);
    });
  } else if (raw && typeof raw === "object") {
    Object.entries(raw).forEach(([damageId, hours]) => map.set(damageId, hours));
  }
  return map;
}

// 返工原因登记：支持 { damageId: reason } 或 [{ damageId, reason }]
function parseReasons(raw) {
  const map = new Map();
  if (Array.isArray(raw)) {
    raw.forEach((item) => {
      if (item && item.damageId !== undefined && item.reason) map.set(item.damageId, item.reason);
    });
  } else if (raw && typeof raw === "object") {
    Object.entries(raw).forEach(([damageId, reason]) => {
      if (reason) map.set(damageId, reason);
    });
  }
  return map;
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  const repairedDamages = damages.filter((item) => item.status === "repaired");
  const workstation = db.workstations.find((item) => item.id === batch.workstationId);
  return {
    ...batch,
    damages,
    workstationName: workstation ? workstation.name : null,
    total: damages.length,
    repaired: repairedDamages.length,
    pending: damages.filter((item) => item.status !== "repaired").length,
    started: damages.filter((item) => item.status === "in_progress").length,
    rework: damages.filter((item) => item.status === "rework").length,
    repairedEstimatedHours: round2(repairedDamages.reduce((sum, item) => sum + (item.estimatedHours || 0), 0)),
    remainingEstimatedHours: round2(
      damages.filter((item) => item.status !== "repaired").reduce((sum, item) => sum + (item.estimatedHours || 0), 0)
    )
  };
}

// 工位负载只统计未完工（open）批次，完工或取消后工位自动释放
function enrichWorkstation(db, workstation) {
  const openBatches = db.batches.filter((item) => item.workstationId === workstation.id && item.status === "open");
  const activeBatch = openBatches[0] || null;
  const committedHours = round2(openBatches.reduce((sum, item) => sum + (item.totalEstimatedHours || 0), 0));
  return {
    ...workstation,
    status: activeBatch ? "occupied" : "available",
    activeBatchId: activeBatch ? activeBatch.id : null,
    activeBatchName: activeBatch ? activeBatch.name : null,
    committedHours,
    remainingHours: round2(Math.max(0, workstation.dailyCapacityHours - committedHours)),
    completedBatches: db.batches.filter((item) => item.workstationId === workstation.id && item.status === "completed").length
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length,
        repairedDamages: damages.filter((item) => item.status === "repaired").length,
        inRepairDamages: damages.filter((item) => item.status === "in_repair" || item.status === "in_progress").length,
        reworkDamages: damages.filter((item) => item.status === "rework").length,
        estimatedHours: round2(damages.reduce((sum, item) => sum + (item.estimatedHours || 0), 0))
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      estimatedHours: null,
      startedAt: null,
      reworkReason: "",
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages.filter((item) => (!status || item.status === status) && (!type || item.type === type));
    return send(res, 200, { data });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = db.damages.find((item) => item.id === damagePatchMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    const body = await parseBody(req);
    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      status: body.status ?? damage.status,
      repairNote: body.repairNote ?? damage.repairNote,
      reworkReason: body.reworkReason ?? damage.reworkReason
    });
    // 标记为进行中即视为已开始修补，记录开始时间
    if (damage.status === "in_progress" && !damage.startedAt) damage.startedAt = new Date().toISOString();
    damage.repairedAt = damage.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  if (req.method === "GET" && pathname === "/workstations") {
    return send(res, 200, { data: db.workstations.map((item) => enrichWorkstation(db, item)) });
  }

  if (req.method === "POST" && pathname === "/workstations") {
    const body = await parseBody(req);
    required(body, ["name", "dailyCapacityHours"]);
    const dailyCapacityHours = Number(body.dailyCapacityHours);
    if (!Number.isFinite(dailyCapacityHours) || dailyCapacityHours <= 0) {
      return send(res, 400, { error: "dailyCapacityHours必须是正数" });
    }
    const workstation = {
      id: makeId("ws"),
      name: body.name,
      dailyCapacityHours,
      createdAt: new Date().toISOString()
    };
    db.workstations.push(workstation);
    await writeDb(db);
    return send(res, 201, { data: enrichWorkstation(db, workstation) });
  }

  const workstationMatch = pathname.match(/^\/workstations\/([^/]+)$/);
  if (workstationMatch && req.method === "GET") {
    const workstation = db.workstations.find((item) => item.id === workstationMatch[1]);
    if (!workstation) return send(res, 404, { error: "工位不存在" });
    const batches = db.batches.filter((item) => item.workstationId === workstation.id).map((item) => enrichBatch(db, item));
    return send(res, 200, { data: { ...enrichWorkstation(db, workstation), batches } });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds", "workstationId", "estimates"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) return send(res, 400, { error: "damageIds必须是非空数组" });
    const damageIds = [...new Set(body.damageIds)];
    const invalid = damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
    if (invalid.length) return send(res, 400, { error: `缺损项不存在：${invalid.join(", ")}` });
    const workstation = db.workstations.find((item) => item.id === body.workstationId);
    if (!workstation) return send(res, 404, { error: "工位不存在" });

    const estimates = parseEstimates(body.estimates);
    const missingEstimate = damageIds.filter((id) => !estimates.has(id));
    if (missingEstimate.length) return send(res, 400, { error: `缺少预计工时：${missingEstimate.join(", ")}` });
    const invalidHours = damageIds.filter((id) => {
      const hours = Number(estimates.get(id));
      return !Number.isFinite(hours) || hours <= 0;
    });
    if (invalidHours.length) return send(res, 400, { error: `预计工时必须为正数：${invalidHours.join(", ")}` });
    const totalEstimatedHours = round2(damageIds.reduce((sum, id) => sum + Number(estimates.get(id)), 0));

    // 容量与占用校验：任一不满足则整批冲突（409），状态不落盘
    if (totalEstimatedHours > workstation.dailyCapacityHours) {
      return send(res, 409, {
        error: `预计总工时${totalEstimatedHours}小时超过工位「${workstation.name}」日容量${workstation.dailyCapacityHours}小时`,
        workstationId: workstation.id,
        totalEstimatedHours,
        dailyCapacityHours: workstation.dailyCapacityHours
      });
    }
    const occupying = db.batches.find((item) => item.workstationId === workstation.id && item.status === "open");
    if (occupying) {
      return send(res, 409, {
        error: `工位「${workstation.name}」仍有未完工批次：${occupying.name}（${occupying.id}）`,
        workstationId: workstation.id,
        openBatchId: occupying.id
      });
    }
    const busyDamages = damageIds.filter((id) => {
      const damage = db.damages.find((item) => item.id === id);
      if (!damage.batchId) return false;
      const holder = db.batches.find((item) => item.id === damage.batchId);
      return holder && holder.status === "open";
    });
    if (busyDamages.length) {
      return send(res, 409, { error: `缺损项仍在未完工批次中：${busyDamages.join(", ")}`, damageIds: busyDamages });
    }

    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "open",
      workstationId: workstation.id,
      damageIds,
      totalEstimatedHours,
      releasedDamageIds: [],
      note: body.note || "",
      createdAt: new Date().toISOString(),
      completedAt: null,
      cancelledAt: null,
      cancelReason: ""
    };
    db.batches.push(batch);
    db.damages.forEach((damage) => {
      if (damageIds.includes(damage.id)) {
        damage.batchId = batch.id;
        damage.status = "in_repair";
        damage.estimatedHours = Number(estimates.get(damage.id));
        damage.startedAt = null;
      }
    });
    await writeDb(db);
    return send(res, 201, { data: enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = db.batches.find((item) => item.id === batchMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const cancelMatch = pathname.match(/^\/batches\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === cancelMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    if (batch.status !== "open") {
      return send(res, 409, { error: `批次已${batch.status === "completed" ? "完工" : "取消"}，不能再取消` });
    }
    const body = await parseBody(req);
    const defaultReworkReason = body.reworkReason || "批次取消，需返工";
    const reasons = parseReasons(body.reworkReasons);
    batch.status = "cancelled";
    batch.cancelledAt = new Date().toISOString();
    batch.cancelReason = body.reason || body.cancelReason || "";
    const released = [];
    const kept = [];
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      if (damage.status === "in_progress") {
        // 已开始的缺损不释放，保留在批次中并记录返工原因
        damage.status = "rework";
        damage.reworkReason = reasons.get(damage.id) || defaultReworkReason;
        kept.push(damage.id);
      } else {
        // 尚未开始的缺损释放回待修池
        damage.status = "pending";
        damage.batchId = null;
        damage.estimatedHours = null;
        damage.startedAt = null;
        released.push(damage.id);
      }
    });
    batch.damageIds = kept;
    batch.releasedDamageIds = [...(batch.releasedDamageIds || []), ...released];
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === completeMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    if (batch.status !== "open") {
      return send(res, 409, { error: `批次已${batch.status === "completed" ? "完工" : "取消"}，不能重复完工` });
    }
    const body = await parseBody(req);
    const results = Array.isArray(body.results) ? body.results : [];
    batch.status = "completed";
    batch.completedAt = new Date().toISOString();
    batch.note = body.note ?? batch.note;
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const result = results.find((item) => item.damageId === damage.id) || {};
      damage.status = "repaired";
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = new Date().toISOString();
    });
    // 批次完工后工位自动释放（工位负载仅统计open批次）
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
