# 可调参数说明（config）

本目录下的 **`config.json`** 是给使用者改的「行为参数」，**改完重启 `DeskPet.exe` 即生效，不用重编译、不用碰代码**。开发模式下（`npm run dev`）则由程序**自动热重载**（改完保存、窗口里即时生效，不用重启）。

> 美术图片的替换不在这里，在 `resources/assets/`（见 `assets/README.md`）。这里只管「怎么动、怎么说话、气泡在哪、有哪些动作」。

## 目录结构（已按类型分类）

为方便按角色改数据，config 拆成四类子目录，由 `config.json` 主索引串起来：

| 子目录 / 文件 | 管什么 | 文件形态 |
|---|---|---|
| `config.json` | **主索引**：全局 `meet` + `characters`（角色 id 清单，如 `["nina","rose","rebeza"]`） | 极薄 |
| `characters/<id>.json` | 角色基础属性（size/facing/meetRules/drag*/wanderActions…） | 每角色一个 |
| `actions/<id>.json` | 该角色的全部动作（behavior/frames/frameMs/loop/menu/dialogue） | 每角色一个，`{ "actions": {...} }` |
| `images/<id>.json` | 帧名 → PNG 路径（`{ "shime1": "nina/shime1.png" }`），即"动作对应的图片" | 每角色一个（+ `coop.json` 合体帧） |

改某角色的**动作**只动 `actions/nina.json`，改**动作用哪张图**只动 `images/nina.json`——互不干扰。

## 文件位置

| 场景 | 路径 |
|---|---|
| 给别人用的便携版 | `DeskPet.exe` 同级的 `config/`（含子目录） |
| 自己开发（`npm run dev`） | 项目根目录的 `config/`（含子目录） |

## 核心概念：动作 = 名称 + 运行模式 + 多帧

每个角色有一个 `actions` 注册表，**动作 id 是任意字符串**，每条动作是：

```json
"动作id": {
  "behavior": "运行模式",   // 见下表：static / walk / climb / ceiling / chase / fly / drag
  "frames": ["帧名1", "帧名2"],  // 帧名对应 config/images/<角色>.json 里的 帧名
  "frameMs": 800,           // 每帧停留毫秒（也可逐帧写成 {"name":"帧名","ms":250,"vx":3}）
  "loop": true,             // 是否循环
  "moveSpeed": 1.5,         // 位移动作(walk/climb/ceiling/chase/fly)的速度，可省略用角色级 moveSpeed
  "facePartner": true,      // 触发时是否面向对方（相遇用）
  "dialogue": ["台词"]      // 触发时显示的台词，数组随机取一句
}
```

> `vx` / `vy` = **逐帧位移速度**（px/帧 @60fps），参考 Shimeji「每个 Pose 自带 Velocity」。
> `vx` 用于 walk 类（该帧前进多少），`vy` 用于 climb 类（该帧上/下多少）；写 `0` 就是「该帧原地不动」（踩步 / 握稳的支撑帧）。
> 当前 `climb` 就是靠它做节奏的：`[{"vy":0,"ms":700},{"vy":3,"ms":250},{"vy":2.33,"ms":250}]` = 握稳 0.7s，再连爬两格。

### 运行模式 `behavior`（有限的代码行为集）

| behavior | 含义 |
|---|---|
| `static` | 原地（待机 / 相遇等） |
| `walk` | 沿屏幕**下沿左右**位移，按前进方向自动翻转 |
| `climb` | 沿屏幕**左右边框上下**爬。触发：walk 走到边框 / 空闲时贴着边框 / 下落中撞到边框。**一次攀爬会话内会上下折返巡逻**，到 `climbMaxMs`（默认 20s）才下墙：按 `climbEndFlyChance`（默认 50%）触发 `flyAction` 飞走，否则松手掉落 |
| `ceiling` | 贴**天花板横向**倒挂爬 |
| `chase` | 追鼠标（鼠标在动且够近才追，停手/超时回家） |
| `fly` | 屏幕内**任意方向飞**（不受重力与地面约束），到时长后落回地面 |
| `drag` | 被鼠标拖动（程序内部用，通常不用手工指定） |

> **上下爬共用同一套帧**：`climb` 往下爬时不倒放动画，而是把位移方向取反 —— 因为攀爬帧本身是「握紧→发力」的循环，方向无关。
> 若你为某个角色画了**专门的向下爬帧**，加一个动作（如 `climbDown`）再在角色配置里写 `"climbDownAction": "climbDown"` 即可，不用改代码。

> **新增「动作」只需加一条 JSON 数据**（如 `climb`）；只有新增「运行模式」才需要改 `src/renderer/Pet.ts` 的 `stepXxx` 函数 + `types.ts` 的 `ActionBehavior` 联合类型。

## 角色级常用字段

| 字段 | 含义 |
|---|---|
| `size.width` / `size.height` | 显示尺寸（px），高度是锚、宽度按美术比例算 |
| `moveSpeed` | 位移默认速度 |
| `detectionRadius` | 多近触发相遇 |
| `bottomMargin` | 离屏幕下沿上抬像素（0=贴边） |
| `interactionDuration` | 相遇维持毫秒 |
| `interactGap` | 相遇吸附后两人中心间距(px)，默认 30（保证脸对脸、中间留空） |
| `bubbleOffset` | 气泡离头顶倍数（0.35≈头顶上方 52px） |
| `facing` | 美术基础朝向 `left`/`right` |
| `defaultAction` | 初始/回归动作 id（默认 `idle`） |
| `interactAction` | 相遇触发动作 id（默认 `interact`） |
| `walkAction` | 左右漫游动作 id（默认 `walk`） |
| `climbAction` | 攀爬动作 id（默认 `climb`，碰屏幕左/右边框触发） |
| `flyAction` | 飞行/「起飞」动作 id（默认 `fly`）。攀爬会话到期时有概率从墙上飞走 |
| `climbMaxMs` | 一次攀爬会话最长毫秒，默认 **20000**；设 `0` = 无限巡逻（不推荐） |
| `climbTurnChance` | 墙中段「折返方向」的概率，默认 `0.35`。`1` = 每次换向（锯齿形上下），`0` = 只在顶/底折返 |
| `climbEndFlyChance` | 会话到期时「起飞」而非「松手掉落」的概率，默认 `0.5`。角色没有 `fly` 动作时恒为掉落 |
| `climbDownAction` | 专用「下爬」动作 id（可选）。不配则复用 `climbAction` 的帧、位移反向 |
| `climbCooldownMs` | 下墙后的冷却毫秒，默认 `3000`：这段时间内贴着屏幕边也不会再上墙 |
| `edgeMargin` | 攀爬/贴顶时容器允许探出屏幕的像素（默认 0；设为 50 可让人物本体贴住边框） |
| `dragAction` | 拖拽基础动作 id（静止/上下移动，默认 `drag`） |
| `dragLeftAction` | 拖拽向左时动作 id（默认 `dragAction`） |
| `dragRightAction` | 拖拽向右时动作 id（默认 `dragAction`） |
| `dragIdleAction` | 拖拽静止/上下移动时动作 id（默认 `dragAction`） |
| `wanderActions` | 空闲时随机漫游的动作 id 列表（如 `["walk","climb"]`） |
| `tapDialogue` | 轻触（点击不拖动）时随机说的台词数组；省略则轻触安静 |

## 示例 1：把妮娜相遇调慢

改 `config/actions/nina.json`，把 `interact` 的 `speed` 调小：

```json
{ "actions": { "interact": { "speed": 0.02 } } }
```

（只写要覆盖的字段即可，其余沿用现有文件）

## 示例 2：给妮娜新增一个「攀爬」动作

1. 在 `config/images/nina.json` 里确认有帧名（如 `shime1/2/3` 已存在）；
2. 在 `config/actions/nina.json` 的 `actions` 里加一条：

```json
"climb": {
  "behavior": "climb",
  "frames": [{"name":"shime1","vy":0,"ms":700},{"name":"shime2","vy":3,"ms":250},{"name":"shime3","vy":2.33,"ms":250}],
  "loop": true,
  "moveSpeed": 1.2
}
```

3. 在 `config/characters/nina.json` 里留默认值即可（`climbAction` 默认就是 `climb`），还可顺手调
   `climbMaxMs` / `climbTurnChance` / `climbEndFlyChance`；
4. 重启（或 dev 模式自动生效）。

> 攀爬**不需要**放进 `wanderActions` —— 它由「贴到边框」自动触发；放进漫游池反而会出现角色在半空中凭空抓墙。

## 示例 3：新增一个全新角色

1. 在 `config.json` 的 `characters` 清单里加 `"新id"`；
2. 新建 `config/characters/新id.json`（含 `id`/`name`/基础属性）+ `config/actions/新id.json` + `config/images/新id.json`。**零代码改动**。

## 轻触对话 `tapDialogue`

轻触（点击但不拖动）角色时，会从 `tapDialogue` 随机说一句台词；不写该字段则轻触保持安静（仅用于拖拽/右键菜单）。

```json
"tapDialogue": ["今天也要加油！", "嘿嘿~", "陪我玩嘛！"]
```

- **值** = 轻触时随机说的台词数组；写空数组 `[]` = 轻触不吐台词；
- **省略整个 `tapDialogue`** → 轻触不说话。

> 这与 `actions.*.dialogue`（相遇台词）、`grabDialogue`（被抓取台词）是各自独立的配置。

## 合体合作动作（如拥抱）`coop`

拥抱这类动作很难给两人各画一套同步帧——更好的做法是**画一张"合体帧"（已包含两人），由一方承载播放，另一方隐身让位**（因为它已经被画进合体帧里了，再显示独立贴图会穿帮）。

```json
"hug": {
  "behavior": "static",
  "frames": ["hug_nina"],   // 合体帧路径在 config/images/coop.json 下
  "coop": true,             // 必须：标记这是合体动作
  "lead": "nina",           // 合体帧里「被画进去」的主演 id（hug_nina 画的是 nina 抱 rose）
  "width": 220,             // 合体帧比单人宽，用动作级 width 覆盖角色级 size.width
  "menu": true,             // 进右键菜单，可手动触发
  "dialogue": ["抱抱~"]      // 台词位：数组随机取一句；写空数组/省略 = 不显示台词
}
```

**触发时左右占位自动处理**：两人谁在左谁在右决定谁当 lead、美术是否翻转（`flip`）。
- 若 `lead` 方实际在**右**，而合体帧画的是"lead 在左"，程序自动水平翻转美术（`body.scale.x = -1`），保证拥抱朝向正确。
- 你不用手动设 `flip`——触发时按相对位置算。

**台词位规则**（所有动作通用）：
- `dialogue` 是数组，随机取一句显示；
- 数组里**某项是空字符串 `""` 也会被过滤掉**，不显示；
- 整个 `dialogue` 省略或写 `[]` → 该动作不冒台词。

**触发方式**：
1. **右键菜单**：两个角色都在场时，右键其中一个 → 点 `hug` → 系统自动找另一个搭档演合体（一方承载、一方隐身）。
2. **概率相遇**：在 `meetRules` 里指定 `action`：
   ```json
   "meetRules": { "rose": { "chance": 0.02, "distance": 200, "action": "hug" } }
   ```
   相遇命中后不再演普通 interact，而是演合体拥抱。

> 合体帧美术建议：画"左抱右"（lead 在左）一张，命名 `hug_<lead>.png`，放 `assets/coop/`，并在 `config/images/coop.json` 下登记（`{ "hug_nina": "coop/hug_nina.png" }`）。

## 相遇概率 `meet`（顶层字段）

控制"两角色多久偶遇一次"——用**概率**而非固定间隔，所以观感自然、人多也不会刷屏。

```json
"meet": {
  "chance": 0.02,      // 每个判定周期(rollInterval)触发相遇的概率，0~1
  "distance": 200,     // 触发距离门槛(px)：两人中心小于此值才掷骰
  "rollInterval": 500  // 掷骰周期(ms)，默认 500
}
```

- `chance` 越大越频繁；想稀一点就调小（如 0.005）。
- 只有双方都处于**静止(idle)或走动(walk)**时才可能触发；climb/拖拽/菜单动作/已在相遇中不触发。
- 触发后两人**先互相走近**（approach 阶段），走到 `interactGap` 亲密距离才**演关键帧**（interact 动作+配对台词）。

### 每对独立频率 `meetRules`

在角色里按「对方角色 id」写规则，覆盖全局默认：

```json
"meetRules": {
  "rose": { "chance": 0.02, "distance": 200 }
}
```

- 没写某对 → 用全局 `meet` 兜底。
- 想让"妮娜↔露丝"比"妮娜↔新角色C"更频繁，就在这里分别调 `chance`。

## 右键动作菜单（menu:true）

在角色上**右键** → 弹出该角色 `actions` 里 `menu: true` 的项，点击即执行该动作。

```json
"actions": {
  "sit":  { "behavior": "static", "frames": ["shime1"], "speed": 0.1, "loop": true, "menu": true },
  "pray": { "behavior": "static", "frames": ["shime1"], "speed": 0.1, "loop": true, "menu": true }
}
```

- 只有显式 `"menu": true` 的动作才进菜单（拖拽等内部动作不加）。
- 新增动作标 `menu:true` 即自动出现在右键菜单，**零代码**。
- `sit`/`pray` 现在是占位（复用 shime1 帧），后续替换真美术+真帧名即可。

## 系统托盘 + 角色管理面板

- 程序启动后**系统托盘**出现 DeskPet 图标（当前为占位纯色图标）。右键托盘 → 「角色管理面板」「退出」。
- **角色管理面板**：列出 config 里全部可用角色；在场的可「删除」，不在场的可「召唤」。**同 id 不重复**（已存在则忽略）。
- 召唤/删除是运行时操作，不影响 config.json；config 里加新角色后重开面板即可召唤。

## 容错

文件损坏（少逗号等）→ 程序忽略它、用内置默认值，不崩溃，日志 `Data/boot.log` 写警告。
