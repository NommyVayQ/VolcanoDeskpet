# Supervisor 事件 Schema（v0.5.x 角色监管窗口）

## 1. 总览

Supervisor 是 DeskPet 的**只读监管子系统**——实时记录角色行为，用于溯源 bug（卡死、热加载残留态、动作异常等）。

| 特性 | 取值 |
|---|---|
| 埋点开销 | < 1KB JSON/事件，可忽略 |
| 缓冲策略 | 环形 1000 条 + UI 层再 5000 条 |
| 时间字段 | `ts`(Date.now，给人) / `tsMs`(performance.now，相对) / `frame`(PIXI 帧号) |
| 默认可见性 | dev 模式开启；生产 `?dev=1` 或 `Ctrl+Shift+D` 唤出 |
| 失败处理 | 所有 emit 包 try/catch，绝不污染主流程 |

## 2. PetLogEvent 字段

```ts
interface PetLogEvent {
  ts: number;                  // Date.now() 时间戳 (ms)
  tsMs: number;                // performance.now() 相对 sessionStart (ms)
  frame: number;               // PIXI ticker 帧号
  level: 'action' | 'physics' | 'system' | 'warn' | 'error';
  petId?: string;              // 当前 pet id
  category: string;            // 见下表
  cause?: string;              // 触发源（动作id / 边界 / 鼠标方向 / ...）
  before?: unknown;            // 触发前状态快照（≤ 200B）
  after?: unknown;             // 触发后状态快照
  meta?: Record<string, unknown>;
}
```

## 3. 事件分类

| category | level | 触发位置 | 用途 |
|---|---|---|---|
| `pet.lifecycle` | system | `Pet.constructor` / `Pet.clearInstances` | 幽灵 pet 溯源、总数异常 |
| `action.change` | action | `Pet.setAction` 入口 | **最高价值**：卡死溯源、状态切换异常 |
| `walk.boundary` | action | `Pet.stepWalk` 撞墙判定 | 攀爬误触发、原地踏步鬼畜 |
| `physics.thrown` | physics | `Pet.applyImpulse` | 抛投参数异常、竖直飞太高 |
| `mouseThrough.transition` | system | `app.ts reconcile` 翻转时 | 拖拽/菜单后穿透残留态定位 |
| `ticker.stall` | error | `app.ts ticker` 间隔 >1s | 渲染循环卡死第一信号 |

## 4. 导出 JSON 格式

监管面板「Export JSON」按钮产出的文件结构：

```json
{
  "session": {
    "exportedAt": "2026-09-06T15:30:00.000Z",
    "totalEmitted": 1234,
    "bufferSize": 1000
  },
  "events": [ ... ],
  "config": { ... }  // 导出当时的 config.json 快照（用于还原现场）
}
```

## 5. 调试快捷键

| 快捷键 | 行为 |
|---|---|
| `Ctrl+Shift+D` | toggle 监管面板 |
| `Esc` | 关闭监管面板 |

## 6. 状态条卡死判据

状态条每帧渲染 `petId:action:facing:x:y:frame` 快照 key。
**≥ 2s 无变化 → 该 pet 显示红色背景**。
判定阈值的依据：60fps 下连续 2s 必然有微小抖动（facing / frame），静止不动 = 真卡死。

## 7. 已知约束

- 环形缓冲 1000 条 ≈ 30s 事件流（按 50% 命中率估算）。更长的 bug 复现请在面板展开前先暂停订阅（Pause 按钮），避免被覆盖。
- 状态条 RAF 循环与 PIXI ticker 是两条独立线程，可能出现 ~16ms 漂移。比对事件 frame 字段时已对齐。
- 导出 JSON 时配置快照通过 `fs` 读取，需 renderer 进程 `nodeIntegration: true`（当前 DeskPet 已开启）。