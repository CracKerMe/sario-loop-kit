# AGENT FIRST — `/automations` 诉求驱动工作台

## 背景

`/journeys/:id` 的范式是「画布优先」：React Flow 画布 + 19 节点 + Inspector 是主界面，Agent（JourneyAgentPanel）只是侧边抽屉。结果是开发者嫌拖拽繁琐，业务同学看不懂节点与表达式。

本方案不新增运行时——**journey graph 本来就是运行时模板**（graph → validate → compile → publish → 引擎执行）。颠覆的是交互范式：

> 诉求（大白话）→ 运行时模板 → 大白话执行叙事 → 诉求覆盖表 → 对话修订 → 应用 → 发布

## 范式对照

| 维度   | 旧 `/journeys/:id`     | 新 `/automations/:id`                      |
| ------ | ---------------------- | ------------------------------------------ |
| 主界面 | 画布 + Inspector       | 对话工作台（左线程 + 右叙事/覆盖栏）       |
| 起点   | 选模板 → 拖节点        | 诉求 textarea → Agent 生成模板             |
| Agent  | 侧边抽屉、单次生成     | 主界面、多轮会话，可主动提问               |
| 解释   | 「大白话」按钮（事后） | 执行叙事卡（一等产物，随图同步、锚定版本） |
| 诉求   | 无记录                 | 诉求档案落库，需求点 ↔ 节点覆盖表          |
| 画布   | 主编辑器               | 降级为 `···` → 专业视图，能力零删减        |

## 数据模型（`packages/db/src/schema/journeys.ts`）

- `journey_intent`（1:1 journey）— `brief`（原始诉求）、`requirements`（覆盖表 jsonb）、`narrative` + `narrative_version`（叙事缓存及其锚定版本，落后即提示刷新）。开发流程用 `db:push`；既有迁移文件本就落后于 schema，未为其生成迁移。
- `journey_agent_message` — 会话转录，`kind`: text / proposal（payload 含 guard 过的完整 graph + changeSummary + risks + requirements）/ question（可点选 options）。

## AI 管线（`packages/ai/src/journeyAgent.ts`）

- `runJourneyAgentTurn`：多轮 guard 管线（pipeline.ts 新增 `history` 支持），强制单工具 `emit_agent_turn`，动作为二选一：
  - `clarify` — 关键决策缺失时提问（≤2 个问题，可带可点选选项），可同步更新覆盖表；
  - `propose` — 完整图 + 变更摘要 + 风险 + **全量**覆盖表（全量替换语义）。
- Guard：zod 结构 → `guardAiGraph`（白名单 + validateGraph）→ 需求点 nodeId 必须存在于图中（propose 对照新图，clarify 对照当前图），修复轮强制纠正。
- 上下文注入：诉求、当前覆盖表、当前图、工作区模板/事件/已发布 journey/联系人属性键、数据映射规则——模型只能引用存在的东西。
- 节点语义文档：`NODE_TYPE_REFERENCE` 已补充 `waitEvent` 的 timeout 双分支语义（`sourceHandle: "event" | "timeout"`），这是表达「N 天内未发生某事件则……」的标准模式。

## Server 端点（`apps/server/src/routes/journeys.ts`）

| 端点                                | 作用                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `GET /:id/agent/session`            | intent + 转录 + latestVersion + validation                                   |
| `POST /:id/agent/turn`              | 一轮对话；首条消息自动创建 intent（brief = 原话）                            |
| `POST /:id/agent/apply`             | 提案 → `writeDraftVersion`（与 PUT /:id/draft 共用）→ 重新生成叙事并锚定版本 |
| `POST /:id/agent/refresh-narrative` | 版本未变直接回缓存；变了才调 LLM                                             |

草稿写入抽成 `writeDraftVersion`，人工画布与 Agent apply 走同一条编译前置路径，没有第二套图格式。

## Web（全新 `/automations` 页面组，旧 `/journeys` 原样保留待删）

| 文件                                          | 说明                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `routes/_auth/automations/index.tsx`          | 列表（状态筛选 + 搜索 + 暂停/恢复）                                                             |
| `routes/_auth/automations/new.tsx`            | 诉求优先创建：大白话 → copilot 生成（失败降级 `emptyWelcomeGraph`）→ 创建 → 携 brief 进入工作台 |
| `routes/_auth/automations/$automationId.tsx`  | 详情：工作台默认 Tab + 动态 Tab；画布/Lab/优化/迁移收进 `···`                                   |
| `features/journey-agent/JourneyWorkbench.tsx` | 会话线程 + 提案卡（应用）+ 提问快选 + 叙事卡（含过期刷新）+ 覆盖卡 + 输入框                     |
| `features/journey-agent/JourneyActivity.tsx`  | 紧凑版运行记录/节点漏斗/增量效果（自含数据加载）                                                |
| `features/journey-agent/pendingBrief.ts`      | new → 详情的 brief 一次性交接（router state 类型严格，不走 history state）                      |
| `components/app-sidebar.tsx`                  | Automations → `/automations`                                                                    |

侧栏文案不变（Automations）；后端 API/schema 命名不动（automationId 即 journeyId 的 UI 别名）。

## 资源草稿模式（预览 + 待确认 + 应用时落库）

提案不只改图，还能**随提案带资源草稿**。首个落地的是邮件模板：

1. Agent 在 propose 里声明 `templateDrafts: [{ key, name, purpose }]`——它只决定「需要什么邮件」，不写文案（缺模板永远不是卡住的理由，prompt 已明确）。
2. 服务端在返回提案前，用专用邮件管线 `generateEmailContent` 并行生成每份草稿的受守卫 ProseMirror doc（merge tag 只能引用真实存在的联系人属性）。
3. 提案卡展示草稿清单：**预览**（客户端 `renderEmailDoc` 渲染进 sandbox iframe）与**重新生成**（`POST /:id/agent/regenerate-template`，可带一句改写要求，改完只更新提案 payload，不产生任何资源）。
4. **应用时**才真正落库：`guardEmailContent` 重校验（payload jsonb 视为不可信存储）→ `renderEmailDoc` 出 html 缓存 → 插入 `email_template`（source=tiptap, doc+html+textBody）→ 图中 draft key 自动改写为新 templateId → 叙事基于改写后的图重新生成。响应携带 `createdTemplates` 供 toast 提示。

防幻觉闸门：guard 层校验 email 节点的 templateId 必须属于「工作区已有模板 ∪ 本提案草稿 key」，且每个草稿 key 必须被至少一个 email 节点引用，否则进修复轮。

这一模式可平移到其他资源（受众、数据映射等）：**Agent 声明意图 → 平台生成草稿 → 预览/重新生成 → 应用时物化**。

## 编辑闭环（生成之后怎么改）

工作台是所有生成物的「预览 → 编辑」入口，不要求用户去列表页翻找：

- **叙事卡**：邮件步骤可直接点击 → 弹出该节点当前绑定模板的真实预览（`api.getTemplate` 取 doc，客户端 `renderEmailDoc` 渲染）→「打开编辑器」深链 `/templates/$templateId`（tiptap 全功能编辑器）。步骤与模板的绑定随草稿图实时解析，应用/改绑后点击即得新模板。
- **提案卡草稿**：应用前是「预览 / 重新生成」；应用后（`createdTemplates` 回填）变为「去编辑」，直达编辑器。
- 其他编辑器类资源的处置（无需新增草稿管线）：

| 资源 | 编辑通道 |
| --- | --- |
| 邮件模板 | 草稿预览/重新生成 → 应用后叙事/提案卡直达编辑器（本节） |
| 触发受众/条件 | journey 用图内 SegmentFilter AST，对话即编辑；复杂情况进专业视图属性表单（ConditionExpressionField 双向） |
| 数据映射 | 图内 dataMapping（提案直接改）+ 专业视图 DataMappingPanel |
| 保存的受众 | journey 不依赖；如需复用，后续把 `generateSegmentAudience` 接入同一草稿模式 |

## 已验证（真实 LLM 全链路）

- 闭环一：copilot 生成 → 创建 → turn（Agent 主动澄清：模板不足、事件语义不明，覆盖表 1 covered / 2 needs_input）→ 回答后 turn（propose：并行路径 + 7 天 waitEvent 超时分支，3/3 covered）→ apply（v2 + 叙事 10 步大白话）→ session 状态一致。
- 闭环二（资源草稿）：工作区无模板时，Agent 提案自带 2 个模板草稿（欢迎 + 上手技巧，文案含真实 merge tag）→ 应用创建 2 个 tiptap 模板并自动改写 templateId。
- 测试：`packages/ai`（journeyAgent 23 例）、`apps/server`（journeyAgentRoute 8 例，apply 用真实 guardEmailContent 复验草稿 doc）。

## Settings 工作台（范式平移到 `/settings`）

同一范式对 Settings 的第二次落地，但交互形态针对 settings 的特点做了修正：**看板优先、点击优先**。settings 与 journey 的本质差异——journey 在「造一个模板」，settings 是「多个独立配置域的状态」——决定了起点不该是空白对话框：

- **看板是主界面**：`/settings` 直接展示 4 个核心配置域的状态卡（就绪/未配置/待验证）+ Agent 基于当前状态主动给出的「建议先处理」清单 + 大白话配置叙事。用户不必知道自己想要什么，页面告诉他缺什么。
- **点击优先于打字**：每张卡的 CTA（如「配置域名」）自动携带预置意图进入引导对话；Agent 的问题都带可点选选项（question options），全程可以只动鼠标。聊天输入框保留但只是捷径。
- **专业视图降两级而不是一级**：21 个面板不再整体平铺——4 个核心域在各自卡片上有「专业面板」深链，其余 17 项收进「高级与开发者设置」折叠区；`···` 顶栏菜单随之移除，界面 chrome 保持极简。

| 维度 | `/automations/:id` | `/settings` |
| --- | --- | --- |
| 主界面 | 对话工作台 + 叙事/覆盖栏 | 配置状态板（卡片 + 建议）+ 可收起的引导对话面板 |
| 起点 | 诉求 textarea → 生成模板 | 点卡片/建议 → 预置意图的引导对话 |
| 运行时模板 | JourneyGraph | `changes[]`（5 种 change） |
| 叙事锚定 | draft version | 配置指纹（无版本概念） |
| 专业视图 | React Flow 画布 | 21 个面板原样保留，入口收进卡片链接 + 高级折叠区 |

### 数据模型（`packages/db/src/schema/settings.ts`）

- `settings_intent`（1:1 workspace）— `brief`、`requirements`（覆盖表 jsonb，`changeRefs` 代替 nodeIds）、`narrative` + `narrativeFingerprint`。
- `settings_agent_message` — 转录，kind: text / proposal（payload 含 guard 过的 changes + changeSummary + risks + requirements）/ question。开发流程 `db:push`。

### AI 管线（`packages/ai/src/settingsAgent.ts` + `settingsNarrative.ts`）

- `runSettingsAgentTurn`：同一 guard 管线，单工具 `emit_settings_turn`，clarify / propose 二选一。propose 的 `changes` 走 discriminatedUnion 白名单，**可写域刻意收窄为 5 种**：
  - `add_domain`（发信域名；DNS 记录由平台在 apply 时生成——对应 templateDrafts 的「平台补全」角色）
  - `upsert_topic`（偏好中心主题）
  - `upsert_rule`（评分规则，按 name upsert；kind/字段交叉校验：property 必带 operator+value、event 必带 eventName、page 必带 pathContains、points ∈ [-100,100]）
  - `delete_rule`（ruleId 必须存在于当前配置）
  - `upsert_channel`（渠道连接）
- Guard 交叉校验：域名不得与现存重复、delete_rule 的 ruleId 必须存在、requirement 的 `changeRefs` 必须指向本提案的 change ref（clarify 中禁止携带）。敏感域（套餐/成员/密钥/隐私/抑制/表单/集成/实验/会议）在 prompt 中明确排除，Agent 只能 clarify 说明并指向专业面板。
- `generateSettingsNarrative`：配置快照 → 大白话叙事（headline/summary/sections/notes），独立 guard 管线。

### Server 端点（`apps/server/src/routes/settingsAgent.ts`，挂载 `/v1/settings/agent`，session-only）

| 端点 | 作用 |
| --- | --- |
| `GET /session` | intent + 转录 + 配置快照 + 指纹 |
| `POST /turn` | 一轮对话；首条消息自动创建 intent（brief = 原话）；上下文注入真实配置快照 + 联系人属性键 + 已知事件名 |
| `POST /apply` | 提案 → zod 重校验（payload jsonb 不可信）→ 逐条物化 → 重算指纹 → 重生成叙事；返回逐条 `applied` 结果 |
| `POST /refresh-narrative` | 指纹未变直接回缓存；变了才调 LLM |

**apply 物化走与手动面板完全相同的 core 函数**（`createSendingDomain`/`upsertPreferenceTopic`/leadScoring CRUD/`upsertChannelConnection`），没有第二套写法；审计日志因此天然同源（core 函数自记 `domain.create` 等，apply 整体另记 `settings.agent_apply` 含 before/after 指纹）。配置漂移（提案应用前规则已被手删、域名已被手加）按条记 `skipped` 而非整体拒绝——单条过期不拖垮提案。

### Web

| 文件 | 说明 |
| --- | --- |
| `features/settings-agent/SettingsWorkbench.tsx` | 配置状态板：叙事横幅 + 4 个域状态卡（状态徽章 + 一句大白话 + CTA 预置意图）+ 建议清单 + 高级折叠区；引导对话为可收起侧面板（移动端全屏），含线程/提案卡/提问快选/覆盖摘要 |
| `features/settings/settingsNav.ts` | 21 面板清单抽取为共享模块 |
| `features/settings/SettingsPanel.tsx` | 21 面板的唯一渲染 switch（$tab 与 all 共用） |
| `routes/_auth/settings/route.tsx` | 极简布局：标题 + 小入口「全部设置」→ `/settings/all` |
| `routes/_auth/settings/index.tsx` | `/settings` = 配置状态板（原 redirect 到 billing 已移除） |
| `routes/_auth/settings/all.tsx` | 旧版完整导航页（侧栏搜索 + 分组折叠 + hero），tab 走 search 参数；经典体验保留为二级入口 |
| `routes/_auth/settings/$tab.tsx` | 专业视图：面板原样保留 + 「返回工作台」条（旧深链不变） |

### 测试

`packages/ai`（settingsAgent 14 例：guard 拒绝路径 + 修复轮）、`apps/server`（settingsAgentRoute 7 例：真库 + mock ai，验证意图懒创建、五类 change 全物化、漂移跳过、篡改 payload 400、指纹缓存语义、502/400 映射）。

## 后续（非本期）

- 叙事确定性骨架：关键参数（时长/分支条件）由节点配置直接渲染句子，LLM 只做润色，杜绝叙事漂移。
- 专业视图手动改图后，覆盖表 nodeId 失效的自动重算。
- 运行级解释（run drawer 大白话：这个人为什么收到这封邮件）。
- 资源草稿模式扩展到受众/segment（`generateSegmentAudience` 管线已有）。
- Settings 工作台可写域扩展：forms / plays / signals / meetings 等按同一 change-union + guard 模式逐域加入（敏感域保持人工-only）。
- 重新生成时支持用户改写指令的前端输入框（后端已支持 `instruction` 参数）。
- canary 评估/放量入口目前仍在旧页与 Settings；旧页删除前需迁移。
- 旧 `/journeys/*` 页面与 JourneyAgentPanel/CopilotDialog 的删除清单（旧 Agent 面板已无入口，文件暂留）。

## 删除旧逻辑的检查单（未来执行）

1. 侧栏已切 `/automations`（已完成）。
2. 确认工作台 + 专业视图覆盖全部旧编辑场景（含 19 节点高级编排）。
3. 迁移 canary 入口后删除 `routes/_auth/journeys/*`、`JourneyAgentPanel.tsx`、`CopilotDialog.tsx`。
4. 后端 API 是否更名 `/v1/automations/*` 届时再议（涉及 API key 集成方）。
