# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次和工位。

## 启动

```bash
PORT=3020 node server.js
```

## 主要接口

- `GET /health`
- `GET /rubbings`
- `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`
- `GET /damages?status=&type=`
- `PATCH /damages/:id`
- `GET /workstations`
- `POST /workstations`
- `GET /workstations/:id`
- `GET /batches`
- `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/cancel`
- `POST /batches/:id/complete`

## 工位容量闭环

- 建批必须选择工位（`workstationId`）并为每项缺损登记预计工时（`estimates`）。
- 预计总工时超过工位日容量，或该工位仍有未完工批次时，整批返回 `409`，状态不落盘。
- `PATCH /damages/:id` 将缺损置为 `in_progress` 即视为已开始修补（记录 `startedAt`）。
- 取消批次只释放尚未开始的缺损（回到 `pending`）；已开始的保留在批次内并记录返工原因（`reworkReason`）。
- 批次完工后工位自动释放；批次进度、工位负载与拓片统计随状态同步更新。

## 闭环示例

```bash
curl http://127.0.0.1:3020/damages?status=pending
curl http://127.0.0.1:3020/workstations

# 建批：选择工位并登记每项缺损预计工时
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","workstationId":"ws_demo_1","damageIds":["damage_demo_1","damage_demo_2"],"estimates":{"damage_demo_1":2,"damage_demo_2":3.5}}'

# 开始修补某缺损
curl -X PATCH http://127.0.0.1:3020/damages/damage_demo_1 \
  -H 'Content-Type: application/json' \
  -d '{"status":"in_progress"}'

# 取消批次：未开始的释放，已开始的保留返工原因
curl -X POST http://127.0.0.1:3020/batches/<batchId>/cancel \
  -H 'Content-Type: application/json' \
  -d '{"reason":"工位临时检修","reworkReason":"补纸已上墙，需返工"}'

# 完工：释放工位
curl -X POST http://127.0.0.1:3020/batches/<batchId>/complete \
  -H 'Content-Type: application/json' \
  -d '{"defaultRepairNote":"按原纹样补全"}'
```
