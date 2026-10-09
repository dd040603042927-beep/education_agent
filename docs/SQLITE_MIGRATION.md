# SQLite 小范围切换与回滚

## 本轮范围

- Node.js >= 22.13，使用内置 `node:sqlite`；无额外 npm 依赖。
- 服务、示例环境和存储工厂默认使用 SQLite，显式设置 `STORAGE_DRIVER=json` 仍可兼容旧驱动。
- `learning_events`、`diagnosis_results`、`student_mastery` 是学习事件、诊断和掌握度的读写来源，不再在 `app_state.value_json` 内保存这三个数组。
- 保留诊断幂等键、数组顺序、零分、零秒和空值；唯一约束失败会回滚整个事务，不再静默忽略重复记录。
- 旧 SQLite 的完整 `app_state` 在首次读取时升级；直接升级旧库前也应先备份。此升级不会从旁边的 JSON 自动导入数据。
- 掌握度聚合和题库导入脚本读取 `.env`，通过同一存储接口操作当前数据库，不再硬编码写旧 JSON。

本轮仍保留 `readDb/writeDb` 全量对象接口：写入时在一个事务内更新 `app_state` 并重建三个学习表。尚未实现按行增量写入或多进程读改写的并发冲突控制；小范围运行请保持单个服务进程，并在维护脚本写入时暂停业务服务。不要把本轮视为所有业务表都已拆分。

## 从当前 JSON 迁移

在项目根目录执行。停止所有本项目服务及维护脚本，保持停机直到切换完成。迁移脚本会检查源 JSON 是否变化及 SQLite 是否有活动 sidecar，但这些检查不能代替停止所有写入进程。

1. 确认 `.env` 中 `DATA_DIR`、`DATABASE_URL`、`BACKUP_DIR` 指向正确目录。脚本会读取 `.env`，已设置的进程环境变量优先。未指定数据库地址时使用 `DATA_DIR/education.db`。
2. 执行迁移：

```powershell
npm run migrate:sqlite
```

若目标库已存在，默认拒绝覆盖。确定以当前 JSON 为唯一来源、不要合并旧 SQLite 数据后，使用：

```powershell
npm run migrate:sqlite -- --replace
```

迁移过程：

- 创建独立的 `backups/sqlite-cutover-时间-随机后缀/`，保留源 `db.json` 和切换前的 `config.env`。
- 在目标数据库同目录生成临时 SQLite，逐字段比较读回结果与 JSON，并执行 `integrity_check`、`foreign_key_check`。
- 若目标存在，通过 SQLite `VACUUM INTO` 生成含已提交 WAL 数据的 `education-before.db` 备份；检查点完成、连接关闭后才允许替换。
- 仅在校验成功且源 JSON 未变时，将临时数据库重命名为目标文件。不会修改源 `db.json`，不会从旧画像推导额外学习事件或诊断。
- 将源 SHA-256、各集合数量、备份位置、校验结果写入 `data/migration-report.json` 和该次备份目录。失败时保留临时文件供排查；不要把失败的临时库当作运行库。

严格校验若发现源记录存在未支持的字段、重复唯一键或不能无损转换的值，会中止而不是忽略数据。先查明差异再迁移，不要删除校验来强行覆盖。

3. 成功后修改 `.env`：

```ini
STORAGE_DRIVER=sqlite
DATABASE_URL=file:./data/education.db
```

4. 启动服务并检查：

```powershell
npm start
```

在另一终端执行：

```powershell
Invoke-RestMethod http://127.0.0.1:5107/api/healthz
```

应显示 `storageDriver=sqlite`，且 `storagePath` 指向预期数据库。SQLite 没有应用状态但旁边存在 JSON 时，服务会要求先迁移，避免误生成演示数据。已有旧 SQLite 时不会自动以新 JSON 覆盖它，必须显式迁移。

## 验证与备份

```powershell
npm run check
npm run test:storage
npm test
$env:TEST_STORAGE_DRIVER = 'json'
npm test
Remove-Item Env:TEST_STORAGE_DRIVER
npm run backup
```

冒烟测试显式使用临时目录下的 SQLite，不会因项目 `.env` 的 `DATABASE_URL` 指向业务库而误写实际数据。测试用 Dify 地址和密钥也单独隔离。

`npm run backup` 对 SQLite 使用一致性快照，跳过 `-wal`、`-shm`，不再分别复制这些运行中文件；数据库位于 `DATA_DIR` 之外时也会备份，并在 `manifest.json` 中记录位置。上传附件与日志的复制不属于数据库事务，需要全套一致备份时仍应先停服。备份包含用户数据、密码哈希及可能的配置密钥，应限制访问权限，不要提交到 Git。

切换后 `data/db.json` 是迁移时的快照，不会继续更新。不要再次运行 `--replace` 来“同步”，否则会用旧 JSON 覆盖 SQLite 中的新业务数据。

## 回滚

先停止服务、执行备份，再决定回滚的数据时间点。

### 尚无新业务数据

保留当前 SQLite；确认原 JSON 的 SHA-256 与迁移报告一致后，将 `.env` 的 `STORAGE_DRIVER` 改回 `json` 并重启。若原 JSON 被改动，使用本次迁移备份中的 `db.json` 恢复。不要把旧 SQLite 的 `education-before.db` 当作此次 JSON 迁移的等价快照，它可能来自更早的数据版本。

### 已产生新业务数据

不能只把驱动改回 JSON。停服并备份后，在 `.env` 仍指向 SQLite 时先导出完整数据：

```powershell
node -e "const fs=require('fs'); const {openStorage}=require('./scripts/storage_cli'); const store=openStorage(); try { fs.writeFileSync('data/rollback-from-sqlite.json', JSON.stringify(store.read(),null,2), {flag:'wx'}); } finally { store.close?.(); }"
```

该命令会合并 `app_state` 与三张学习表；若导出文件已存在则拒绝覆盖。核对数据及数量后，保留原 `db.json` 备份，用该导出替换 `db.json`，再切回 JSON。自定义数据目录时相应调整导出路径。

## 后续分表顺序

1. 用户与角色、班级及成员关系。
2. 课程资料、知识图谱及节点/边。
3. 对话、消息、AI 运行记录。
4. 作业、提交、错题记录。
5. 审计日志及剩余学习数据。

每一步均先定义主键、关系、索引、回填和回滚策略，再将相应业务改为按行查询及事务更新；完成读写迁移后才从 `app_state` 移除对应字段。不能仅创建镜像表却仍从整块 JSON 读取。
