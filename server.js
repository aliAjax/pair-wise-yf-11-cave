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
      reworkReason: "",
      batchId: null,
      estimatedHours: null,
      startedAt: null,
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
      reworkReason: "",
      batchId: null,
      estimatedHours: null,
      startedAt: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    }
  ],
  stations: [
    {
      id: "station_demo",
      name: "一号修补工位",
      dailyCapacityHours: 8,
      note: "熟纸补配与全色",
      createdAt: new Date().toISOString()
    }
  ],
  batches: []
};

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "POST /damages/:id/start",
  "GET /stations",
  "POST /stations",
  "GET /stations/:id",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/cancel",
  "POST /batches/:id/complete"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

function normalizeDb(db) {
  db.rubbings = Array.isArray(db.rubbings) ? db.rubbings : [];
  db.damages = Array.isArray(db.damages) ? db.damages : [];
  db.stations = Array.isArray(db.stations) ? db.stations : [];
  db.batches = Array.isArray(db.batches) ? db.batches : [];
  db.damages.forEach((damage) => {
    if (damage.estimatedHours === undefined) damage.estimatedHours = null;
    if (damage.startedAt === undefined) damage.startedAt = null;
    if (damage.reworkReason === undefined) damage.reworkReason = "";
  });
  db.batches.forEach((batch) => {
    if (batch.workstationId === undefined) batch.workstationId = null;
    if (!Array.isArray(batch.items)) batch.items = [];
    if (batch.cancelledAt === undefined) batch.cancelledAt = null;
  });
  return db;
}

async function readDb() {
  await ensureDb();
  return normalizeDb(JSON.parse(await readFile(DB_FILE, "utf8")));
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

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    const error = new Error("拓片不存在");
    error.status = 404;
    throw error;
  }
  return rubbing;
}

function findStation(db, stationId) {
  const station = db.stations.find((item) => item.id === stationId);
  if (!station) {
    const error = new Error("工位不存在");
    error.status = 404;
    throw error;
  }
  return station;
}

function openBatchForStation(db, stationId) {
  return db.batches.find((batch) => batch.workstationId === stationId && batch.status === "open") || null;
}

function batchEstimatedHours(batch) {
  return batch.items.reduce((sum, item) => sum + (Number(item.estimatedHours) || 0), 0);
}

function enrichStation(db, station) {
  const activeBatch = openBatchForStation(db, station.id);
  const committedHours = activeBatch ? batchEstimatedHours(activeBatch) : 0;
  return {
    ...station,
    activeBatchId: activeBatch ? activeBatch.id : null,
    committedHours,
    remainingCapacityHours: Math.max(0, station.dailyCapacityHours - committedHours),
    available: !activeBatch
  };
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  const repaired = damages.filter((item) => item.status === "repaired").length;
  return {
    ...batch,
    damages,
    total: damages.length,
    repaired,
    pending: damages.filter((item) => item.status !== "repaired").length,
    started: damages.filter((item) => item.startedAt).length,
    estimatedHours: batchEstimatedHours(batch),
    progress: damages.length ? Number((repaired / damages.length).toFixed(2)) : 0
  };
}

function normalizeBatchItems(body) {
  const fail = (message) => {
    const error = new Error(message);
    error.status = 400;
    throw error;
  };
  let items = [];
  if (Array.isArray(body.items) && body.items.length) {
    items = body.items.map((item) => ({
      damageId: item && item.damageId,
      estimatedHours: item && item.estimatedHours
    }));
  } else if (Array.isArray(body.damageIds) && body.damageIds.length) {
    const estimates = body.estimatedHours && typeof body.estimatedHours === "object" ? body.estimatedHours : {};
    items = body.damageIds.map((damageId) => ({ damageId, estimatedHours: estimates[damageId] }));
  } else {
    fail("damageIds必须是非空数组");
  }
  const deduped = new Map();
  items.forEach((item) => deduped.set(item.damageId, item));
  items = [...deduped.values()];
  if (items.some((item) => !item.damageId)) fail("每项缺损需包含damageId");
  const invalidHours = items.some(
    (item) => typeof item.estimatedHours !== "number" || !Number.isFinite(item.estimatedHours) || item.estimatedHours <= 0
  );
  if (invalidHours) fail("每项缺损需登记大于0的预计工时estimatedHours");
  return items;
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
        inRepairDamages: damages.filter((item) => item.status === "in_repair").length
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
      reworkReason: "",
      batchId: null,
      estimatedHours: null,
      startedAt: null,
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

  const damageStartMatch = pathname.match(/^\/damages\/([^/]+)\/start$/);
  if (damageStartMatch && req.method === "POST") {
    const damage = db.damages.find((item) => item.id === damageStartMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    if (damage.status !== "in_repair") return send(res, 409, { error: "缺损未处于修补中，无法开始" });
    if (!damage.startedAt) {
      damage.startedAt = new Date().toISOString();
      await writeDb(db);
    }
    return send(res, 200, { data: damage });
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
    damage.repairedAt = damage.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  if (req.method === "GET" && pathname === "/stations") {
    return send(res, 200, { data: db.stations.map((station) => enrichStation(db, station)) });
  }

  if (req.method === "POST" && pathname === "/stations") {
    const body = await parseBody(req);
    required(body, ["name", "dailyCapacityHours"]);
    if (typeof body.dailyCapacityHours !== "number" || !Number.isFinite(body.dailyCapacityHours) || body.dailyCapacityHours <= 0) {
      return send(res, 400, { error: "dailyCapacityHours必须是大于0的数字" });
    }
    const station = {
      id: makeId("station"),
      name: body.name,
      dailyCapacityHours: body.dailyCapacityHours,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.stations.push(station);
    await writeDb(db);
    return send(res, 201, { data: enrichStation(db, station) });
  }

  const stationMatch = pathname.match(/^\/stations\/([^/]+)$/);
  if (stationMatch && req.method === "GET") {
    const station = db.stations.find((item) => item.id === stationMatch[1]);
    if (!station) return send(res, 404, { error: "工位不存在" });
    const activeBatch = openBatchForStation(db, station.id);
    return send(res, 200, {
      data: {
        ...enrichStation(db, station),
        activeBatch: activeBatch ? enrichBatch(db, activeBatch) : null
      }
    });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "workstationId"]);
    const items = normalizeBatchItems(body);
    const station = findStation(db, body.workstationId);
    const invalid = items.filter((item) => !db.damages.find((damage) => damage.id === item.damageId));
    if (invalid.length) return send(res, 400, { error: `缺损项不存在：${invalid.map((item) => item.damageId).join(", ")}` });
    const activeBatch = openBatchForStation(db, station.id);
    if (activeBatch) {
      return send(res, 409, { error: `工位仍有未完工批次：${activeBatch.id}`, activeBatchId: activeBatch.id });
    }
    const totalEstimatedHours = items.reduce((sum, item) => sum + item.estimatedHours, 0);
    if (totalEstimatedHours > station.dailyCapacityHours) {
      return send(res, 409, {
        error: `批次预计工时${totalEstimatedHours}小时超过工位日容量${station.dailyCapacityHours}小时`,
        totalEstimatedHours,
        dailyCapacityHours: station.dailyCapacityHours
      });
    }
    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "open",
      workstationId: station.id,
      items,
      damageIds: items.map((item) => item.damageId),
      note: body.note || "",
      createdAt: new Date().toISOString(),
      completedAt: null,
      cancelledAt: null,
      cancelReason: ""
    };
    db.batches.push(batch);
    db.damages.forEach((damage) => {
      const item = items.find((entry) => entry.damageId === damage.id);
      if (item) {
        damage.batchId = batch.id;
        damage.status = "in_repair";
        damage.estimatedHours = item.estimatedHours;
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
    if (batch.status !== "open") return send(res, 409, { error: "批次已完工或已取消，无法取消" });
    const body = await parseBody(req);
    const releasedDamageIds = [];
    const keptDamageIds = [];
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      if (damage.startedAt) {
        // 已开始的缺损保留在批次内，返工原因不清除
        keptDamageIds.push(damage.id);
      } else {
        damage.status = "pending";
        damage.batchId = null;
        damage.estimatedHours = null;
        releasedDamageIds.push(damage.id);
      }
    });
    batch.status = "cancelled";
    batch.cancelledAt = new Date().toISOString();
    batch.cancelReason = body.reason || "";
    await writeDb(db);
    return send(res, 200, { data: { ...enrichBatch(db, batch), releasedDamageIds, keptDamageIds } });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === completeMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    if (batch.status !== "open") return send(res, 409, { error: "批次已完工或已取消" });
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
