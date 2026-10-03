# Changelog

所有显著变更都会记录在这里。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [6.0.0] - 2026-10-02

> 本版重点：**交互稳定性大修** —— 修掉窗口投掷卡死、合体互斥偶发卡死、合体触发闪烁；合体菜单统一改名「互动」；妮娜吃奶冻补帧节奏可配。自检：renderer+main tsc 0 错；verify-actions 全通过；check-pair-durations 11 配对 0 异常 Δ=0；verify-menu-groups 断言通过。

### 修复：格温抛掷窗口后永久卡帧（P0）
- 根因：`WindowInteract` 单例只维护一份 `show`。格温甩出窗口后，另一角色（如妮娜）自动掷骰触发 `startThrowShow`，其首行 `stop()` 把格温正在跑的 `show` 清空（`isWindowHeld=false` + `show=null`）却没走 `finishShow()` 收尾；而 `throwWindow` 是 `setAction` 直接调用的 loop:false 单帧、无收尾定时器，被清空后无人推进 → 永久定格在 L-throw-3。
- 修：`stop()` 的 show 分支改为「释放占用 + 切回默认动作」（与 `finishShow` 同款）；`startThrowShow` 加 `if (this.show) return false` 守卫，已有演出进行中则跳过本次触发，杜绝跨宠物互清；顺带覆盖「右键菜单打断窗口占用」同类路径。

### 修复：合体互斥锁偶发卡死（P1）
- 现象：点合体有时完全没反应、过一会又好了（rebeza↔gwen 最先被注意到）。
- 根因：`goRemove`（退场/移除路径）只清了**自身**的 `coopLead`/`coopFollow`，**没清搭档对自己的反向引用**。合体中途有一方退场/被移除时，活着的另一方卡在 `isInCoop()===true`，直到自身合体定时器自然到点（约 8s），期间互斥锁 `isAnyCoopActive()` 一直返回 true → 所有合体点不动。拖拽路径早已双向清理，唯独退场路径漏了。
- 修：退场时双向清理（自身主演→清配角 coopFollow；自身配角→清主演 coopLead）。

### 修复：触发互动时角色闪一下（P1）
- 根因：合体触发时 `triggerInteraction` 在 `startCoopLead()` 之后立刻同步 `maintainCoopSnap`，把主演容器摆到合体槽位；但 `setAction(coopFrame)` 加载合体帧是**异步**的，期间 `framesPending=true` 会**保留上一动作末帧**（走/站单角色帧）。那一拍画出来的是「单角色帧被摆在合体位」，下一拍合体帧就绪才换成双人对图 → 肉眼「闪一下」。缓存未命中（首次/被回收）时跨拍才闪，故偶发。
- 修：`Pet.ts` 暴露 `isFramesPending()`；去掉触发瞬间的同步 `maintainCoopSnap`，改由每帧 coop 吸附循环在帧集就绪后再摆位（摆正与出图同一拍完成，消除错帧）。

### 功能：合体互斥（同时只能有一组合体）（P2）
- `Pet.ts` 新增 `isInCoop()`；`app.ts` 新增 `isAnyCoopActive()`（覆盖合体帧播放中 / 配对走近中 / 旧式 coop 走近中三种态，普通相遇不计入），守卫全部三个合体触发入口（菜单 `pairTrigger`、菜单 `coop`、掷骰 `rollMeet`），避免同时多组合体。无死锁：取消/切动作都会清 `_pendingIsPair`。

### 功能：菜单「合体」统一改名「互动」（P2）
- 纯数据改动：5 个 `config/actions/*.json` 的 `menuGroup:"合体"`→`"互动"`；5 个 `config/characters/*.json` 的 `actionGroups` key+label「合体」→「互动」；`rose.interact`/`nina.interact`（旧式 coop，原本独立顶层项）加 `menuGroup:"互动"` 折叠进组，消除与合体类动作的重复；rebeza 残留「（合体）」label 改「（互动）」。
- 菜单文案：rose/nina 的 interact 命名为「拥抱妮娜」/「拥抱露丝」（frames 为 rose-nina-* / nina-rose-*）。

### 调整：妮娜吃奶冻补帧（sup）节奏（P3）
- `loop-sup-frames.mjs` 加 `--char <id>` 过滤（只处理指定角色，不误伤 rose/rebeza）；妮娜 `eatFromMona` 头补段按 `--cycle` 重排，总时长仍 5500ms、L/R 对称。本版落定为 800ms（约 7 帧 ×~786ms，交替 L-sup-1/L-sup-2）。

### 调整：手动帧数/速率调参回灌（来自 `release/桌宠测试版`）
- 把测试版里手调的帧数/速率同步回当前项目 config：共 167 处字段（5 个 actions/*.json + config.json 的 `window.throwChance` 0.3→0.01）。
- 覆盖范围：各角色 `frameMs`（eat/work/read/sing/pray/headache/meat 等多动作提速或降速）、`frames/rightFrames` 数组展开（重复帧拉长演出，如 gwen.work 6→26 帧、rose.read 7→21 帧）、`flyCeiling.moveSpeed`(3→2~2.3)、`climb` 帧 vy(2.33→2 / 1) 与 `moveSpeed`、`creep` 末帧 ms(600→800/1000)、合体 `offset.x` 微调(52→47/53/54)、`pair_*` 帧数展开与 frameMs。
- 保留当前项目文案（label）不被回退（如 gwen `pair_rose_gwen` 保持「和露丝聊天」而非测试版旧「和露丝辩论」）。
- 修一处测试版自带的不一致：`rose↔rebeza` 合体 `pair_rose_rebeza` 两侧帧数不等（rose 25 / rebeza 24，差 900ms；rebeza 美术只有 1~11 帧无 12）。将 rose 末帧 `rose-rebeza-12` 去掉对齐到 24×900=21600ms，restore 四向 Δ=0（共 11 配对 0 异常）。
- 校验：verify-actions 140 动作 0 失败；check-pair-durations 11 配对 Δ=0；verify-menu-groups 断言通过。

## [5.4.2] - 2026-09-28

> 本版重点：**拖拽松手误「飞起」修复 + 鼠标穿透「点不动」加固 + 主机无关性审计（高刷/低刷机器行为一致）**。自检：renderer+main tsc 0 错；verify-actions 全通过。

### 修复：拖拽松手角色向上飞而非掉落（P1）
- 根因：`Pet.ts` `onMove` 的抛投速度采样用 `dx = nx - container.x`（鼠标目标 − 弹簧滞后后的实际渲染位置），混入了 `updateDragTilt` 滞后量；且 `velX/velY` 只在 `onMove` 触发时更新，指针停住后不衰减。往上挪→停顿→松手 时残留负速度被当向上抛投，在滞后量更大的机器上暴露。
- 修：速度改取**相邻 pointermove 事件的真实指针位移 ÷ 事件间隔**，归一 60fps 参考帧再平滑（跨机器一致）；新增 `THROW_IDLE_MS=70`（松手前 >70ms 无移动→判定为轻轻放下，强制掉落）；`THROW_DEADZONE` 1.6(px/事件)→2.5(px/帧)。

### 加固：长时间捉宠后鼠标穿透「点不动」（P1）
- 机制链路：点中宠物 = `reconcile()` 据 `petAt()` 返回值翻转穿透；光标压宠时 `petAt()` 返回 null → 穿透卡死 → 点不动。
- 修：`petAt` 命中矩形改用 `container.x/y + config.size`（body 以 0.5 锚点居中于 tiltNode，container 即角色框左上角，挂在无缩放 stage 上）替代 `getBounds()`（去一帧滞后/旋转/气泡偏移的命中偏差）；加 `container.destroyed` 防御（防异常实例让 `reconcile` 抛异常冻结穿透态）；`beginDrag` 补 `removePending` 守卫（退场等待期宠物拒绝被捉）。

### 加固：主机无关性（高刷/低刷行为一致）
- 排查结论：动作帧播放、漫游概率、所有移动/重力/抛投、窗口投掷、DPI、计时器均已按墙钟或乘 `dt`，与刷新率无关。仅两处逐帧系数漏网：
- `updateDragTilt` 拖拽弹簧系数 `×(DRAG_FOLLOW)` → `×(1-Math.pow(1-DRAG_FOLLOW, dt))`（60Hz 等价，高刷跟手一致）。
- 落地后水平阻尼 `vx *= 0.99` → `vx *= Math.pow(0.99, dt)`（60Hz 等价，高刷落地滑距一致）。

## [5.4.1] - 2026-09-27

> 本版重点：**修复「托盘菜单窗口归还不生效 / 角色全没」的构建路径错位 + 修复窗口投掷抓到看不见的窗口**。自检：renderer+main tsc 0 错；verify-actions 全通过。

### 修复：主进程构建产物路径错位（P0）
- 根因：引入 `src/shared` 共享类型后 `tsconfig.main.json` 未设 rootDir，产物从 `dist/main/index.js` 挪到 `dist/main/main/index.js`，而 `package.json` 的 `main` 仍指向旧路径 → Electron 一直加载旧产物（托盘菜单改动看不到、改完后甚至白屏角色全没）。
- 修：`tsconfig.main.json` 显式 `rootDir:"src"`；`package.json` `main`→`dist/main/main/index.js`；`index.ts` 加载 renderer 的 `loadFile` 相对路径 `../`→`../../`（__dirname 下钻一级）；dev `wait-on`、verify-build、probe 脚本路径同步。

### 修复：窗口投掷抓住「不存在的窗口」（P1）
- 根因：UWP 挂起窗口（如 Windows 设置）被 DWM 披隐（cloaked），`IsWindowVisible` 仍返回 true；完全在屏幕外的窗口也未过滤 → 角色去抓用户看不见的窗口。
- 修：`winapi.ts` 加载 `dwmapi.dll`，`DwmGetWindowAttribute(DWMWA_CLOAKED)` 排除披隐窗；枚举时按 DIP 坐标与各显示器 bounds 求交，完全无交的排除（半截在屏外仍保留）。

### 改动：扛窗固定跑速 + 投掷日志补窗口名
- 扛窗阶段去掉走/跑 50% 随机，固定用跑速（CARRY_RUN_SPEED，原版 RunWithIe）。
- 投掷日志的「起跳 / 落地 / 扛着走」三段补上被抛窗口标题，便于排查。

## [5.4.0] - 2026-09-19

> 本版重点：**飞行「移动/悬停」双相位（对齐旧桌宠走走停停）+ 贴顶飞对齐旧桌宠 + 退场前先落地**。自检：renderer+main tsc 0 错；verify-actions 99 动作 0 失败（唯一告警为 nina/plantCarrot 画布尺寸，不阻塞）。

### 新增：飞行「移动 / 悬停」双相位（5 角色全员）
- 对齐旧桌宠「飞一段就停下来扑翼片刻」：位移中播 `flymoving` 两帧、静止飞行播 `fly` 两帧。
- 纯数据字段：`hoverFrames` / `hoverRightFrames`（悬停帧集）+ `flyMoveMinMs/MaxMs`（移动段随机时长）+ `flyHoverMinMs/MaxMs`（悬停段）。全员统一为移动 1100–2300ms / 悬停 900–2000ms（悬停占比约 46%），想调只改这四个数。
- 实现要点：新增 `flyDualPhase` 总开关（按配置 `hoverFrames` 判定）与 `tickFlyPhase()`；悬停期不位移且重力不接管（behavior 仍是 fly，不会掉下去）；`syncFrameSet` / `activeFrames()` 按相位选帧集。
- ⚠️ 未用 `next` 链乒乓实现：`advanceAfterAction` 有 `chainDepth < 8` 上限，来回切会中途被打断，且时长无法随机。

### 新增：贴顶飞对齐旧桌宠
- 对拍 Shimeji 的 `HoldOntoCeiling`（抓稳静止）与 `ClimbAlongCeiling`（贴顶移动）：两者同频次、贴顶期间随机反复选中 → 是「走走停停」而非一次爬到底。现已按同一套移动/悬停相位交替，抓稳时静止并回正倾斜。
- 目标点改为屏幕内随机（距两侧 ≥64px，对齐旧桌宠 `left+64+random*(width-128)`），不再是固定往返屏幕两端；离当前过近时改去对侧，避免抖动。
- 未配 `hoverFrames` 的角色走原路径，行为完全不变。

### 修复：不在地上的角色退场时悬空消失
- 之前攀爬/贴顶/飞行中被删除或关程序，消失动画会演在半空/墙面上。现为先掉回地面再演「爆烟变身飞走」。
- ⚠️ 落地等待期不能置 `isRemoving`（会跳过物理导致永远落不了地），故新增 `removePending` + 公开 `isLeaving()`，调度与命中判定统一改用 `isLeaving()`，避免半空中的角色被二次删除直接从舞台抹掉。
- 顺带修退出兜底超时写死 2500ms 的问题（bye 2400ms + 淡出 300ms 的尾巴本就被截断），改为按实际预算动态计算。

## [5.3.0] - 2026-09-18

> 本版重点：**新增「配对动作」合体机制**（邻近概率触发 + 右键菜单手动触发）、修复合体后原地卡死与背对背、合体前先落地、合体左右位随实际位置、食物类别按角色区分、菜单整理。自检：renderer+main tsc 0 错；verify-actions 99 动作 0 失败（唯一告警为 nina/plantCarrot 画布尺寸，不阻塞）。

### 新增：配对动作（另一种「合体」）
- 机制：`MeetRule.pair = { self, other }`，规则持有者演 `self`、对方演 `other`，两人都可见、各自独立播不同动作，先走近再面对面。复用既有 approach + maintainSnap 框架，零新增美术资源。
- 四条配对：`nina↔mona`（妮娜吃 / 莫娜做奶冻）、`mona↔rose`（一起唱）、`mona↔gwen`（莫娜做雪花冰沙 / 格温吃）、`mona↔rebeza`（莫娜做葡萄酒 / 雷贝莎吃）。规则统一收口到 `mona.meetRules`（一对角色只挂一处，避免掷骰两次概率翻倍）。
- 邻近概率触发：`rollMeet` 放宽门槛——有 pair 即触发，不要求双方有 `interactAction`（故莫娜无 interactAction 也能参与）。

### 新增：配对动作手动触发（右键菜单）
- 动作文件加 `pairTrigger:true` + `pairWith:"<搭档id>"`；`app.ts` `PET_MENU_ACTION` 加分支走 `startPairedMeet`（与 rollMeet 的 pair 分支等价，复用 ticker 到位的 `triggerPairedAction`）。
- 配对触发动作收入二级栏「合体」（动作级 `menuGroup:"合体"` + 角色配置 `actionGroups.合体{label,order}`），右键角色→「合体」悬停展开 flyout 选具体搭档。

### 修复：合体后两人原地卡死（P0）
- 根因：配对动作（eat/sing/cookMilk）均为 `durationMs:0` 的 static，靠 `animDone`→`advanceAfterAction` 收尾；`setAction` 不清 `meetPhase`/`meetPartner`，动作播完人回 idle 但 `meetPhase` 仍 `interacting`，下一帧 update 门控把 wander 永久卡死。
- 修复：`advanceAfterAction` 顶部补「自然收尾释放相遇占用」（幂等）；`isInteracting()` 增 `|| meetPhase==='interacting'` 让 `maintainSnap` 维持脸对脸。

### 修复：合体背对背（P0）
- 根因：`maintainSnap` 把 `a` 永远钉左、`b` 永远钉右，而 `a/b` 来自 ticker 数组顺序、与屏幕实际左右无关；走近阶段自然在右的角色被强制换到左侧 → 背对背（非对称，只特定配对看似正常）。
- 修复：落位时按两人当前 x 坐标判定谁左谁右，natural-left 留左、natural-right 留右，朝向随之翻转。

### 修复：合体前先落地（防空中/攀爬中触发）
- 根因：菜单合体入口只对「被右键那只」做落地闸门，搭档在空中/攀爬时没拦，两人会在半空触发动作。
- 修复：新增 `Pet.isAirborne()`（攀爬/贴顶/飞行/drag 或 y 高于地面；不用 isGroundBound 以免误判走路中角色）与 `startMeetAfterLanding(a,b,cb)`（等双方都落地再启动）；覆盖手动 coop、手动 pair、自动 rollMeet 三处入口。

### 改进：食物类别按角色区分
- `mona↔gwen` 莫娜做 `cookIce`（雪花冰沙）、`mona↔rebeza` 莫娜做 `cookWine`（葡萄酒）；`nina↔mona` 仍奶冻。菜品由莫娜 cook 帧决定，无需新增美术。

### 整理：菜单
- 所有角色「消失（bye）」移出右键菜单（`menu:false`；退场动画仍由 `removeAction` 引用，不受影响）。
- 莫娜主菜单「唱歌」置「吃东西」前（`menuOrder` 19）；合体子菜单「和露丝一起唱歌」置顶。
- 删除合体条目上冗余的 `menuOrder`（900/901/902/903），按 JSON 书写顺序排，结果一致。

## [5.2.0] - 2026-09-17

> 本版重点：新增角色**莫娜（Mona）**并同步一轮体验修复。数据驱动，不碰代码即可增改动作。自检：renderer+main tsc 0 错；verify-actions 95 动作 0 失败（唯一告警为 nina/plantCarrot 画布尺寸，不阻塞）。

### 新增：角色 莫娜（Mona）
- 数据驱动接入：assets/mona/ + config/images/mona.json + config/actions/mona.json（24 个动作）+ config/characters/mona.json + config/config.json 角色列表。
- 钓鱼 5 分支（鱿鱼/章鱼/温泉/巨骨/海草）：公共基础段 L-fishing-1~7 + 各渔获 3 帧拼接；末帧按图片字节数判定是否复用复位帧。
- 做饭 5 分支（冰沙/面包/肉/奶冻/葡萄酒）：视觉为「共享烹饪段 + 各自成品帧」。
- sing / eat / sit / creep / walk / fly 等常规动作齐备；空中 fall 为 fall-1/fall-2 两帧循环。
- wander 随机池已含全部 5 钓鱼 + 5 做饭分支，权重统一 1（walk 权重同步提到 21，占比保持 50%）。

### 修复：开场掉落（召唤角色）
- 之前落地直接收尾把你要的弹跳也干掉了；现为「开场缓冲期」：保留弹跳约 2 下，仅压制摔倒/落地动画，被鼠标接管后恢复正常摔倒判定。

### 修复：拖拽摇晃帧反向（mona）
- 经像素倾斜检测，莫娜 L 帧约定与妮娜一致、R 帧应为自然序；修正 drag.rightFrames 为自然序（R-swing-1/2/3）。

### 规范化：摔倒动作全员对齐妮娜
- tripping 统一为纯字符串帧（fall-2/3/4）+ frameMs 800 + durationMs 1500；gwen 仅 fall-1~3 故保持 2 帧且 fall-2 单独 300ms。

### 清理 / 工程
- 移除 actionGroups 死字段 `icon`（无任何渲染代码读取）。
- 新增 `scripts/format-actions.mjs` 统一 actions 配置格式（帧对象一行、短数组内联，带数据一致性闸门，幂等）。
- 新增台词按帧触发能力（`dialogueFrame` 正负索引 + `dialogueHoldMs`），默认不启用、零开销。

### 修复：右键菜单「边缘攀爬」手动触发无效
- 根因：菜单路径走 `startAction` 只做 `setAction` + `scheduleActionEnd`，漏了 `requestAction` 里那套攀爬初始化（`pickClimbTarget` 吸附屏幕边缘 + 设上下折返目标），导致点菜单后 `targetPos` 陈旧 → `stepClimb` 判定 `dy≈0` 在地面 → 当场 `finishClimbOnGround` 结束会话，观感"点了没反应"。影响全部 5 角色（均为 `menu:true` 的 `climb` 行为动作）。
- 修复：位移类目标点初始化抽成私有 `setupPositionalTarget(id)`，`startAction` 与 `requestAction` 共用；菜单点 climb 额外 `climbSessionActive=false`（手动 = 新会话，重置 20s 计时）。顺带补了菜单 fly / flyCeiling 同样漏目标点初始化的潜在隐患。自动攀爬路径零改动。

### 改进：合体收尾站位（rose↔nina）A+B 架构重构
- 根因：旧公式用 `lead.x + size.width(150) + coopEndGap` 按「整张画布边缘」算间距，把两人身体之间的透明留白全算进去 → 实际身体被隔开约 200px，纯水平偏移补不齐（图片有左右占位差异）。
- B（按身体边缘定位）：新增角色字段 `coopBodyInsetX`（身体左缘在画布里的偏移，实测 rose=24 / nina=26），`endCoop` 改为按「身体内缘 + coopEndGap」反解配角坐标；朝向翻转后左缘映射到内缘，故每角色一个值即可。
- A（终位 2D 微调）：`coopEndShiftX` 标量升级为 `coopEndShift:{x?,y?}`，且改为**每角色各自独立**携带——lead 与配角各按自己的值平移、互不牵连（配角基准点用 lead 原始 x 算，两人偏移量独立可调）。
- 调参：rose/nina 现各设 `coopEndShift:{x:-50}`（比最初 -30 再左移 20px，修正两角色在右侧时偏右的观感）。间距由 `coopEndGap`（现 170）控制，分别移动幅度由各角色 `coopEndShift.x` 控制。新增 `scripts/measure-coop-inset.mjs` 可量任意角色身体左右偏移。
- 类型/归一化：`types.ts` 加 `coopBodyInsetX` / `coopEndShift`；`config.ts` 归一化白名单同步。

## [5.1.4] - 2026-09-13

> 本次聚焦两点：①定位并解释「合体收尾间距 `coopEndGap` 改了不生效」的根因（旧 release 副本不读该字段）；②新增贴顶飞行倾斜角。自检：renderer+main tsc 0 错；verify-actions 71 动作 0 失败（唯一告警仍 nina/plantCarrot 画布尺寸，不阻塞）。

- 定位：合体收尾 `coopEndGap` 调到 1 没变，是旧 5.1.3 便携版不读该字段所致；本版已编入新 `endCoop`，rose/nina `coopEndGap` 设为 1（间距 1px），改 release 自带 config 即生效、无需重编。
- 新增：贴顶飞行（flyMode='ceiling'）带倾斜角斜飞——上升段斜向升空、巡逻段按飞行方向倾斜、悬挂段与落体回正；新增角色字段 `ceilingTilt`（默认 0.22rad，0=竖直）。

### 说明：合体收尾间距 `coopEndGap` 改了「没变」的根因

用户把 `coopEndGap` 调到 1 但间距没变——并非代码或字段写错（`endCoop` 公式 `follow.x = lead.x + lead.bodyWidth() + coopEndGap` 算出来就是 1px 间隙，config 也正确归一化）。根因是**在跑 5.1.3 便携版**：该 exe 打包时这些改动尚未写入，其 `endCoop` 走旧逻辑（用 `interactGap` 算间距）且根本不读 `coopEndGap`。渲染进程通过 `fs.readFileSync` 实时读盘，故**dev 模式（`npm run dev`）改 config 即时生效**；要让便携版也生效，必须重编发版（即本版）。

随本版附带：`rose.json` / `nina.json` 的 `coopEndGap` 已设为 `1`（间距 1px）。后续若要再微调，直接编辑 `release/DeskPet-Portable-5.1.4/config/characters/*.json` 的 `coopEndGap` 重启即可，无需重编。

### 新增：贴顶飞行（flyMode='ceiling'）带倾斜角斜飞

用户希望角色触发贴顶飞行后「不是竖直升空，而是有倾斜角飞」。

改动：
- 上升段（阶段1）由纯竖直改为**斜向上升**：每帧附带水平分量（`ceilingDir * speed*0.7`），并按飞行方向对角色整体施加倾斜角，视觉上呈「斜着起飞」。
- 贴顶巡逻段（阶段2b）按当前飞行方向倾斜（向右飞→顺时针倾、向左飞→逆时针倾），到一端折返时倾斜角随之反向。
- 到顶悬挂段（阶段2a）回正（不倾斜），结束时（`dropFromCeiling`）复位倾斜角，落体恢复竖直。
- 新增角色字段 `ceilingTilt`（rad，可选，缺省 `0.22`≈12.6°）：`0` 即完全竖直不倾斜；想更斜就调大。
- 复用既有 `tiltNode`（绕角色中心旋转）承载倾斜；并让 `updateDragTilt` 在贴顶飞行期间不复位该角度，避免每帧归零抖动。

影响面：仅作用于 `flyMode='ceiling'` 的飞行姿态；普通下落/攀爬/拖拽倾斜逻辑不受影响。

## [5.1.5] - 2026-09-13

> 本版重点：**对话气泡（SpeechBubble）全面重构为「左中右三段式」并修复「配置改了不生效」的 P0 根因**（config 归一化白名单漏透传 `textOffsetX/Y`）**，四角色对话框比例一致、文字居中、可微调偏移。另含合体收尾站位真因修复、全局相遇距离统一。自检：renderer+main tsc 0 错；verify-actions 71 动作 0 失败（唯一告警仍 nina/plantCarrot 画布尺寸，不阻塞）。

### 重构：对话气泡改为「左中右」三段式拼接（弃用九宫格）

九宫格（NineSliceSprite）方案反复出现「只剩左上角碎片 / 竖直上呲 / 角部装饰扭曲」且调参极不稳定。改为 3 个 `PIXI.Sprite` 水平拼接：
- `bgLeft`（含左上角装饰，固定宽 `leftWidth×scale`）/ `bgMid`（源图中间段，水平拉伸到「文本宽+padding」）/ `bgRight`（圆角收尾）。
- **整张图等比缩放**（高度 = 中段显示宽 × 源高/源中段宽），不做上下切片，杜绝竖直拉伸变形；文本永远居中于中段。
- 纹理缺失/加载失败回退白底圆角矩形（同样读 `minWidth`）。

### 修复：对话框「配置改了不生效」的根因（P0）

用户反复调 `bubble.textOffsetY`（0→-2→-10→-50）文字一直不动，`Ctrl+R` 也不变——并非操作问题，是代码 bug。
- **真因**：`src/renderer/config.ts` 的 `normalizeBubble()` 是**白名单透传**，只列了 `frameName/leftWidth/rightWidth/topHeight/bottomHeight/scale/fontSize/textColor/paddingX/paddingY/maxTextWidth/minWidth/minHeight`，**漏掉 `textOffsetX` 与 `textOffsetY`**。`normalizeCharacter()` 调 `normalizeBubble(c.bubble)` 时这两个字段被静默丢弃，`SpeechBubble` 永远取 `show()` 里的默认值 → 改多少都没反应。`textColor/minWidth/scale` 在白名单内故生效，恰好解释「黑字/框变大生效、偏移不生效」的矛盾。
- **修**：`normalizeBubble()` 末尾补两行 `textOffsetX/textOffsetY`（`typeof number` 透传）。这是**配置字段新增后必须同步加进对应 `normalizeXxx()` 白名单**的硬教训，否则会被静默丢弃且极难发现。

### 数据：四角色对话框配置最终态（一致）

- 四角色 `bubble`：`bubbleOffset: 0.15`（贴近头顶）、`bubbleOffsetX: 0.5`（向右偏半身位）、`textOffsetX: 0 / textOffsetY: -2`（文字上移 2px 居中补偿）、`leftWidth: 35 / rightWidth: 25 / scale: 0.4`、`paddingX: 14 / paddingY: 8 / maxTextWidth: 120 / minWidth: 120`（短文本框最小宽度，避免压成一条）。
- 文字色：rose 深灰 `2236962`；nina/gwen 黑 `0`；rebeza 默认白 `0xffffff`。

### 修复：合体结束后站位仍远的真因

`endCoop()` 用 `lead.bodyWidth()` 算 follow 位置，但 `setAction(idle)` 后贴图**异步加载**，`endCoop` 同步调用时 `bodyWidth()` 仍是**合体帧宽度**（含两人）→ follow 被摆到「合体帧右边缘+1px」视觉上远。改为 `lead.config.size.width`（设计宽度 150，稳定不依赖异步贴图），间距严格等于 `coopEndGap`。

### 变更：全局相遇触发距离统一

`config/config.json` 的 `meet.distance` 由 **200 改为 140**，与角色级 `meetRules` 一致，避免日志显示 200 造成误解。

## [5.1.3] - 2026-09-13

### 修复：角色触发摔倒（落地）时无法点击（穿透误杀）

症状：角色触发摔倒/被放下、刚落地那一刻，光标若正好压在它身上，点它点不中（点击穿透到桌面），必须移开光标再移回才恢复。

根因：`reconcile()` 末端的「释放保护」`freedPet`——角色刚结束下落（`prevHoveredFalling && !hoveredFalling`）即把它记为 `freedPet`，而捕获条件 `capture = blocked || (overPet && freedPet !== hovered)` 在 `freedPet === hovered` 时强制 `capture=false`（穿透）。该机制本是为「交互完桌面立即可点」而设，但与「角色任何时候都能被点击」直接冲突，且对**摔倒**（非用户主动交互）也误触发。

改动：
- 捕获条件改为 `capture = blocked || overPet`——只要光标压在任意角色上就捕获（可点），只有光标在空白桌面才穿透。
- 删除 `freedPet` / `prevBlocked` / `prevHoveredFalling` 整条释放保护状态机及其埋点字段（不再记忆任何「刚落地/刚释放」跨状态）。
- `hoveredFalling` 仅保留作监管埋点（`mouseThrough.transition` 溯源），不再参与捕获判定。

代价（可接受的取舍）：刚把角色放下、光标仍压在它身上时，其背后的桌面要等光标移开角色才恢复可点；换来「角色永远优先可点」，符合用户诉求。

### 改进：合体动作触发更近、结束后两人紧贴且面朝对方

以露丝↔妮娜（唯一有配对帧的合体对）为例，用户希望「合体」更贴合、衔接更顺：

- 触发距离：`config/characters/nina.json` 的 `meetRules.rose.distance` 由 `200` 降到 `140`——两宠仅在**贴近**时才掷骰触发合体，不再隔着一段距离就凑一起。
- 收尾站位/朝向：`Pet.endCoop()` 原来把配角摆到主演右侧 `leadW + 30`、两人都回 `defaultAction` 默认朝左 → 收尾瞬间**背对背 + 间距 30px**，割裂感强。
  - 间距改用角色可配的 `coopEndGap`（默认 `14`，比普通相遇 `interactGap` 更紧），两人紧贴并肩。
  - 显式让两人**面朝对方**：主演在左→`setFacing(true)` 朝右，配角在右→`setFacing(false)` 朝左（coop 约定 lead 在画面左，`triggerInteraction` 已据此选 lead）。`setAction(defaultAction)` 不重置朝向，故该朝向保留进待机。
- 新增角色字段 `coopEndGap`（`types.ts` + `config.ts` 归一化，可选，缺省 14），方便后续按角色微调合体收尾间距。

影响面：改动只作用于 coop 收尾与 rose-nina 这一对的触发阈值，普通相遇（双方各演 interact）的 `maintainSnap`/`interactGap` 不动；rebeza/gwen 不写 `interactAction`，不参与相遇。

## [5.1.3] - 2026-09-13

- 修复：启动约 1 秒「纯色方块在掉」——构造时 body 不可见，美术加载完才显示
- 修复：边缘攀爬时右键瞬移回地面——菜单中冻结不换位置，选地面动作先掉地再衔接
- 修复：贴顶飞行飞一半就掉——改 ceilingMaxMs 计时（默认 20s），贴上缘后才巡逻
- 变更：随机动作池「乱飞」换成「贴顶飞行」
- 功能：应用内「检查更新」+ 前端下载落地页（告别每次私发包）

> 本段为 2026-09-13 的 4 项行为修复（启动方块 / 右键攀爬 / 贴顶飞行 / 随机池换动作）+ 应用内检查更新功能。
> 自检：`tsc` renderer+main 0 错；`verify-actions` 71 动作 0 失败（唯一告警仍是既有 nina/plantCarrot 画布尺寸，不阻塞）；
> `tune-action-durations` 问题 0 / 警告 0；`sim-ceiling-fly.mjs` 2000 次/场景仿真全部先贴上缘再掉、贴顶时长恒在 50%~100%×`ceilingMaxMs` 内。

### 修复：开局约 1 秒「几块纯色圆角方块在掉」

症状：软件启动、角色刚出现那 1 秒，屏幕上有几个不是角色的纯色方块往下掉。

根因：`Pet.createBodyTexture()` 用 `PIXI.Graphics.roundRect` 填 `colors.body` 生成**占位贴图**，构造时（`Pet.ts` 构造）就挂到 body 上；真帧要等 `setAction()` 里 `resolver.loadFrames()` 的异步 `Promise.all` 回来才替换（`syncFrameSet` 在加载完成前把 `actionTextures` 回退成 `[bodyTex]`）。`spawnDrop` 又恰好让角色从屏顶往下落 → 你看到的就是「几块方块在掉」。

- 构造时 `this.body.visible = false`；`applyTexture()` 里改为 `this.body.visible = this.artResolved`，`artResolved` 仅在帧集加载 Promise 出结果后置 `true`。
- 美术缺失（tex 仍是占位）也照常显示 → 保留「美术缺失」的可诊断性，不会变成隐形 bug。

### 修复：边缘攀爬时右键会把角色瞬移回地面（应右键时不动，选地面动作先掉地再衔接）

症状：角色在沿屏幕边框爬墙时右键 → 直接刷新回地面；应「右键时原地不动」，选了地面动作再先掉到地上、然后衔接该动作。

根因：`contextMenu.show()` 第一行调 `standStill()`，而旧 `standStill()` 末尾无条件 `settleToBaselineIfGround()`（`container.y = baselineY()`），不管人当时在墙上还是半空 → 直接拍回地面。

改动：
- 新增 `menuHold` 门控 `update()` 主循环：菜单开着时**只推进帧动画，不跑行为/不跑物理/不接续 `next`**（放在 `pendingAdvance` 兜底与行为分发之前）。
- `standStill()` 分两种：**在地面**（动作可落地 + 已贴下沿 + 无残余速度）→ 保持现状、切站立帧；**在墙/贴顶/飞行/空中** → 只冻结（`menuHold = true`），**不换动作也不改位置**。
- 菜单选了「地面类」动作而人不在地面 → `queueOnLandAndDrop()`：切 `fall`、给一点离边初速、`blockClimb()`，落地那一刻（`stepPhysics` 落地分支）先执行待办动作（确定性优先，不做摔倒/弹跳）。
- 菜单没选动作就关掉 → `resumeAfterMenu()` 解除 `menuHold`，攀爬从原位置继续（符合「右键只是暂停了一下」）。

### 修复：贴顶飞行飞到一定高度就自动掉落（应贴住上缘左右飞一段再掉，最長 20s）

症状：触发「贴顶飞行」后，所有角色飞到屏幕一半高度就掉下来，没贴上缘。

根因：`flyCeiling` 在四份 `actions/*.json` 里都写死 `durationMs: 5000` 收尾，而上升速度 `moveSpeed 1.5` ≈ 90px/s、1080p 从地面升到顶要约 10s → 定时器 5s 先到期 → 「飞到一半就掉」。（对照仿真：旧配置在大屏 0/300 到顶。）

改动（照抄攀爬已验证的会话模型）：
- 新增角色级 `ceilingMaxMs`（默认 **20000**），**只在贴上缘那一刻起算**（上升段不计入）。
- 实际巡逻预算 = `ceilingMaxMs` 的 `[50%,100%]` 随机（每次不同，又不超过上限）。
- `flyCeiling` 动作级 `durationMs` 改为 **0**（不挂定时器）；`hasSelfTermination('fly')` 已为 true，不会触发「缺 durationMs」回退告警。
- `stepFlyCeiling` 重写：阶段1 垂直升到顶（带 `CEILING_RISE_MAX_MS` 安全兜底，异常直接掉）→ 阶段2a 到顶悬挂 500~1500ms（对应 Shimeji GrabCeiling）→ 阶段2b 贴顶左右往返，撑满预算后 `dropFromCeiling()`（切 `fall` + 开攀爬冷却，防从两端下落被「撞边抓墙」抓回）。
- `moveSpeed` 1.5 → **3**（升到顶更快，避免小幅屏要等太久）。
- 攀爬到期起飞（`flyAction`）一并改用 `flyCeiling`：人本来就在高处，起飞后直接贴上缘巡逻，也契合「自动触发」取向。

### 变更：随机动作池里的「乱飞」换成「贴顶飞行」

- 四只角色的 `wanderActions` 均加入 `{"id":"flyCeiling","weight":1}`（nina 原 `{"id":"fly","weight":1}` 直接替换为 `flyCeiling`）。
- 四只角色 `flyAction` 均由 `fly` 改为 `flyCeiling`（自动触发出口：攀爬到 `climbMaxMs` 起飞即贴顶飞）。
- 体检确认四角色 walk 权重占比维持 **50%**（rose 14/28、nina 17/34、rebeza 15/30、gwen 13/26），`flyCeiling` 靠 `ceilingMaxMs` 计时、不占 `durationMs` 预算。

### 功能：应用内「检查更新」+ 前端下载落地页（告别每次私发包）

痛点：私下传播每次都要重新打包 + 挨个发文件，太麻烦。

方案（已确认：仅提示+下载页 / GitHub Releases / 用户下载落地页）：

- **应用内检查更新（方案 A：只提示+跳下载页，不自动下载/替换，零签名也能跑）**
  - 主进程 `ipcMain.handle('check-update')`：用 **Node `fetch`** 拉 `version.json`，与 `app.getVersion()` 做语义化版本比较（在主进程拉，不受渲染层 CORS 限制）。
  - 主进程 `ipcMain.handle('open-external')`：`shell.openExternal` 用系统浏览器打开下载页/下载地址。
  - 渲染层 `updater.ts` + `config.loadUpdateConfig`：读 `config.json` 顶层 `update` 块（`checkUrl` / `autoCheck` / `channel`）。
  - 角色管理面板（系统托盘「角色管理面板」）新增「检查更新」按钮 + 结果区：已是最新 / 发现新版本（含更新日志 + 「前往下载」按钮）/ 失败提示（含配置指引）。
  - 启动静默自动检查（`autoCheck` 默认 true）：发现新版本即记住，打开面板直接展示，免去手动点。
- **前端下载落地页** `web/index.html`（自包含静态页，适合挂 GitHub Pages）：展示最新版本号 / 发布日期 / 更新日志 / 一键下载；读 `version.json`（`?src=` 可覆盖地址），fetch 失败优雅提示；每 60s 自动刷新。
- **版本清单生成** `scripts/gen-version-json.mjs`：读 `package.json` 版本 + `CHANGELOG.md` 顶部小节要点，结合 `--owner/--repo`（或 `.release-meta.json`）生成 `version.json` 与 `web/version.json`（含 `downloadUrl`/`pageUrl`）。发版一条命令产出清单。

用户侧接入（一次性）：①建 GitHub 仓库，把 `version.json` 提交到分支（checkUrl 指向 `raw.githubusercontent.com/<owner>/<repo>/<branch>/version.json`）；②把 `web/` 挂 GitHub Pages（`OWNER.github.io/REPO/`）作下载落地页；③每次发版：`bump` → `repack` → 压缩 release 目录为 `DeskPet-Portable-<v>.zip` 传 GitHub Releases → `node scripts/gen-version-json.mjs --owner X --repo Y` 重新生成清单并提交。用户从此访问同一链接永远拿最新，或在桌宠里点「检查更新」。

注意：应用内只「提示 + 跳下载页」，不静默替换正在运行的便携 exe（方案 A）；要全自动静默更新需另接 electron-updater（风险更高，本期未做）。

## [5.1.2] - 2026-09-12

### 修复：鼠标明明停在角色身上却「点不中」（穿透被别的角色落地打掉）

症状：光标停在某只角色身上，点击却穿透到桌面（抓不起来）；**光标不动就一直点不中，必须移开再移回才恢复**。受害者总是「当时正好在光标下」的那只——与角色本身配置无关，四只角色轮流起飞/落地/攀爬时最容易复现。

根因（`app.ts` 的穿透状态机）：

1. 释放保护用的「刚被放开」判据取的是 `Pet.getAll().some(p => p.isFalling())` —— **任意**角色在下落；
2. 于是**别的**角色一落地，`prevFalling && !falling` 成立 → `justFreed = true`；
3. `capture = blocked || (overPet && !justFreed)` → 窗口被切回穿透 → 点击落到桌面；
4. `justFreed` 只在「光标离开**所有**角色」时清零 → 光标不动**不会自愈**，必须移开再移回。

- **释放保护绑定到具体角色**：`justFreed: boolean` → `freedPet: Pet | null`，`prevFalling` → `prevHoveredFalling`（只关心「光标下这只」上一帧是否在下落）。角色变更即失效，语义从此是「**这只**角色刚落地/刚被放下」。
- 埋点 `mouseThrough.transition` 增加 `hoveredFalling` / `freedPet` 字段，便于溯源。

### 修复：点击命中的优先级与渲染层相反（点到的是「最下层」角色）

`Pet.petAt()` 原来**正序**扫描 `allInstances`，而该数组顺序 = stage 子节点顺序，**越靠后画得越靠上**。于是角色重叠时命中的是最下层那只，与 Pixi 拖拽派发的「命中最上层」不一致——受害者为最后加入的 gwen。

- 改为**倒序扫描**，并显式跳过 `!visible`（合体隐身的配角不再占命中区）。

### 数据：gwen `work` 动作 4 帧补透明边，画布统一 180x150

`work` 的 12 帧里有 4 帧（`L/R-work-1..2`）画布是 150x150，其余是 180x150 → 播放时**鼠标命中框随帧在 150↔180 之间跳变**（角色本身没移动，只是命中框左右各缩/扩 15px）。

- 用 `scripts/repad-frame.mjs --left 15 --right 15 --write` 给这 4 帧左右各补 15px **全透明**边：画布统一为 180x150，**可见像素零改动**（左右等量补边 ⇒ 角色在屏幕上零位移）。
- 新增 `scripts/diag-hitbox.mjs`：逐动作/逐帧给出「命中框 / 可见内容 bbox / 左右死区」，用于量化这类问题。
- `scripts/verify-actions.mjs` 新增告警：同一动作内画布或显示尺寸不统一时提示（不阻塞退出码，仅提示按 §3.6 补边）。当前唯一告警为 `nina/plantCarrot`（既有，未动其美术）。

### 文档

- `ARCHITECTURE.md`：脚本工具表更新（补 `diag-hitbox` / `repad-frame` / `tune-action-durations` / `sim-climb-walltop`）；新增「穿透唯一真相源 = `app.ts reconcile`」说明；「已知边界」补 4 条（命中框 = 画布盒含留白 / 命中优先级必须等于渲染 z 序 / 释放保护必须绑定具体角色 / 监管面板打开时任何角色都点不中）。
- `docs/扩展指南-加角色与动作.md`：字段速查补 `width` / `height`（标注「显示尺寸 = 鼠标命中框」）；新增 §3.6「同一动作的帧，画布尺寸要统一」；修正「6 种 behavior」等过时表述。

### 变更：边缘攀爬改为「爬上爬下」巡逻，到 20s 才下墙（掉落 / 起飞）

攀爬不再「到顶就掉下来」，而是像 Shimeji 那样在屏幕边框上**上下折返巡逻**，撑满 `climbMaxMs`（**20000ms**）后才离墙。

**下爬怎么做的**：美术只有 3 帧上爬帧（`L/R-climb-1..3`），但帧本身是**方向无关**的「握紧 → 发力」循环，因此下爬**复用同一套帧、只把位移符号取反**，无需任何新美术。将来若补了独立下爬帧，只需加 `climbDownAction: "xxx"`（不改代码）。

- 新增 `pickClimbTarget()`：顶/底**半个身位**内强制折返，墙中段按 `climbTurnChance`（默认 **0.35**）随机折返 → 形成爬上爬下；
  巡逻下沿留 `CLIMB_EDGE_GAP_PX`（40px）不落到地面（否则会被判成「已到地面」提前结束），单腿最小跨度 `CLIMB_LEG_MIN_PX`（120px）防原地抖动。
- 新增 `endClimbSession()`（唯一的主动出口）：到期后按 `climbEndFlyChance`（默认 **0.5**）**触发飞行动作**（`flyAction`，默认 `fly`），否则松手掉落；
  已在下沿一人身位内则直接 `finishClimbOnGround()` 落地朝屏幕内侧走（从地面高度「掉落」没有意义）。
- **移除 `climbDropChance`**（挂壁后随机掉落）：与「到最大时间才下来」的诉求矛盾；字段与 `pendingClimbDrop` 状态一并删除。
- **消除竞态**：climb 动作自身的 `durationMs` 20000 → **25000**（`DISPLACEMENT_FALLBACK.climb` 同步）。
  两者若同为 20000 会在同一时刻到期，随机绕过「起飞」出口 —— 动作级时长只做异常兜底，会话逻辑才是唯一决策者。
- **防止「永远在爬、从不落地」**：`blockClimb(minMs?)` 支持延长冷却 —— 起飞出口传「飞行时长 + 1500」，
  否则飞行结束转 idle 下落时若人仍在边缘，会被 `stepPhysics` 的「下落撞边 → 抓墙」立刻抓回（仿真复现：20s 爬 → 5s 飞 → 立即再爬）；
  落地分支同时续期冷却，使 `climbCooldownMs` 的文档语义（「从墙上下来后的一段时间内不再触发攀爬」）真正成立。
- 「爬到顶转贴顶爬」保留（`ceilingChance`），但搬进新 helper `maybeEnterCeilingAtTop()` 且**只从 `stepClimb` 调用** ——
  原先若在 `pickClimbTarget()` 里调，会形成「requestAction 内嵌套 requestAction」。
- 新增监管埋点 `climb.end`（cause=timeout，`after.action` = fall / fly），便于溯源攀爬出口。
- 新增角色级配置：`climbTurnChance` / `climbEndFlyChance` / `climbDownAction` / `flyAction`；四个角色配置已显式写出。

仿真（`scripts/sim-climb-walltop.mjs` 重写为巡逻模型，3000 次/模式）：

| | 到落地全程 | 攀爬会话时长 | 腿数（上/下） | 单腿最长 | 卡死 |
|---|---|---|---|---|---|
| 修复前 | 500s（上限内从未落地） | 393s | 2.1（2.1 / 0） | 286s | **3000/3000** |
| 修复后 | 均值 22.8s / 最长 25.8s | 均值 **20.0s** | 6.0（4.3 / **1.7**） | 13.4s | **0** |

出口计数：掉落 1421 / 起飞 1365 / 沿墙落地 214。

### 修复：爬到墙顶后「卡住不动」—— 攀爬冷却漏了第三处入口，形成 climb↔fall 死循环

上一版给攀爬加了「松手掉落 + 冷却」，但冷却只在 `stepStatic` 与 `app.ts` 两处检查，
**`stepPhysics` 的「下落中撞到左右边框 → 自动抓墙」漏检**。于是出现如下闭环：

1. `stepClimb` 到顶 → `dropFromWall()` → 切 `fall`、`blockClimb()`；
2. 下一帧 `stepPhysics`：`airborne && atScreenEdge(6)` 成立（攀爬时 x = `-edgeMargin` / `W-w+edgeMargin`）→ **无视冷却**直接 `requestAction(climb)`；
3. 此时 `prevId` 是 `fall`，`prevId !== id` 成立 → **`climbStartMs` 被重置**，`climbMaxMs`(8s) 兜底永远不生效；
4. 回到第 1 步。角色在最顶端每帧一次 `climb↔fall` 抖动，肉眼就是「爬到最上面卡住了」。

- **攀爬冷却收敛为唯一收口**：`requestAction()` 内新增 `if (def.behavior === 'climb' && this.actionId !== id && this.isClimbBlocked()) return;`
  （必须在 `setAction` 之前返回，否则会把动作切过去又什么都不做）。所有入口——含 `stepPhysics` 和将来新增的——自动受约束。
- `stepPhysics` 的「下落撞边抓墙」补上显式 `!this.isClimbBlocked()` 判断（防御性，双保险）。
- 新增 `climbSessionActive` 语义：**攀爬会话 = 进入 climb → 掉落到落地为止**。
  `climbStartMs` 只在「新会话」重置，掉落再被抓住不再重置 —— 让 `climbMaxMs` 成为真正的硬保证。
  会话结束点：落地 / `finishClimbOnGround` / 动作收尾 / 拖拽抓取 / 右键菜单动作 / 退场。
- `dropFromWall()` 松手时朝屏幕内侧给水平初速（`CLIMB_DROP_VX = 2.5`）：否则落点仍在边缘区，
  冷却一结束就被 `stepStatic` 判「贴边」重新爬上同一面墙（表现为「每次都在同一侧反复上墙」）。
- `stepWalk` 撞墙分支：冷却期内不能上墙时改为**把目标点改到屏幕内侧**，否则会在墙边「动画在播但人不位移」地原地踏步。
- `stepCeiling` 的掉落出口统一改走 `dropFromWall()`，消除第二条会漏冷却的掉落实现（当前无 `ceiling` 动作，属预防）。

仿真（`scripts/sim-climb-walltop.mjs`，2000 次，忠实复现 stepClimb↔stepPhysics 交互）：
**修复前 2000/2000 无法落地（1000s 上限内平均掉落 18691 次）；修复后平均 7.6s、最长 8.7s 落地，掉落 1 次，卡死 0。**

### 修复：攀爬到顶后「下不来」，长期挂在墙上

四个角色都没有 `ceilingAction`，而 `stepClimb` 到达目标后的唯一出口是重新 `requestAction(climb)`；
`requestAction(climb)` 在 `currentY > 80` 时目标点**恒落在角色上方**（值域 `[0, currentY-80]`），
只有贴顶（`<=80`）才可能选向下；而「回到地面」的判据要求目标恰好落在 `baselineY-8` 附近（约 2px 窗口，命中率 ~1%）。
三者叠加 → 角色在墙上无限上下爬，只能等 `durationMs: 20000` 兜底被硬拉回地面（中途还会瞬时归位，观感突兀）。
更糟的是落地时人仍在屏幕边缘区，`app.ts` 的「撞边 → climb」和 `stepStatic` 的「贴边 → climb」会立刻把它再抓回墙上。

- `stepClimb` 新增两个「下来」出口：**到顶（无 ceiling）→ 松手掉落**；**到达下沿 → 落地**（`finishClimbOnGround`，落地后朝屏幕内侧走）。
- 新增 `dropFromWall()`：切 `fall` 帧交给物理接管，取代「倒放上爬帧往下爬」的怪观感（美术没有下爬帧）。
- 新增 `climbMaxMs`（默认 **8000**）：单次攀爬最长持续时长，超时自动松手掉落 —— 保证「爬上去 → 待一会儿 → 下来」是有限循环。
- 新增 `climbDropChance`（默认 **0.5**）：每次挂壁停留结束后松手掉落的概率，避免每次都爬满全程。
- 新增 `climbCooldownMs`（默认 **3000**）+ `Pet.isClimbBlocked()`：攀爬结束后一段时间内，`app.ts` 与 `stepStatic` 都不再触发攀爬，
  否则「刚落地人还在边缘 → 立刻又贴边 → 又爬」会表现为粘在墙上。
- 仿真（3000 次/角色）：修复前平均 20s、最长 114–151s 才下来；修复后**平均 7.0s、最长 8.0s（即 climbMaxMs 上限），卡死 0 次**。

### 新增：wander 抽样的「防重复」参数全部外置为角色配置

原先 `pickWanderAction` 的防重复规则（记忆 3 个动作、排除最近 1 个、其余降权到 0.2）硬编码在 `Pet.ts`，配置里改不动。
现全部改为角色级配置（默认值 = 原行为，向后兼容）：

| 字段 | 默认 | 作用 |
|---|---|---|
| `wanderRecentSize` | 3 | 记忆最近 N 个抽到的动作 |
| `wanderRecentExclude` | 1 | 最近的 N 个直接从候选池排除 |
| `wanderRecentPenalty` | 0.2 | 仍在记忆里的动作权重乘数（1 = 不降权） |
| `wanderRecentExempt` | — | **豁免名单**：名单内动作不受防重复压制 |

- 权重本身一直就在配置里（`wanderActions: [{id, weight}]`）。真正卡住「walk 占一半」的是防重复机制：
  配置 walk 权重 50% 时实测抽样频率只有约 26%（上一次是 walk 就被排除）。
- 四个角色加 `"wanderRecentExempt": ["walk"]` 后，实测抽样频率回到 **54.8%–58.4%**（20 万次仿真）。


### 修复：sit（坐下）被抽中后永久卡住 —— `durationMs` 在 wander 路径上从未生效

`sit` 是唯一「单帧 + 只靠 `durationMs:2500` 结束」的自动漫游动作，但 `durationMs` **只在 `startAction()` 里**被转成结束定时器；
wander 池的动作走 `requestAction()` → `setAction()`，这条路径全程没人读 `durationMs`；
而 `stepStatic` 第二行 `if (actionId !== defaultAction) return;` 又断了它的一切自救路径 →
自动抽到 sit 后没有任何终止机制，会一直坐着，只能靠用户拖拽/右键打断。菜单手动点「坐下」走的是 `startAction`，所以一直正常 —— 这是「偶发」的来源。

- 新增 `scheduleActionEnd()` 作为**所有**设完动作路径的统一收尾调度，`startAction` / `requestAction` 都走它。
- 新增 `hasSelfTermination()` + `STATIC_HOLD_FALLBACK_MS(2500)` 防呆：单帧静止动作若漏写 `durationMs`，回退 2500ms 并 `console.warn` 提示补配置，避免新增动作再踩同一个坑。
- `startAction` 去掉残留的 `?? interactionDuration` 一刀切兜底，时长语义统一为：`>0` 到期收尾 / `===0` 外部事件或动画自身收尾 / `undefined` 见上。
- **顺带修复 `wanderMinDelayMs` 形同虚设**：`idleMs` 在非待机动作期间也一直在涨，导致回到待机时早已超过最小停留阈值 → 「上一个动作刚结束就无缝接下一个」。改为在 `setAction` 进入 `defaultAction` 时清零。
- 数据层：位移类兜底值必须大于「最坏一段正常位移」，否则会把爬到一半的角色硬切回站立 —— walk/creep 6000→**10000**（最坏 640px≈8.9s）、climb 7000→**20000**（一段最多爬满屏高）。
- 审计脚本新增**可达性门禁**：凡被 wander 抽到或被 `next` 引用的动作，必须显式声明终止条件（自终止行为 / `loop:false` / `loopCount` / `durationMs>0`），否则退出码 1。
- 手感调整（按用户要求）：四个角色的 `sit`（坐下）时长 2500→**5000ms**，坐下后保持 5 秒再起身；脚本常量 `SINGLE_FRAME_HOLD.sit` 同步更新，避免下次 `--apply` 被改回。
- 手感调整（按用户要求）：`walk` 在 `wanderActions` 里的权重占比提到 **50%**（rose 5→13、nina 5→17、rebeza 5→14、gwen 5→12，取值 = 其余动作权重之和）→ 走路成为骨架行为。
  - 审计脚本新增 **walk 权重门禁**（占比 < 50% 时退出码 1，防止后续新增动作把 walk 稀释）；屏幕时间占比上限改为两档：**位移类 60% / 静止类 40%**（walk 权重高是设计意图，不再被旧的一刀切 40% 误判）。
  - 注意：`pickWanderAction` 的防重复会系统性压制高权重动作 —— 配置 50% 对应的**实测抽样频率约 26%**（数学上限 50%，需 walk 权重远大于其余之和才有可能逼近）。如需实际也接近一半，应让 walk 豁免「最近一个排除」，而非继续加权重。

### 修复：位移/爬行/飞行偶发「移动方向与朝向相反」（倒着走、倒着飞）

根因是 `usingRightFrames`（当前是否用右朝向图集）被当成**独立缓存状态**，只在 `setAction` 里按「进入动作那一刻的朝向」算一次；
而所有运行时转向入口（`walkFacing` / `faceToward` / 抛出朝向）只改 `facingRight`、不更新它 →
一旦进入动作时朝右，整个动作期间就被锁死在右图集且不翻转，往左移动时表现为倒着走/倒着飞。
命中率 ≈ 进入动作时恰好朝右的概率，所以表现为偶发。4 个角色的 climb / fly / walk / creep 全是双套帧，全部受影响。

- `usingRightFrames` 改为 `facingRight` 的**派生量**（`syncFrameSet` 内实时计算：朝向 + 该动作有右套 + 右套已加载）。
- 新增 `setFacing()` 作为改朝向的唯一收口，统一刷新「字段 + 帧集 + 翻转」，并加 `facing.change` 埋点；禁止再直接赋值 `facingRight`。
- 修复 `faceToward()`（相遇/走近首帧朝向不刷新）与抛出朝向（`stepPhysics`）两处同类脱节。
- 右套尚未加载完时回退左套 + 镜像翻转，视觉方向仍正确，不会空白帧。
- 修复前 2×2 组合仿真：1/4 反向；修复后 0/4。

### 行为节奏治理：不再有过长 / 被切一半 / 单调重复的动作

调查了旧版 Shimeji（ニナ）的动作频率框架后做的三处治理，目标：桌宠行为节奏正常。

#### 代码层（Pet.ts）
- **轮末对齐**：限时动作的定时器到期时若动画仍在播，不再立即切断（原来会把 shakeHead 摇到一半定住），改为挂 `pendingAdvance`，等 `tickAnimation` 播到末帧/轮末再收尾；换动作即清零，并有 4s 超时兜底。用户主动打断（拖拽/右键/相遇/落地）仍即时响应。
- **wander 触发帧率无关**：每帧固定 1% → 指数分布 `1-e^(-dt/τ)`，新增 `wanderTauMs`（默认 1667，等价旧版 60fps 体感）。旧写法在 144Hz 屏上动作密度是 60Hz 的 2.4 倍。
- **wander 防重复**：记住最近 3 个动作，最近 1 个排除、前 2 个降权到 20%。3000 次仿真：零连续重复，最长连做 1 次。
- **walk 改局部游走**：目标点由「全屏随机」改为当前位置 ±`wanderRangePx`（默认 320）。旧逻辑平均要走 640px（≈9s），而限时只有 3.5s，几乎每次都「走到一半被切停」。
- **气泡时长修正**：`durationMs:0` 的语义是「播完即收尾」不等于 0 毫秒，新增 `estimateActionMs()` 按帧数×帧时长×轮数反推；否则相遇台词「妮娜！」会闪一下就消失。

#### 数据层（四个角色 71 个动作，脚本 `scripts/tune-action-durations.mjs`）
- 超长动作 `loopCount:2` → `1` 并压缩 `frameMs`：divination 20.8s→6.5s、sleep 16s→6s、plantFlower 16s→6s、headache 12.8s→6s、sing 14.4s→5.9s。
- 消除 `interactionDuration`(3500) 一刀切兜底：每个动作改为「播完一轮即收尾」或各自的合理时长；tripping 由 3500（躺 3 秒）改为角色级 `tripDurationMs`(1500)。
- 位移类只保留兜底定时器且**不加 loopCount**（加了会播完一轮 2 秒就站住）；idle/drag/fall 归为外部事件驱动，不设限时。
- 新增审计能力：脚本无 `--apply` 时为体检模式，检查「过长 / 无终止条件 / 轮末对齐最坏等待」并输出屏幕时间占比，有问题退出码 1。

> 以下 `[0.4.3]` ～ `[5.1.1]` 各节为 **2026-09-12 补记**：这些版本当时都已 `repack` 发出，但没同步写入本文件（本文件在 `[5.1.2]` 之前直接从 `[0.4.2]` 跳到最新版）。内容依据项目工作日志（`.workbuddy/memory/2026-09-0*.md`）+ 各 `release/DeskPet-Portable-*/` 目录的实际内容重建，非逐条原始记录。

## [5.1.1] - 2026-09-08

### 修复：切换朝向时精灵纹理滞后，导致偶发「倒着走 / 倒着飞」

根因是 `setAction` 把帧集赋值写进了 `SpriteResolver.loadFrames(...).then()`，而 `loadTexture` 走 `PIXI.Assets.load` **异步**；`facingRight` / `usingRightFrames` 却是同步改的。双套图下 `applyFacing` 的 `scale.x` 恒为 1，朝向完全由纹理决定 → 翻转朝向后纹理要滞后几帧才到 → 那几帧「画着旧朝向的图、却往新方向移动」。

- `setAction` 进动作时**并行预加载 L/R 两套帧集**（`Promise.all` + `loadToken` 防快速连切竞态），存 `texL` / `texR`。
- 新增 `syncFrameSet()`：按 `usingRightFrames` 瞬时切换已加载数组（右套未就绪则回退左套 + 镜像，避免空白帧）。
- `walkFacing` 双套分支改调 `syncFrameSet()`，**转向不再重置动画帧序**（附带消除走路抖动）。
- 单图角色（无 `rightFrames`）走 `texR = texL` 退化 + `scale.x` 翻转，行为不变。

> 误诊留档：期间一度判定为「gwen 美术 L/R 约定整反」并交换了 `frames` / `rightFrames`，被用户否掉后已全部回退。**像素启发式（肤色质心）判定美术朝向不可信**，以后须用「角色位移方向 vs 实际显示帧」或用用户确认的美术意图定根因。

> 同一症状在 5.1.2 又发现**第二个独立根因**（`usingRightFrames` 被当成缓存状态、只在进动作时算一次）——两处都修完才彻底消失，见本文件顶部 `[5.1.2]` 的同名小节。

## [5.1.0] - 2026-09-08

### 新增：第 4 个角色 gwen（格温妮斯）

- 走数据驱动接入，零代码改动：`assets/gwen/`（82 PNG）+ `config/actions/gwen.json`、`config/characters/gwen.json`、`config/images/gwen.json`，`config/config.json` 的 `characters` 加 `gwen`。
- 15 个动作，独有 `read`（看书）；站立帧名是 `stand`（不是 `idle`）；**不写 `interactAction`** → 不参与桌宠↔桌宠互动（`rollMeet` 自动跳过）。
- 同步调整 `actions/nina.json`。

### 修复：gwen 点头顶/身边点不到（宽帧被缩小产生透明死区）

`applySpriteSize` 的全局 contain-fit 对**宽帧**取 `min(高比, 宽比)`，被 `config.size.width`(150) 约束缩小。gwen 的 `work`（办公）帧是 180×150 宽帧，且 `work` 常驻 `wanderActions` → 被缩到 150×125、底边对齐 → 角色顶部多出 ~25px 透明死区，点头顶上方 `petAt` 判为「不在角色上」→ 窗口保持穿透。

- 修复（与 `fly` 同模式）：给 `config/actions/gwen.json` 的 `work` 加 `"width": 180`，原生 180×150 显示，死区消失。

## [5.0.0] - 2026-09-07

### 变更：抛到屏幕边缘改为平滑反弹（复刻旧版 Shimeji）+ 版本号起跳 5.x

- **版本约定**：用户确认 0.4.10「这版好」→ 本迭代起 `0.4.10 → 5.0.0`，跳过 0.5 / 1.x–4.x（桌面宠物视为可毕业里程碑）。此后按此线递增。
- **现象**：被抛掷到屏幕左右边缘时有一个明显的「吸附」动作（角色抓住墙往上爬），观感突兀。
- **根因**（对照旧版 `actions.xml`）：旧版 `Thrown`(369-378) 命中左/右边框只走 `GrabWall Duration=100`（黏 ~0.1s 就脱落继续下落），`Falling`(663-677) 命中边框直接 `Bouncing`（弹回）——**旧版被抛到边缘绝不爬墙**。我们 `Pet.ts stepPhysics` 在 `airborne && atScreenEdge(6)` 时直接 `requestAction(climb)` 抓墙往上爬。
- **修复**：下落撞左右边框改为**水平反弹**（`vx = -vx * 0.5`），继续重力下落、不爬墙。注意与「**走路**走到边缘才爬墙」（`walkAction`，Shimeji 正常墙爬行为，保留）是两回事。
- ⚠️ `release/DeskPet-Portable-5.0.0/` 保留的是**带弹跳**的构建；随后用户指示回退，本地 dev 源码恢复为「下落撞边 → 抓墙」。**两者不一致是有意为之**（用户要求保留 5.0.0 release 原样）。

## [0.4.10] - 2026-09-07

### 修复：角色悬空时桌面点不动（空中下落也应穿透）

- **现象**：角色只有触碰地面时才释放鼠标，悬空时点不到桌面。
- **根因**：`app.ts reconcile()` 把 `falling = Pet.getAll().some(p => p.isFalling())` 并入了 `blocked`。`isFalling()` == `physicsActive()`，仅在 `fall` 动作期间为 true → 角色一被抛出、**还在空中下落**，整个窗口就被强制捕获，桌面点不动，直到落地才放开。
- **修复**：把 `falling` 从 `blocked` 移除 —— 空中角色「光标没压到它 → 窗口穿透（桌面可点）；光标压到它 → 仍靠 `overPet` 捕获（照样接得住）」；新增 `prevFalling`，仅用「下落结束（刚落地）」事件触发释放保护。

## [0.4.9] - 2026-09-07

### 修复：点完菜单/动作后仍要点一下任务栏才能点桌面（穿透残留）

- **现象**：v0.4.8 后「点击或触发动作之后仍需点一下任务栏才能点桌面」。
- **根因**：`ContextMenu.hide()` 把 `Pet.menuOpen=false` 后依赖「下一个 `mousemove` 自动重算」。但右键菜单项点击的事件时序是 `mousedown → mouseup → click`：window 的 `mouseup` 监听在 `click` **之前**触发，那时 `menuOpen` 仍是 `true` → 那次 `reconcile` 看到「菜单开着」而强制捕获；`click` 里 `hide()` 才置 `menuOpen=false`，之后**再无事件触发 `reconcile`** → 窗口残留「捕获」态、桌面点不动，须移动鼠标（点任务栏）才自愈。
- **修复**：`contextMenu.ts hide()` 末尾派发 `context-menu-closed` 事件（覆盖点菜单项 / 点别处 / ESC / 空菜单所有路径）；`app.ts` 记录 `lastMouseX/Y`，在该事件里按真实光标坐标重算。

## [0.4.8] - 2026-09-07

### 体验修复：抛投手感一轮调整 + 穿透安全复刻

- **抛投判定**：把「直线度门槛」改为速度死区 `THROW_DEADZONE = 1.6` + 最近帧偏置(0.3/0.7)，任何方向甩动都能可靠抛出。
- **抛掷力度等比**：`throwFactor 2.5 → 1.0`（复刻 Shimeji 零系数百分比映射：小力近、大力远），`maxThrow: 45` 仅作极端上限。
- **重力回滚**：`gravity 1.5 → 0.5`（实测 1.5 不如 0.5 的轻飘手感）。
- **穿透安全复刻**：交互结束立即保持穿透、桌面立即可点（`justFreed` 保护），拖拽仍可用。

## [0.4.7] - 2026-09-07

### 体验修复：合体摆位 / 攀爬拎起 / 监管面板

- 合体互动结束时的左右位摆位修正（不再重叠）。
- 攀爬中拎起角色不再刷新到贴地（`skipSettle`）。
- **监管面板**：面板显示时窗口穿透 + 面板自交互 + 桌面可点（不再全捕获）；面板可拖拽 / resize / 关闭；`mouseThrough` 加节流防卡死。

## [0.4.6] - 2026-09-06

### 固化：carrot 帧 scale 修复 + 下落接住两处修复

- 用户确认后固化为独立版本发布；`verify-actions` 38 动作 0 失败。
- 确认 release 内 `config/images/nina.json` 的 `L/R-carrot-7/8` `scale: 1` 已正确同步。
- 首次由 `repack-portable.mjs` **首次组装**该目录（拷贝 electron 运行时 + 改名 `DeskPet.exe` + 同步 dist/assets/config/package.json/koffi/@koromix）。

## [0.4.5] - 2026-09-06

### 删除 rebeza 后的首个功能版（rose + nina）

- `config/images` 只剩 `coop` / `nina` / `rose`（无 rebeza）。
- 含 `eat` / 拖拽 / land 冲突 / tripping / offset / `durationMs` 的全量修复。

## [0.4.4] - 2026-09-06

### ⚠️ 三角色历史快照（归档用途）

- 内容 = rose + nina + rebeza 三角色版本，**含后来被删除的 rebeza**，保留作历史归档。
- 同期完成 nina/rebeza 全量清理：`config/{characters,actions,images}` 各删 2 文件、`assets/{nina,rebeza}` 整目录删除、`config.ts` DEFAULTS 删 nina 段、`config.json` 的 `characters` 只留 `rose`、`rose.json` 删 `meetRules.nina/.rebeza`。
- ⚠️ **该目录现已不在仓库中**（2026-09-12 核实；现存最早的 release 目录是 `0.4.6`）。

## [0.4.3] - 2026-09-04

### 清理无效代码 + 发布

- 静态扫描（`tsc --noEmit --noUnusedLocals --noUnusedParameters`）+ 孤立素材扫描后清理：
  - `src/renderer/Pet.ts` 删 4 处死代码：未用的 `ActionBehavior` import、未用常量 `TILT_FACTOR` / `MAX_TILT`、未调用的 `startWalkInward()`（攀爬到/离开墙的兜底已由 `stepClimb` + `requestAction` 闭环覆盖）。
  - 删孤立素材 `assets/rose/L-swing-4.png`（及 R 镜像）——举手姿态、未被 `config/images/rose.json` 引用。全量 256 PNG 扫描 0 孤儿。
- 保留 `dragLeftAction` / `dragRightAction` / `dragIdleAction` 配置字段（文档化可扩展项，删除易破坏用户 config）。

## [0.4.2] - 2026-08-28

### 修复：抛投方向失衡（竖飞、横不动）

- **回退速度平滑系数** `0.3/0.7` → `0.6/0.4`：原"偏重最新帧"导致松手前最后一次向上提的动作吞掉水平分量，表现为"横着没变化"。
- **下调抛投限幅** `maxThrow` 60 → 26（三角色一致）：配合 `gravity` 0.35，初速度 60 会让角色飞出屏幕 5000+px（"竖着飞老高"）；26 时顶点约 965px，留在屏内。
- **微调抛投系数** `throwFactor` 3.0 → 2.5：补偿平滑回退，仍保留跟手甩动。

## [0.4.1] - 2026-08-28

### 体验修复：抛投手感 + auto-hide 任务栏

- **抛投初速度上调**：三个角色的 `throwFactor` 1.9→3.0、`maxThrow` 35→60（rose/rebeza 从默认 0.9/28 补到 3.0/60）；`Pet.ts` 拖拽速度平滑从 `0.6/0.4` 改为偏重最新帧的 `0.3/0.7`，快速甩动更跟手、不再"扔不出去"。
- **auto-hide 任务栏弹出检测**（修复"任务栏浮现时桌宠挡在前面"）：Electron 的 `workArea` 在 auto-hide 模式下始终返回全屏，任务栏弹出不触发变化。新增 `winapi.getTaskbarRect()`（FindWindow('Shell_TrayWnd') + 可见性/位置判定），主进程 `computeWorkArea()` 在 auto-hide 模式下主动探测任务栏是否弹出，弹出时把角色地面抬到任务栏上沿（覆盖底部/顶部/左/右四边）。固定任务栏模式仍信任 Electron 原生 workArea，不二次探测。
- **置顶逻辑说明**：窗口创建即 `setAlwaysOnTop(true, 'screen-saver', 1)`，并由 `setInterval` 定时重申防被其他置顶窗抢走；auto-hide 任务栏弹出时通过上移角色（而非降优先级）避让，保持置顶体验。

## [0.4.0] - 2026-08-28

### 行为系统补全（对齐 Shimeji Nina 91% 动作语义）+ 体验修复

#### 数据层三件套（types.ts / config.ts / Pet.ts）
- **帧级独立时长**：`frames` 支持对象写法 `{name, ms}`，逐帧独立计时（不再被动作级 `speed` 均匀拖平）。修掉 creep / sleep / climbWall / pinched / sitAndLookAtMouse 的变速损失，Nina 共 11 个动作已用真实时长。
- **加权自发漫游**：`wanderActions` 支持 `[{id, weight}]`（旧字符串写法 = 权重 1）；候选按「在地面/贴边/空中」上下文过滤（贴边禁 walk、空中禁 idle）。坐/睡/祈祷/爬墙变自发行为，不再只能从菜单手动触发。
- **动作序列 `next`**：非 loop 动作播完（或 `durationMs` 到期）后按 `next` 链（`[{id, weight}]` 权重随机）自动接续，覆盖组合行为里的线性序列，无死循环（深度 >8 强制回默认）。

#### 新增运行模式
- **`ceiling` 贴顶爬**：climb 爬到顶后按 `ceilingChance` 概率进入，沿天花板横向倒挂爬（130×270 倒挂帧）；到目标后三选一：松手掉落 / 贴边下爬 / 换目标继续。四向移动补全。新增 `ceilingAction` / `ceilingChance` / `ceilingDropChance` / `ceilingEdgeChance`。
- **`chase` 追鼠标**：`chase` 动作按鼠标相对位置朝指针 x 跑（默认 2 倍速），指针停 / 超距 / 超时回默认。新增 `chaseAction` 配置与 `chaseRange` / `chaseTimeoutMs`。
- **`trackMouse` 朝向**：static 动作期间按鼠标相对位置自动翻转朝向（Look 系）。

#### 窗口交互（M5，koffi / Win32 FFI，主进程枚举+移动第三方窗口）
- 新增 `carry-window`（搬着最近窗口走、抛投）/ `ledge-window`（站窗口顶边随窗口移动）两个 `windowMode` 动作。
- 主进程 `src/main/winapi.ts` 用 koffi 调 `EnumWindows/GetWindowRect/SetWindowPos` 枚举与移动窗口；渲染层 `windowInteract.ts` 接管位置同步与抛出重力动画。
- **优雅降级**：koffi 缺失 / 非 Windows 时窗口系菜单自动隐藏，其余功能不受影响。打包时 koffi 已纳入 `extraResources` + `asarUnpack`。

#### 体验修复
- **置顶级别升级**：窗口由默认 `alwaysOnTop` 升为 `screen-saver` 级 + level 1，并每 4s 重申，可压过任务管理器等其他置顶窗口。
- **任务栏适配**：主窗口铺满整个显示器 bounds（不再裁剪到 workArea）；主进程 1s 轮询 `workArea` 并在变化时下发，角色「地面」= workArea 底边 → 任务栏隐藏时自动贴屏幕最底。
- **删除退场动画**：`removePet` 改为异步——优先播 `removeAction` 专属帧（如 prayer 挥手），无则通用淡出（alpha→0 + 上浮 + 缩小）。新增 `removeAction` / `removeActionMs` / `removeFadeMs`。
- **右键触发动作前站立静止**：`PET_MENU_ACTION` 分流处先打断走动/攀爬/惯性/空中态、落回地面切站立帧，再播所选动作（解决「第一帧方向/位置错」的截图高发区）。

#### 工程
- `scripts/verify-actions.mjs` 适配 `{name, ms}` 帧对象写法。
- `config/actions/nina.json` / `config/characters/nina.json` 补全上述全部能力（38 动作、加权 wander、ceiling/chase/look/window 动作）；`verify-actions` 全量 100 动作 0 失败。

## [0.3.1] - 2026-08-22

### 交互增强：吸附 / 配对台词 / 边界触发攀爬 / 拖拽晃动
- **相遇吸附**：两人进入 interact 后由 `app.ts` 持续把位置「吸附」到连线中点、脸对脸、中间留 `interactGap`（默认 30px），不再随机贴脸距离。
- **配对台词**：相遇时 A 说的 = 「B 剧本里对 A 说的那句」，B 同理 → 两人台词天然配对、不重复（修掉之前各自随机抽可能撞车）。
- **climb 改为边界触发**：walk 走到屏幕左/右边框（10px 内）自动切 climb（沿该边框上下爬），离开边框自动回 walk。`requestAction` 里 climb 目标点改为贴当前所在边框。
- **拖拽晃动子动作**：被鼠标拖动时按移动方向切 `drag-left`/`drag-right`/`drag-idle`（左移/右移/静止或上下）三种动作帧；美术缺失自动回退到 `drag`/占位。新增 `dragLeftAction`/`dragRightAction`/`dragIdleAction` 字段。
- 新增配置字段：`interactGap`、`walkAction`、`climbAction`、`dragLeftAction`、`dragRightAction`、`dragIdleAction`（均带默认值，旧 config 兼容）。
- 文档：`config/README.md` 补上述字段与「climb 边界触发」说明。

## [0.3.0] - 2026-08-22

### 架构重构：数据驱动动作系统 + 方案 B 热加载
- **动作 = 数据**：每个角色含 `actions` 注册表（自由 key），每条动作 = `{ behavior 运行模式, frames 帧名[], speed, loop, dialogue?, facePartner?, moveSpeed? }`。
- **运行模式 `behavior`**（有限代码集）：`static`(原地) / `walk`(沿下沿左右位移) / `climb`(沿边框上下位移) / `drag`(鼠标)。新增「动作」纯数据；新增「运行模式」才改 `Pet.ts` 的 `stepXxx` + `types.ts` 的 `ActionBehavior`。
- **帧引用改帧名**：`manifest.json` 改为 `frames[角色id][帧名]`；动作 `frames` 直接写帧名，错配显式告警而非静默回退。
- **新增 `climb` 动作演示**：妮娜 `wanderActions` 含 `walk`+`climb`，可沿屏幕上下攀爬。
- **方案 B 热加载**：`app.ts` 用 `fs.watch` 监听 `config/` 与 `assets/`，改动防抖 300ms 后自动重建宠物 + 重读 manifest；开发模式 (`npm run dev`) 下改参数/美术即时可见，不用重启、不用重编译。
- `config.json` 同步为 actions 注册表结构；`config/README.md` 补「如何加新动作 / 新角色」示例。
- `manifest.json` 改为 `frames` 结构；`assets/README.md` 同步。

### 兼容性
- `config.ts` 的 `loadUserConfig` 仍兼容旧 `animations` 写法（自动转 actions）。
- 版本 0.2.9 → 0.3.0（minor：行为契约变化，属功能增强）。

## [0.2.9] - 2026-08-22

### 路径 C：可调参数外置为 config.json（开发态与便携版一致）
- 新增 `config/` 目录（项目根 + 便携版 `DeskPet.exe` 同级），内含 `config.json`（用户可调参数）与 `README.md`（字段中文说明）。
- 渲染进程启动时读取 `config.json`，与 `src/renderer/config.ts` 的默认值**深度合并**：按角色 `id` 匹配、只覆盖 JSON 中出现的字段；文件缺失/损坏自动回退默认值，**永不崩溃**。
- 主进程新增 `get-config-dir` IPC：便携版取 exe 同级 `config/`，`npm run dev` 取项目根 `config/`。
- 外置参数：`size`、`moveSpeed`、`detectionRadius`、`bottomMargin`、`interactionDuration`、`bubbleOffset`（气泡距离系数，替代硬编码 0.35）、`meetDialogue`、`facing`、`personality`、`animations`（含 `INTERACTING.speed` 控制相遇动作快慢）。
- 用户改 `config.json` → 重启 exe 即生效，**无需重编译、无需打包**，满足"独立程序 + 所有东西在一起 + 还能调参"。

## [0.2.8] - 2026-08-22

### 修复
- **坐下"还是扁"**：0.2.7 把 `size.height` 提到 120 仍不够——美术源图本身就是 150×150，**画布再小就被压扁**。0.2.8 改 `size.height = 150`（与源图原始尺寸相等，不再缩小），角色立得起来。`Pet.applySpriteSize` 已按真实宽高比算宽度，正方形美术不会变形。
- **相遇循环帧**：之前 manifest 把 INTERACTING 配成单帧 `shime50`，没有"动作感"。现在接入 `shime51/shime52`（nina 补充）和 `shime51-1`（rose 补充）作为相遇时多帧动画，`config.ts` 把 `INTERACTING.speed` 从 0.1 提到 0.25（约 15 fps），持续 3500ms 期间自然循环。
- 接入新美术：
  - `assets/nina/shime51.png`、`shime52.png`（坐姿挥手 / 捧脸系列）
  - `assets/rose/shime51-1.png`（黄发闭眼笑 + 音符）
  - `assets/manifest.json` 把 `INTERACTING` 改为帧数组

## [0.2.7] - 2026-08-22

### 修复
- **"图片变扁"观感**：之前把 `body.width = body.height = config.size.width` 强制设为正方形，无论美术原图比例都按 1:1 拉伸；新策略以 `config.size.height` 为目标高度、按 `texture.width/height` 真实宽高比计算显示宽度，宽度上限不超过 `config.size.width`，**任何比例的美术都不会被压扁或拉宽**。同时把基础尺寸从 80 提到 120，角色体积感更清晰，不再"豆腐块"。
  - 新增 `Pet.applySpriteSize(tex)`，在 `applyStateTexture()` 与 `tickAnimation()` 切帧时调用。
- **相遇首帧朝向错向**（"面对面"不到位）：`startInteraction` 进 `INTERACTING` 之前先按 partner 位置算好 `facingRight`，避免截图捕获到"上一秒 WALKING 的方向、下一秒才纠正"那一帧。
- 妮娜台词收短为「露丝！」（用户反馈过长；现在两人恰好互相点名，最简洁对仗）。

## [0.2.6] - 2026-08-22

### 新增 / 调整
- **角色朝向翻转**：美术默认朝左（`facing: 'left'`）。角色**向右走时**自动 `body.scale.x = -1` 镜像翻转；**向左走**时正常。相遇 (INTERACTING) 时双方各自翻转，确保面对面。
  - 类型新字段 `facing?: 'left' | 'right'`，配置 nina/rose 显式标注 `left`。
  - `Pet.allInstances` 静态表用于在 `findPartner` 中定位对方，避免依赖 container.parent 的脆弱引用。
- **日志写到解压目录**（用户要求）：`getLogDir()` 默认尝试把 `boot.log` 写到 `DeskPet.exe` 同级的 `Data/` 目录，便携版跑完直接看那里；不可写时回退到 `app.getPath('userData')`，保证开发/沙箱也能落盘。

## [0.2.5] - 2026-08-22

### 修复
- **图片全透明/不显示**：重写 `SpriteResolver`，把同步的 `PIXI.Texture.from(dataUri)` 换成异步 `PIXI.Assets.load`，真正等待 PNG 解码完成。0.2.4 因 v8 API 退化为空壳纹理，导致角色身体显示异常但对话气泡与移动正常。
- 路径用绝对路径 + 缺失文件 console.warn 提示，方便排查。

## [0.2.4] - 2026-08-21
### Added
- 接入真实角色美术（用户提供的 `img/` 源图，已搬入 `assets/` 并按角色重命名目录）：
  - 角色 `nina`（妮娜）：走路帧 `shime1/2/3.png` + 相遇图 `shime50.png`。
  - 角色 `rose`（露丝）：走路帧 `shime1/2/3.png` + 相遇图 `shime50.png`。
- 相遇时各自切换为 `shime50` 姿态图，并说出**特定台词**：妮娜「想你！爱你！明天见！」，露丝「妮娜！」（由 `config.ts` 的 `meetDialogue` 驱动）。
- 清理：删除占位空目录 `assets/pet_a`、`assets/pet_b`，以及仅作投递源的 `img/` 原图目录（已复制进 `assets/`，程序不读 `img/`）。

## [0.2.3] - 2026-08-21
### Changed
- 美术接入修复 + 走路帧动画：
  - 修复 `manifest.json` 键名大小写与 `MotionState` 枚举（`IDLE/WALKING/...`）不匹配导致美术永远加载不到的 bug；加载器改为大小写不敏感。
  - `Pet.ts` 新增帧动画播放：走路等多帧状态按配置的 fps 循环播放贴图，呈现"走路外观"而非单纯平移；待机/互动/拖拽等无专属美术时自动复用 WALKING 第1帧，方块占位彻底消失。
  - 情绪着色仅作用于占位图形，不再污染外部美术贴图。
- `assets/manifest.json` 预置 pet_a/pet_b 的 3 帧 WALKING 条目；`assets/README.md` 写明图片存放路径（开发版 `assets/<id>/` 与便携版 `resources/assets/<id>/`）。

## [0.2.2] - 2026-08-21
### Changed
- 移动模型改为**以屏幕下沿为基准的左右移动**：宠物初始即贴底，行走只沿 x 轴，不再满屏二维乱飘。
- 新增 `bottomMargin` 配置（默认 0），控制宠物离屏幕下沿的上抬像素，方便避开任务栏等。
- 拖拽结束自动落回屏幕下沿；行走时每帧把 y 锁定到基准线，窗口缩放也会自适应。
- 互检逻辑无需改动：因两宠物都贴同一下沿线，欧氏距离即等于水平间距，"靠近（120px）就互动"自然退化为左右走到一起才互动。

## [0.2.1] - 2026-08-21
### Added
- 验证基础设施（确保"程序真的有效"，而不仅是编译通过）：
  - `npm test`：情绪系统单元测试（12 项，node 运行，覆盖基线回归/触发/衰减/性格差异）。
  - `npm run verify`：便携版构建后自检脚本，断言 main 路径/清单/ exe 可启动。
  - 启动诊断日志：主进程与渲染进程把启动每步与崩溃写入 `userData/boot.log`，无显示器环境也能确认程序跑通整条链路。
- `tsconfig.test.json` + `tests/emotion.test.ts` + `scripts/verify-build.mjs`。

## [0.1.1] - 2026-08-21
### Fixed
- 便携版组装时 `dist/` 目录被压平，导致 `resources/app/dist/main/index.js` 路径不存在，运行时抛 `Cannot find module`。
- 修复便携版目录结构，保留 `dist/main` 和 `dist/renderer` 子目录。

## [0.1.0] - 2026-08-21
### Added
- 首版：Electron + PixiJS 桌宠，双角色（Alpha/Beta）占位形象。
- 透明全屏置顶窗口 + 鼠标穿透（hover 宠物时恢复交互）。
- 拖拽、随机巡逻、靠近自动互动、点击弹气泡、情绪着色。
- 美术资源走 `assets/manifest.json` 外部加载，缺失自动回退占位（无需改代码即可替换美术）。
- 程序内右下角显示版本号。
- 便携版：双击 `DeskPet.exe` 直接运行，无需安装。
