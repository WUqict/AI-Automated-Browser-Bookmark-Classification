# AI MarkMaster 修改方案（分类准确率 + 视觉升级）

## 1. 目标
- 提升书签自动分类准确率，减少误分和手工干预。
- 保持“尽量零手工”体验：用户无需维护大规模规则。
- 升级插件界面为高级白色、磨砂玻璃风格。
- 更新扩展图标，形成统一视觉识别。

## 2. 分类能力改造（按优先级）

### P0：快速提升准确率（1-2 天）
1. 结构化输入替代“仅 URL+标题”
- 新增页面信号提取：`title`、`meta keywords`、`meta description`、`og:title`、`h1`、`domain`、`path_tokens`。
- 给模型输入结构化 JSON，减少歧义。

2. 强约束输出
- 模型返回固定结构：
  - `category`（必须在白名单）
  - `new_title`
  - `confidence`（0-1）
  - `reason`
- 后端严格校验，越界分类自动降级到“其他/待确认”。

3. 低置信度保护
- 设阈值（建议 0.70）：
  - `>= 0.70` 自动移动并重命名。
  - `< 0.70` 暂存到“待二次判断”文件夹，不立即强行分类。

4. 错误回退与可观测性
- 页面抓取失败或 API 失败时，回退到当前逻辑（URL+标题）。
- 日志增加：`confidence`、`reason`、`source_signals`、`fallback_reason`。

### P1：零手工自动学习（3-5 天）
1. 自动沉淀域名规则
- 统计高置信度结果：当某域名在最近 N 次中一致性高（例如 5 次且一致率 >= 0.8）自动写入 `domainRules`。
- 分类时优先命中 `domainRules`，再走 AI。

2. 二次判定机制
- 对低置信度样本异步重判（更完整提示词/更多网页信号）。
- 可选 2-3 次轻量多投票，取多数结果。

3. 规则自净
- 若后续 AI 高置信度持续与既有规则冲突，自动降低规则权重并触发重学习。

### P2：规模化与性能（后续）
1. 缓存策略
- URL 信号缓存（TTL 7 天），减少重复抓取和 API 成本。
- 域名级缓存（站点级默认标签）。

2. 批处理优化
- 历史整理从“逐条”改为“小批次 + 并发上限 + 退避重试”。
- 优先处理近 90 天活跃书签。

3. 检索增强
- AI 检索先做本地粗筛（标题/域名/关键词），再送模型重排，降低 token 开销。

## 3. 数据结构变更建议

### chrome.storage.sync
- `apiKey: string`
- `categories: string[]`
- `enabled: boolean`
- `recentLogs: Array<LogEntry>`
- `domainRules: Record<string, string>`
- `ruleStats: Record<string, { total: number; byCategory: Record<string, number> }>`

### chrome.storage.local
- `processingState`
- `signalCache: Record<string, { fetchedAt: number; signals: PageSignals }>`
- `pendingRejudge: string[]`

## 4. 安全与合规
- `host_permissions` 若要抓取网页信号，需要扩展到更广域名（建议按需申请并在 UI 说明用途）。
- 拦截危险协议（已实现）继续保留。
- API Key 仍在 `storage.sync`，后续可选迁移到 `storage.local` + 加密包装（若需跨设备同步则保留 sync）。

## 5. 验收指标（建议）
- 自动分类准确率：基线 +15% 以上。
- 低置信度误分率：下降 30% 以上。
- 用户手工改动次数：周均下降 40% 以上。
- 平均分类耗时：单条 <= 2.5s（含抓取+AI）。

## 6. 视觉升级（本次落地）
- 主题：高级白 + 磨砂玻璃。
- 关键视觉：浅色渐变背景、半透明白卡片、柔和阴影、细边框高光。
- 图标：重绘 16/48/128 PNG，统一为“书签 + AI 星芒”风格。
