# UI 打磨 & 社区模板 — 更新总结

## 新增社区邮件模板（12 → 18）

| # | ID | 分类 | 标签 | 主题 |
|---|---|---|---|---|
| 1 | `getting-started` | onboarding | Getting started guide | "Let's get you started" |
| 2 | `holiday-promo` | announcement | Holiday promotion | "A little something for the season" |
| 3 | `monthly-roundup` | newsletter | Monthly roundup | "Your monthly roundup" |
| 4 | `order-confirmation` | transactional | Order confirmation | "Order confirmed ✓" |
| 5 | `shipping-update` | transactional | Shipping update | "Your order is on its way" |
| 6 | `referral-invite` | lifecycle | Referral invite | "{{contact.firstName}}, you've got a friend on the inside" |

**分类平衡：**
- onboarding: 2 → 3
- announcement: 3 → 4
- newsletter: 1 → 2
- transactional: 2 → 4
- lifecycle: 4 → 5

## UI 改进

### 1. Dashboard 欢迎横幅
**文件**: `apps/web/src/routes/_auth/dashboard.tsx`

当 workspace 全新（contacts=0, automations=0, emails=0）时，统计卡片下方显示一个友好的欢迎横幅：
- "Welcome to Loopkit!" 标题
- "Create your first automation to start sending emails on autopilot." 副标题
- 醒目的 "Create automation" CTA 按钮

### 2. Settings 页面 Tab 导航
**文件**: `apps/web/src/routes/_auth/settings/$tab.tsx`

为 Settings 页面添加了水平 tab 栏：
- API Keys | Logs | Suppressions 三个 tab
- 当前 tab 用 `border-b-2 border-primary` 高亮
- 页面标题和描述
- 保持现有面板渲染逻辑不变

### 3. 新建 Journey 模板流程预览
**文件**: `apps/web/src/routes/_auth/journeys/new.tsx`

每个模板卡片下方增加了节点流程预览文字：
- Welcome drip: "Trigger → Email → Delay → Email → Exit"
- Onboarding branch: "Trigger → Email → Delay → Branch → Email × 2 → Exit"
- Winback: "Trigger → Email → Delay → Filter → Email → Exit"
- 等等

### 4. Journey Activity 空状态优化
**文件**: `apps/web/src/routes/_auth/journeys/$journeyId.tsx`

将 "No runs yet" 改为更友好的 "No activity yet"，副标题改为 "Publish this automation and add contacts to see runs here."

### 5. Templates 页面空状态增加社区模板入口
**文件**: `apps/web/src/routes/_auth/templates/index.tsx`

在空状态区域增加了 "Start with a template" 按钮，引导用户使用社区模板画廊。

## 验证结果

| 检查项 | 结果 |
|---|---|
| `pnpm -w check-types` (11 packages) | ✅ 全部通过 |
| `pnpm test` (email-doc: 119 tests) | ✅ 全部通过 |
| `pnpm test` (server: 71 tests) | ✅ 全部通过 |
