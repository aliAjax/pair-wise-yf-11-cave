# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、工位和修补批次。

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
- `POST /damages/:id/start`
- `GET /stations`
- `POST /stations`
- `GET /stations/:id`
- `GET /batches`
- `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/cancel`
- `POST /batches/:id/complete`

## 工位容量闭环

- 建批必须选择工位（`workstationId`）并为每项缺损登记预计工时（`estimatedHours`）。
- 批次总工时超过工位日容量，或该工位仍有未完工批次时，整批返回 `409`，状态不落盘。
- `POST /damages/:id/start` 登记缺损开工时间；取消批次时只释放尚未开始的缺损（回到 `pending`），已开始的保留在批次内且返工原因（`reworkReason`）不清除。
- 批次完工（`complete`）或取消（`cancel`）后工位自动释放，可承接下一批。
- `GET /stations` 实时返回工位负载（`committedHours` / `remainingCapacityHours` / `available`），批次进度（`started` / `progress`）与拓片统计（`repairedDamages` / `inRepairDamages`）同步更新。

## 闭环示例

```bash
# 查看工位负载
curl http://127.0.0.1:3020/stations

# 建批：选择工位并登记每项缺损预计工时
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","workstationId":"station_demo","items":[{"damageId":"damage_demo_1","estimatedHours":2},{"damageId":"damage_demo_2","estimatedHours":1.5}]}'

# 也兼容 damageIds + estimatedHours 映射的写法
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","workstationId":"station_demo","damageIds":["damage_demo_1","damage_demo_2"],"estimatedHours":{"damage_demo_1":2,"damage_demo_2":1.5}}'

# 开工、取消（只释放未开始的缺损）、完工（释放工位）
curl -X POST http://127.0.0.1:3020/damages/damage_demo_1/start
curl -X POST http://127.0.0.1:3020/batches/<batchId>/cancel -H 'Content-Type: application/json' -d '{"reason":"工位临时停用"}'
curl -X POST http://127.0.0.1:3020/batches/<batchId>/complete -H 'Content-Type: application/json' -d '{}'
```
