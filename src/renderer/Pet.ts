import * as PIXI from 'pixi.js';
import { CharacterConfig, ActionDef, FrameRef } from './types';
import { SpriteResolver } from './SpriteResolver';
import { SpeechBubble } from './SpeechBubble';
import { eventBus, EVENTS } from './eventBus';
import { supervisorLog } from './supervisor/eventLog';
import { mouseState, mouseActive } from './mouse';

/** 监管日志的安全 emit：永不抛异常 */
function slog(e: Parameters<typeof supervisorLog.emit>[0]) {
  try { supervisorLog.emit(e); } catch { /* swallow */ }
}

/** 位移/编排诊断日志：经 renderer-log IPC 转发到主进程 boot.log（终端/文件可见，DevTools 不必开）。 */
export function petLog(msg: string) {
  try {
    const req = (window as any).require;
    if (typeof req !== 'function') return;
    const ipc = req('electron').ipcRenderer;
    ipc?.send('renderer-log', 'info', '[pet] ' + msg);
  } catch { /* 诊断日志失败不影响主流程 */ }
}

/** FrameRef[] -> 帧名[]（兼容 string 与 {name, ms} 两种写法）。 */
function frameNames(frames: FrameRef[]): string[] {
  return frames.map((f) => (typeof f === 'string' ? f : f.name));
}

/** 第 i 帧的独立时长(ms)；该帧未写 ms 返回 null（回退动作级 speed 帧率）。 */
function frameMs(frames: FrameRef[], i: number): number | null {
  const f = frames[i];
  return typeof f !== 'string' && typeof f.ms === 'number' ? f.ms : null;
}

/** 第 i 帧的水平位移速度(px/帧@60fps)；该帧未写 vx 返回 null（回退动作级 moveSpeed）。
 *  参考 Shimeji ローズ Walk：每个 Pose 带自己的 Velocity，角色在该帧期间连续前进；
 *  vx=0 即「支撑/落脚帧」，该帧不位移——自然呈现「只在特定帧位移」的踩步感。 */
function frameVx(frames: FrameRef[], i: number): number | null {
  const f = frames[i];
  return typeof f !== 'string' && typeof f.vx === 'number' ? f.vx : null;
}

/** 第 i 帧的竖直位移速度(px/帧@60fps)；该帧未写 vy 返回 null（回退动作级 moveSpeed）。
 *  用于 climb 等竖直位移动作：vy=0 即「挂壁停/起步帧」，vy>0 即该帧向上爬，节奏与 walk 的 vx 踩步对称。 */
function frameVy(frames: FrameRef[], i: number): number | null {
  const f = frames[i];
  return typeof f !== 'string' && typeof f.vy === 'number' ? f.vy : null;
}

/** 第 i 帧的显示缩放系数；未写 scale 返回 null（回退到容器约束下的 contain-fit 自动缩放）。
 *  用于个别帧画布尺寸异常（如变宽）导致角色被压小时，强制按指定缩放显示。 */
function frameScale(frames: FrameRef[], i: number): number | null {
  const f = frames[i];
  return typeof f !== 'string' && typeof f.scale === 'number' ? f.scale : null;
}

/** 从（string | {id, weight})[] 里按权重随机取一个 id；权重缺省=1。空/全零返回 null。 */
function weightedPick(entries: readonly (string | { id: string; weight?: number })[]): string | null {
  const pool = entries
    .map((e) => (typeof e === 'string' ? { id: e, weight: 1 } : { id: e.id, weight: e.weight ?? 1 }))
    .filter((e) => e.weight > 0);
  if (pool.length === 0) return null;
  let r = Math.random() * pool.reduce((s, e) => s + e.weight, 0);
  for (const e of pool) {
    r -= e.weight;
    if (r <= 0) return e.id;
  }
  return pool[pool.length - 1].id;
}

/**
 * 通用宠物：状态完全由「当前动作 id」驱动。
 * - 动作来自 config.actions 注册表（数据驱动），运行时可热重载。
 * - 行为（左右走 / 攀爬 / 原地 / 拖拽）由动作的 behavior 字段决定，
 *   新增「动作」只需数据，新增「运行模式」才改下面的 step 函数 + ActionBehavior 联合类型。
 */
export class Pet {
  private static allInstances: Pet[] = [];
  public static getAll(): readonly Pet[] { return Pet.allInstances; }

  // —— 「地面」位置（屏幕坐标）——
  // 主进程下发的 workArea 底边（见 main/index.ts 的 work-area-changed IPC）。
  // 任务栏显示时 = 工作区底边（角色站在任务栏上沿）；任务栏隐藏时 = 屏幕最底边。
  // null = 窗口尚未初始化，退回 window.innerHeight。
  private static floorY: number | null = null;
  public static setFloor(y: number | null) { Pet.floorY = y; }
  public static getFloor(): number { return Pet.floorY ?? window.innerHeight; }

  /** 退场中（删除动画播放期间）：不参与相遇/攀爬/菜单等一切调度。 */
  public isRemoving = false;
  /** 退场「落地等待中」：已收到退场指令、但人还在空中/墙上/贴顶，正在掉回地面。
   *  这期间 isRemoving 仍为 false（否则 update 会跳过物理、永远落不了地），
   *  所以调度侧一律用 `isLeaving()` 判断「这只已经在退场流程里」。 */
  private removePending = false;
  /** 是否已进入退场流程（含「先掉落回地面」这段等待期）。外部调度/命中判定统一用这个。 */
  public isLeaving(): boolean { return this.isRemoving || this.removePending; }

  /** 窗口交互占用（搬运窗口/挂窗沿）：位置由 WindowInteract 接管，行为/物理暂停。 */
  public isWindowHeld = false;

  /** 按屏幕坐标命中宠物（右键/悬停兜底，避免穿透态下 Pixi pointerover 漏触发导致死锁）。
   *
   *  【命中优先级 = 渲染 z 序，必须「从后往前」扫】
   *  allInstances 的顺序与 stage 子节点顺序一致（都按加入顺序追加）→ **最后加入的画在最上层**。
   *  而 Pixi 自己的 hit-test 命中的也是最上层对象。若这里从头扫（返回最下层），两者就不一致：
   *  当两只角色重叠时，Pixi 会把拖拽派发给上层角色，reconcile 却把 Pet.hoveredPet 设成下层角色
   *  （右键菜单因此弹错人），上层角色「点不动/总是被下层抢走」。
   *  由于「最后加入的角色永远画在最上层」，受害的总是最后加入的那只（当前 = gwen）。
   *  故与渲染 z 序对齐：倒序扫描，命中最上层者。
   *
   *  另：不可见容器（合体时隐身的配角）直接跳过——不依赖 Pixi「invisible → 空 bounds」的实现细节。 */
  public static petAt(x: number, y: number): Pet | null {
    for (let i = Pet.allInstances.length - 1; i >= 0; i--) {
      const pet = Pet.allInstances[i];
      if (pet.isLeaving()) continue; // 退场中（含「正在落地」）的角色不可交互
      // 防御：已销毁/不可渲染的实例不参与命中——否则下方 getBounds() 抛异常会冒泡到
      // reconcile() 使其每次 mousemove 都抛、mouseThrough 冻结在 true（穿透）永不自愈 → 「点不动」。
      if (pet.container.destroyed || !pet.container.visible) continue;
      // 命中矩形用角色「已知逻辑外接框」(container 左上角 + config.size) 而非 getBounds()：
      // getBounds 每次重算、依赖完整 transform/子节点 bounds，会受一帧滞后、body.visible 切换、
      // 气泡偏移、倾斜旋转等影响而与可见位置产生偏差；而 container.x/y 即角色框左上角
      // （body 以 0.5 锚点居中于 tiltNode，tiltNode 居中于 container），与可见位置严格一致，
      // 彻底消除「看得见却点不中」的命中失灵。stage 无缩放/偏移，故 container 坐标即 clientX/Y 空间。
      const minX = pet.container.x;
      const minY = pet.container.y;
      const maxX = minX + pet.config.size.width;
      const maxY = minY + pet.config.size.height;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) return pet;
    }
    return null;
  }
  /** 是否正在下落（重力接管中）。供 app.ts reconcile 在下落期间强制窗口捕获点击，保证可被鼠标接住。 */
  public isFalling(): boolean { return this.physicsActive(); }
  /** 落点容差抓取：光标未直接命中、但附近有「下落中」角色时返回最近的一个。
   *  给快速下落的点击落空兜底——下落角色移动快、用户点击有反应延迟，常点在角色「刚才的位置」。 */
  public static nearbyFallingPet(x: number, y: number, radius: number): Pet | null {
    let best: Pet | null = null;
    let bestD = Infinity;
    for (const pet of Pet.allInstances) {
      if (pet.isLeaving() || !pet.physicsActive()) continue;
      const b: any = pet.container.getBounds();
      const dx = Math.max(b.minX - x, 0, x - b.maxX);
      const dy = Math.max(b.minY - y, 0, y - b.maxY);
      const d = Math.hypot(dx, dy);
      if (d <= radius && d < bestD) { bestD = d; best = pet; }
    }
    return best;
  }
  /** 热重载时清空全局实例引用，避免旧实例继续参与相遇判定 */
  public static clearInstances() {
    const total = Pet.allInstances.length;
    slog({ level: 'system', category: 'pet.lifecycle', cause: 'clearInstances',
      before: { total }, after: { total: 0 } });
    Pet.allInstances = [];
  }
  /** 同步全局实例列表到指定数组（召唤/删除后调用，保证 findPartner 等基于真实在场列表） */
  public static syncInstances(list: readonly Pet[]) { Pet.allInstances = [...list]; }

  public container: PIXI.Container;
  public readonly config: CharacterConfig;

  private bodyTex: PIXI.Texture;
  private body: PIXI.Sprite;
  private bubble: SpeechBubble;

  // —— 动作状态（取代原 MotionState 枚举）——
  private actionId: string = 'idle';
  private actionDef!: ActionDef;
  private actionTextures: PIXI.Texture[] = []; // 当前动作的帧贴图
  // 双套图集预加载：进动作时把 L/R 两套帧都加载好，转向只切换已加载数组（瞬时、不重置动画），
  // 消除「facingRight 同步改了、actionTextures 异步才到」造成的偶发倒着走。
  private texL: PIXI.Texture[] = [];
  private texR: PIXI.Texture[] = [];
  // 飞行「悬停相位」帧集（hoverFrames / hoverRightFrames），同样预先加载好两套。
  // 未配置 hoverFrames 时为空数组 → syncFrameSet 自动退回 texL/texR（旧行为，对未配的角色零影响）。
  private texHL: PIXI.Texture[] = [];
  private texHR: PIXI.Texture[] = [];
  private loadToken = 0; // 丢弃过期加载，避免快速连切动作时旧帧集覆盖新帧集
  private frameIdx = 0;
  private framesPending = false; // 切换动作且新帧集未就绪：保留上一动作末帧，避免收尾闪回第一帧
  private animAccum = 0;
  private animDone = false; // 非 loop 动作 / 循环达上限后是否已播到末帧（触发 next 序列）
  // 轮末对齐：限时动作的定时器到期时，若动画还在播（非末帧 / 循环未到轮末），
  // 不再立即切断（会把动作切在半路，如 shakeHead 4000ms/轮 被 3500ms 硬停），
  // 而是置此标记，等 tickAnimation 播到轮末/末帧再收尾。切动作时清零，不会残留。
  private recentWander: string[] = []; // 最近抽到的 wander 动作（新→旧），防重复用；长度 = wanderRecentSize（默认 3）
  private pendingAdvance = false;
  private pendingAdvanceAt = 0; // 待办挂起时刻(ms)，超时兜底用
  // 轮末对齐的最长等待：多帧动画一轮过长时（如 13 帧 × 1000ms）不能无限等，
  // 超过该时长仍强制收尾。正常动作一轮都在 1–4s，够用。
  private static readonly ROUND_ALIGN_MAX_MS = 4000;
  // 单帧静止动作（sit 这类）没有动画可播完，必须靠时长收尾；若配置漏写 durationMs 就用它兜底，
  // 否则会永久卡在该动作（reconcile 见 scheduleActionEnd 注释）。
  private static readonly STATIC_HOLD_FALLBACK_MS = 2500;
  private loopRound = 0; // 当前动作已完成的循环轮数（loopCount 用）
  // —— 帧驱动的台词（动作级 dialogueFrame）——
  // pendingLine 非空 = 台词已选好、正等着播到指定帧；到达该帧即弹并清空（所以循环动作只会弹一次）。
  private pendingLine: string | null = null;
  private pendingLineFrame = -1; // 已解析成绝对帧号（0-based）
  private pendingLineHold: number | null = null; // 气泡显示时长覆盖值（dialogueHoldMs / 调用方 durationMs）
  private chainDepth = 0; // next 序列深度（防死循环，>8 强制回默认）
  private chaseMs = 0; // chase 动作已追击时长(ms)
  private actionTimer: number | null = null; // 限时动作（如 interact）的结束定时器
  private isDragging = false;
  private dragMoved = false; // 本次按下是否真的拖动过（区分"点击"与"提起拖拽"），用于抑制拖拽后误弹气泡
  private dragTarget: { x: number; y: number } | null = null; // 拖拽时鼠标目标点（弹簧跟随的终点，由 updateDragTilt 追向）
  private grabLineShown = false; // 本次抓取是否已说过"放开我"等抓取台词（每只宠物只说一次）
  private perchTimer = 0; // 攀爬时两条腿之间的"挂壁停顿"计时(ms)：>0 期间原地不动，停了再选下一条腿
  private climbDir: -1 | 1 = -1; // 当前攀爬腿的方向：-1 向上 / +1 向下。会话内上下折返即「爬上爬下」
  private climbBlockedUntil = 0; // 攀爬冷却截止时刻(ms)：从墙上下来后的一段时间内贴边也不再触发攀爬
  private climbStartMs = 0; // 本次攀爬会话的起始时刻(ms)：超过 climbMaxMs 就下墙（掉落或起飞），避免长期挂在墙上
  private climbSessionActive = false; // 是否处于一次攀爬会话中（上墙 → 到期下墙/落地为止）。
  //  会话边界决定 climbStartMs 何时重置 —— 只有「落地后重新上墙」才算新会话。
  //  历史 P0：原先用 `prevId !== id` 判断，导致「掉落(fall) → 撞边被重新抓回 climb」每次都重置计时，
  //  climbMaxMs 兜底永远不生效 → 角色在墙顶反复 climb↔fall，表现为「爬到最上面就卡住」。
  private static readonly CLIMB_DROP_VX = 2.5; // 松手掉落时朝屏幕内侧的水平初速(px/帧)：让落点离开边缘区，避免冷却一到就重爬同一面墙
  private static readonly CLIMB_LEG_MIN_PX = 120; // 单条攀爬腿的最小跨度(px)：避免目标离当前位置太近导致原地小幅抖动
  private static readonly CLIMB_EDGE_GAP_PX = 40; // 攀爬巡逻的下沿留白(px)：目标不落到地面上，
  //  这样「上墙 → 上下巡逻 → 到期下墙」才是完整会话，不会中途被判「已到地面」而提前结束。
  private swayLastSwitchMs = 0; // 拖拽摆动：上次切帧时刻(ms)，用于 SWAY_FRAME_HOLD_MS 防抖；回正(swing-1)不受此锁
  private tiltNode!: PIXI.Container; // 包裹 body+face，绕角色中心旋转，承载拖拽时的物理倾斜
  private tilt = 0;          // 当前倾斜角(rad)，正=顺时针(向右倾)
  private tiltTarget = 0;    // 目标倾斜角，由鼠标水平移动方向驱动
  private static readonly DRAG_FOLLOW = 0.30;      // 拖拽弹簧跟随系数：越小越滞后、摆动越明显；按 dt 归一后任意刷新率手感一致
  private static readonly MAX_SWAY = 0.42;        // 拖拽最大摆动角(rad)≈±24°
  private static readonly SWAY_FACTOR = 0.022;    // 滞后偏移(px)→摆动角 系数（offset*|factor| 封顶 MAX_SWAY）
  private static readonly SWAY_FRAME_THRESH = 4;  // 水平滞后偏移超过该值(px)即切倾斜帧（≈角色宽 2.7%，对应 Shimeji 角色宽 128 的 ~3.4px）
  private static readonly SWAY_FRAME_HOLD_MS = 90; // 切到倾斜帧(swing-2/3)后最少保持该时长，防抖 + 让帧变化看得见（回正 swing-1 不受此锁）
  private velX = 0; // 拖拽时估算的指针水平速度(px/帧)，供松手抛投保留惯性
  private velY = 0; // 拖拽时估算的指针竖直速度(px/帧)

  // —— 抛投判定（参考 Shimeji「Thrown」：Falling 的 InitialVX/VY 直接取 cursor.dx/dy）——
  // 旧版用「直线度 = |净位移|/路径长度」区分晃动与甩动，但自然甩动大多是弧线，
  // 直线度常 < 0.45 被误判为晃动 → 抛不出去。Shimeji 不做直线度判定：松手瞬间的指针速度
  // 直接当抛投初速度，只有「几乎不动就松手」才视为轻放（自由落体）。故改为纯速度死区判定：
  // 松手时指针速度(指数平滑、偏重最近帧) 的模 < THROW_DEADZONE → 轻放掉落；否则按方向抛出。
  private static readonly THROW_DEADZONE = 2.5; // 松手瞬间指针速度死区(px/帧@60fps，已按事件间隔归一)：低于此值视为「轻轻放下」而非抛投
  private static readonly THROW_IDLE_MS = 70;    // 松手前若超过此毫秒数无指针移动，视为「放下」而非「抛投」（消除残留速度把角色甩飞）

  // —— 相遇阶段：none(常态) / approaching(走近中) / interacting(演关键帧) ——
  private meetPhase: 'none' | 'approaching' | 'interacting' = 'none';
  private meetPartner: Pet | null = null;

  // —— 合体合作动作状态：coopLead=主演承载者，coopFollow=隐身跟随的配角 ——
  private coopLead: Pet | null = null;
  private coopFollow: Pet | null = null;
  /** 主演当前承载的合体动作 id。用于判定「主演是否还在合体态」——
   *  主演被别处切走动作（拖拽/退场/其他调度）时，配角据此自救，避免永久隐身。 */
  private coopActionId: string | null = null;

  private targetPos = { x: 0, y: 0 };
  // walkArriveCb：「走到屏幕某一列」（walkToX）途中，到达目标点后触发的回调。
  // 窗口投掷编排的 approach 阶段靠它把控制权交回状态机（走到 → 抓住）。到点前 Pet.update 仍走 stepWalk。
  private walkArriveCb: (() => void) | null = null;
  private ceilingHangUntil = 0; // 贴顶飞到顶后的悬挂截止时刻(ms)；0=未悬挂，-1=已悬挂完
  // —— 贴顶飞（flyMode='ceiling'）会话：贴到上缘 → 左右巡逻 → 到期掉落 ——
  private ceilingSessionActive = false; // 是否已贴上缘（计时起点标志）
  private ceilingStartMs = 0;           // 贴上缘的时刻(ms)：ceilingMaxMs 从这里起算，上升段不计入
  private ceilingPatrolMs = 0;          // 本次巡逻预算(ms) = ceilingMaxMs 的 50%~100% 随机，避免每次都一样长
  private ceilingDir = 1;               // 贴顶飞水平方向(+1 右 / -1 左)：上升段斜飞与巡逻倾斜都用它
  private flyEnterMs = 0;               // 进入飞行动作的时刻(ms)：仅用于「上升段」的安全兜底
  // —— 飞行「移动 / 悬停」双相位：飞一段 → 原地悬停扑翼片刻 → 再飞（旧桌宠那种「中间偶尔停顿」）——
  // 只在动作配了 hoverFrames 时启用；否则 flyHovering 恒 false，行为与旧版完全一致。
  private flyHovering = false;          // 当前是否处于悬停相位（播 fly 两帧、不位移）
  private flyPhaseUntil = 0;            // 当前相位的结束时刻(ms)
  private static readonly CEILING_RISE_MAX_MS = 30000; // 上升段最长时限：超时仍未贴上缘视为异常，直接掉落
                                                      // （1080p 从地面升顶约 10s、4K 约 24s，30s 足够）
  private static readonly REMOVE_LAND_TIMEOUT_MS = 4000; // 退场「先落地」的最长等待：超时就地演退场，避免退出流程被卡死
                                                        // （1080p 从屏幕顶端自由落体约 1s，4s 留足余量）
  // —— 右键菜单「原地冻结」：菜单打开期间只播帧动画，不跑行为也不跑物理 ——
  private menuHold = false;
  // —— 菜单选了「地面动作」而角色不在可用地面（墙上/空中）时，先掉落、落地后再执行 ——
  private pendingOnLand: (() => void) | null = null;
  // —— 首帧美术是否已出结果（成功/失败都算）：未出结果前不显示占位方块 ——
  private artResolved = false;
  private idleMs = 0;

  // —— 重力 / 物理下落状态 ——
  private vy = 0; // 竖直速度(px/帧)，正=向下
  private vx = 0; // 水平速度(px/帧)，用于受击/被推飞
  private canTrip = false; // 本次下落是否允许触发摔倒（鼠标提起/被推后=true）
  private facingRight = false; // 当前是否视觉朝右（= 美术被水平翻转）
  private usingRightFrames = false; // 当前播放的帧集是否为「右朝向图集」(rightFrames)；true 时 applyFacing 不翻转
  private spawnFalling = false; // 开场掉落态：生成瞬间置于屏幕顶端，重力接管落到地面前为 true（pin 住 spawnAction 不被 fallAction 覆盖）
  // 开场落地的「缓冲期」：从第一次触地起，到弹跳彻底停下为止。
  // 期间照常弹跳（入场要有落地回弹），但压制 ①摔倒动画 ②触地(land)动画——
  // 开场从屏幕顶端攒出的冲击极大，若按普通物理处理会被判成「重摔」，观感就是落地后又摔了一下。
  private spawnSettling = false;

  // —— 卡死检测（仅 walk 动作、未被占用时）：位置+帧 长时间无变化 → 告警/自动重启 ——
  private _lastStuckX = -1;
  private _lastStuckY = -1;
  private _lastStuckFi = -1;
  private _stuckSince = 0;
  private _stuckWarned = false;

  constructor(config: CharacterConfig, app: PIXI.Application, resolver: SpriteResolver) {
    this.config = config;
    this.container = new PIXI.Container();

    this.container.x = Math.random() * (window.innerWidth - config.size.width);
    this.container.y = this.baselineY();
    Pet.allInstances.push(this);
    slog({ level: 'system', petId: config.id, category: 'pet.lifecycle', cause: 'construct',
      after: { x: this.container.x, y: this.container.y, total: Pet.allInstances.length } });

    // 倾斜节点：包裹 body，绕角色中心旋转实现拖拽晃动（theta=0 时与原本布局完全一致）。
    this.tiltNode = new PIXI.Container();
    this.tiltNode.pivot.set(config.size.width / 2, config.size.height / 2);
    this.tiltNode.position.set(config.size.width / 2, config.size.height / 2);
    this.container.addChild(this.tiltNode);

    this.bodyTex = this.createBodyTexture(app.renderer);
    this.body = new PIXI.Sprite(this.bodyTex);
    this.body.anchor.set(0.5); // 以中心为锚：翻转/倾斜都绕中心，避免偏移与摆动
    this.body.width = config.size.width;
    this.body.height = config.size.height;
    this.body.position.set(config.size.width / 2, config.size.height / 2); // 居中于 tiltNode，theta=0 时与原本布局一致
    // 首帧美术是**异步**加载的（PNG → data URI → PIXI.Assets.load），而占位贴图是同步就绪的。
    // 若一开始就显示占位，开局会有约 1 秒「几块纯色圆角方块在往下掉」（spawnDrop 又恰好在同一时间）。
    // 故先隐藏，等 setAction 的帧集加载 Promise 出结果（applyTexture 里）再显示。
    this.body.visible = false;
    this.tiltNode.addChild(this.body);

    this.bubble = new SpeechBubble(config.bubble);
    this.bubble.container.y = -config.size.height * (config.bubbleOffset ?? 0.35);
    this.bubble.container.x = config.size.width * (config.bubbleOffsetX ?? 0);
    this.container.addChild(this.bubble.container);
    // 异步加载角色专属气泡美术；缺失/失败则保持代码兜底白底气泡
    resolver.loadFrame(config.id, config.bubble?.frameName || 'bubble').then((tex) => {
      this.bubble.setTexture(tex);
    });

    // 异步加载默认动作的美术
    this.lastResolver = resolver;
    this.setAction(config.defaultAction || 'idle', resolver);

    this.setupInteractions();

    // —— 开场掉落：生成瞬间置于屏幕最上方，由重力接管落到地面（播放掉落帧）——
    if (this.config.spawnDrop) {
      this.container.y = 0; // 屏幕顶端（上方还有一截不可见区也无妨，物理会拉回）
      this.spawnFalling = true;
    }
  }

  /** 热重载入口：用新配置重建自身（保留容器位置）。 */
  public applyConfig(newConfig: CharacterConfig, resolver: SpriteResolver) {
    // 复制运行期可变的位置
    const x = this.container.x;
    const y = this.container.y;
    (this as any).config = newConfig;
    this.bubble.container.y = -newConfig.size.height * (newConfig.bubbleOffset ?? 0.35);
    this.bubble.container.x = newConfig.size.width * (newConfig.bubbleOffsetX ?? 0);
    this.container.x = x;
    this.container.y = y;
    // 重新加载当前动作美术
    this.setAction(this.actionId, resolver);
    // 气泡配置/美术可能已变，重新应用
    this.bubble.applyConfig(newConfig.bubble);
    resolver.loadFrame(newConfig.id, newConfig.bubble?.frameName || 'bubble').then((tex) => {
      this.bubble.setTexture(tex);
    });
  }

  private createBodyTexture(renderer: PIXI.Renderer): PIXI.Texture {
    const g = new PIXI.Graphics();
    const w = this.config.size.width;
    const h = this.config.size.height;
    g.roundRect(0, 0, w, h, 12).fill(this.config.colors?.body ?? 0xff8a8a);
    return renderer.generateTexture(g);
  }

  // ============ 动作控制 ============

  /** 不带方向含义的动作（右键菜单随机抽样式用）：这些行为本身已经/会自动决定朝向，
   *  不能按「源图是左朝向」去强制翻转，否则会与行为逻辑打架（如「看对方」「追鼠标」）。 */
  private static readonly DIRECTIONLESS_BEHAVIORS: ReadonlySet<string> = new Set([
    'walk', 'climb', 'ceiling', 'chase', 'fly', 'drag',
  ]);

  /** 随机的默认朝向：源图带方向（行为不自己定朝向）时按水平镜像派生的 left/right 随机取一个。 */
  private randomNaturalFacing(): 'left' | 'right' {
    // 单图角色（无 rightFrames）靠水平翻转表达方向；双套图集（L-/R-）已把方向画在图里。
    // 两者都用同一套 facing 语义：'right' = 面朝屏幕右侧。
    const coin = Math.random() < 0.5;
    return coin ? 'right' : 'left';
  }

  /** 应用「随机朝向」：仅当当前动作不自己决定朝向时生效，否则保持行为推导出的朝向。
   *  必须在 setAction 之后调用（setAction 内 touch 不算，它只算 usingRightFrames 派生量）。 */
  private applyRandomFacing(def: ActionDef) {
    if (Pet.DIRECTIONLESS_BEHAVIORS.has(def.behavior)) return;
    this.setFacing(this.randomNaturalFacing() === 'right');
  }

  /** 切换当前动作并加载其帧贴图。复用/新增同名动作均可。 */
  public setAction(id: string, resolver: SpriteResolver) {
    const def = this.config.actions[id] || this.config.actions[this.config.defaultAction || 'idle'];
    if (!def) {
      console.warn('[Pet] action not found:', id, '-> skip');
      return;
    }
    // —— 合体主演被切走时的兜底释放（2026-10-01 修「配角隐身后没人放回来」）——
    // 主演只要被切到「不是当前合体动作」的任何动作（拖拽、退场、边界攀爬调度、别的相遇…），
    // 它那个合体定时器就失去了意义（甚至可能已被下面的 clearTimeout 清掉），
    // 配角就再也没人负责恢复显形 → 人凭空消失。这里立刻把配角放回来。
    // startCoopLead 自己调 setAction(coopActionId) 时 id === coopActionId，不会误触发。
    if (this.coopLead && id !== this.coopActionId) {
      const follower = this.coopLead;
      this.coopLead = null;
      this.coopActionId = null;
      follower.endCoop(resolver);
    }
    // —— 监管埋点：动作切换前后快照（最高价值溯源点）——
    slog({
      level: 'action',
      petId: this.config.id,
      category: 'action.change',
      cause: id,
      before: { action: this.actionId, facing: this.facingRight, x: this.container.x, y: this.container.y },
      after: { action: id, facing: this.facingRight, x: this.container.x, y: this.container.y, behavior: def.behavior },
      meta: { hasRightFrames: !!def.rightFrames, frames: (def.frames || []).length },
    });
    this.actionId = id;
    this.actionDef = def;
    // 飞行「移动/悬停」相位状态：切动作即复位。新动作若配了 hoverFrames，
    // 由随后的 resetFlySession 重新掷第一段移动时长，不会残留上一个动作的悬停态。
    this.flyHovering = false;
    // 回到待机 → 重新计等待时长。idleMs 在 stepStatic 里每帧累加、且非待机期间也不停，
    // 若不在「进入 defaultAction」这一刻清零，wanderMinDelayMs（动作间最小停留）永远早已满足 →
    // 该配置形同虚设，表现为「上一个动作一结束就无缝接上下一个」。
    if (id === (this.config.defaultAction || 'idle')) this.idleMs = 0;
    // 飞行：切入时初始化目标点
    if (def.behavior === 'fly') {
      this.resetFlySession();
      if (def.flyMode === 'ceiling') {
        // 贴顶飞：先垂直升到屏幕顶端（x 保持当前位置），到达后 stepFly 转入贴顶左右往返
        this.targetPos = { x: this.container.x, y: 0 };
      } else {
        // 自由飞：屏幕内随机 2D 点（偏上半屏）
        const w = this.config.size.width, h = this.config.size.height;
        this.targetPos = {
          x: Math.random() * (window.innerWidth - w),
          y: Math.random() * Math.max(1, (window.innerHeight - h) * 0.7),
        };
      }
    }
    this.frameIdx = 0;
    this.animAccum = 0;
    this.animDone = false;
    // 换动作即作废「还没播到触发帧」的台词：否则上一个动作挂起的话会在新动作的同号帧上冒出来
    this.pendingLine = null;
    this.pendingLineFrame = -1;
    this.pendingLineHold = null;
    this.pendingAdvance = false; // 换动作即作废「等轮末再收尾」的待办，避免跨动作残留
    this.loopRound = 0;

    // 限时动作（如 interact）过期回退默认动作
    if (this.actionTimer !== null) {
      window.clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }

    // 双套图集：注意此处**不**预置 usingRightFrames —— 它由 syncFrameSet 按「当前朝向 + 是否有右套 +
    // 右套是否已加载」实时派生（旧写法在这里算一次就锁死，是「偶发倒着走」的根因，见 syncFrameSet 注释）。
    // 预加载左/右两套帧集（rightFrames 缺省则右套退化为左套）：转向时只需同步切换已加载好的数组，
    // 避免「facingRight 已同步改、actionTextures 异步才到」的窗口 → 偶发倒着走。
    const leftNames = frameNames(def.frames);
    const rightNames = Array.isArray(def.rightFrames) ? frameNames(def.rightFrames) : [];
    const hLeftNames = Array.isArray(def.hoverFrames) ? frameNames(def.hoverFrames) : [];
    const hRightNames = Array.isArray(def.hoverRightFrames) ? frameNames(def.hoverRightFrames) : [];
    // 悬停帧集先清空：动作一切走就不能再沿用上一个动作的 hover 帧（异步加载完成前退回移动帧集）
    this.texHL = [];
    this.texHR = [];
    this.framesPending = true; // 新帧集异步加载期间：syncFrameSet 跳过渲染，保留上一动作末帧
    const myToken = ++this.loadToken;
    const pL = resolver.loadFrames(this.config.id, leftNames);
    const pR = rightNames.length ? resolver.loadFrames(this.config.id, rightNames) : Promise.resolve([] as PIXI.Texture[]);
    const pHL = hLeftNames.length ? resolver.loadFrames(this.config.id, hLeftNames) : Promise.resolve([] as PIXI.Texture[]);
    const pHR = hRightNames.length ? resolver.loadFrames(this.config.id, hRightNames) : Promise.resolve([] as PIXI.Texture[]);
    Promise.all([pL, pR, pHL, pHR]).then(([l, r, hl, hr]) => {
      this.framesPending = false; // 帧集已就绪：解除守卫，下方 syncFrameSet 正常渲染新动作第一帧
      if (myToken !== this.loadToken) return; // 过期加载（动作已切走）直接丢弃，避免覆盖新帧集
      this.texL = l.length ? l : [this.bodyTex];
      this.texR = r.length ? r : this.texL;
      this.texHL = hl.length ? hl : [];       // 未配 hoverFrames → 空，双相位自动关闭
      this.texHR = hr.length ? hr : this.texHL;
      this.artResolved = true; // 首帧美术已出结果（即使为空/失败），此后才允许显示 body
      this.syncFrameSet();
    });
    this.syncFrameSet(); // 缓存命中即时生效；否则沿用上一动作帧，待上面 Promise 完成再切
  }

  /** 离开「相遇/合体」等会把 Y 拉高的状态、回到地面动作时，贴回屏幕下沿。
   *  注意：只在这些出口调用，绝不在 setAction 全局动作切换点调用——
   *  否则每只宠物每次切动作都会被钉回 baselineY（表现为「所有人物位置被强制刷新」）。 */
  private settleToBaselineIfGround() {
    const nextDef = this.config.actions[this.config.defaultAction || 'idle'];
    if (nextDef && nextDef.behavior !== 'climb' && nextDef.behavior !== 'drag') {
      this.container.y = this.baselineY();
    }
  }

  /** 触发一个（通常是限时的）交互动作，如相遇。forcedLine 优先于动作自带 dialogue。
   *  时长优先级：调用方传入 > 动作级 durationMs > 角色级 interactionDuration。 */
  public startAction(id: string, resolver: SpriteResolver, durationMs?: number, forcedLine?: string) {
    if (this.isDragging) return;
    this.walkArriveCb = null; // 任何新动作取消「走向目标」态（到达回调作废）
    const def = this.config.actions[id];
    if (!def) return;
    // 任何动作切换都先清相遇阶段（避免菜单手动动作残留 approaching 标记）
    this.meetPhase = 'none';
    this.meetPartner = null;
    (this as any)._pendingIsPair = undefined; // 切动作即放弃配对标记（配对占用在 triggerPairedAction 中重新置位）
    // 进入交互前先按 partner 算好朝向（截图高发区：避免第一帧用错向）
    if (def.facePartner) this.faceTowardPartner();
    this.setAction(id, resolver);
    // 位移类动作需要「目标点」才能动起来：自动漫游走 requestAction（内部已设好），
    // 但菜单路径在这里补一次同款初始化，否则点「边缘攀爬」会因 targetPos 陈旧而当场结束（点了没反应）。
    const beh0 = def.behavior;
    if (beh0 === 'walk' || beh0 === 'climb' || beh0 === 'ceiling' || beh0 === 'chase' || beh0 === 'fly') {
      if (beh0 === 'climb') this.climbSessionActive = false; // 手动触发 = 全新会话，重置 20s 计时
      this.setupPositionalTarget(id);
    }
    // 用户从右键菜单点了「动作组一级条目」→ 随机一个自然朝向（左右各 50%）。
    // 放在 setAction 之后：此时帧集已按新朝向重选完毕，不会出现「翻了一半」的中转帧。
    // 自动漫游路径不置位该标志，行为完全不受影响。
    if (this.randomFacingNext) {
      this.randomFacingNext = false;
      this.applyRandomFacing(def);
    }
    this.idleMs = 0;
    this.chaseMs = 0;
    const line = forcedLine ?? (def.dialogue && def.dialogue.length > 0
      ? this.rand(def.dialogue.filter((s) => s && s.trim().length > 0)) // 过滤空字符串项：空台词不显示
      : undefined);
    if (line) {
      // 配了 dialogueFrame 且是多帧动作 → 台词挂起，等播到指定帧再说（如钓鱼在倒数第三帧才开口）
      if (typeof def.dialogueFrame === 'number' && frameNames(def.frames || []).length > 1) {
        this.queueDialogue(line, def, durationMs);
      } else {
        this.bubble.show(line, this.estimateActionMs(def, durationMs)); // 未配 → 旧行为：动作一开始就显示
      }
    }
    this.scheduleActionEnd(resolver, durationMs);
  }

  /** 统一的「按时长收尾」调度 —— **所有**设完动作的路径都必须走这里（startAction / requestAction）。
   *
   *  【历史 bug · P0】durationMs 原先只在 startAction 里被转成定时器，而 wander 池的动作
   *  （sit / walk / fly / climb 等）走的是 requestAction → setAction 路径，全程没人读 durationMs →
   *  sit（单帧 static，唯一靠 durationMs 结束的动作）被抽中后没有任何终止机制，
   *  会一直坐着直到用户手动拖拽/右键打断 —— 即「卡在坐下很久」。
   *
   *  时长语义（数据驱动，三个值三种含义）：
   *    > 0      → 到期收尾（轮末对齐，不硬切动画）
   *    === 0    → 外部事件驱动 or 动画自身收尾（idle/fall/drag、loopCount/loop:false 多帧动作），不挂定时器
   *    undefined→ 见下：有自终止能力就不挂；否则回退「单帧保持时长」并告警（防未来新增动作再踩同一个坑）
   */
  private scheduleActionEnd(resolver: SpriteResolver, override?: number) {
    if (this.actionTimer !== null) {
      window.clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
    const def = this.actionDef;
    let dur = override ?? def.durationMs;
    if (dur === undefined && !this.hasSelfTermination(def)) {
      dur = Pet.STATIC_HOLD_FALLBACK_MS;
      console.warn(`[Pet] 动作 "${this.actionId}" (${this.config.id}) 缺少 durationMs 且无自终止能力，`
        + `回退 ${dur}ms（请在 config/actions/${this.config.id}.json 里显式声明）`);
    }
    if (typeof dur !== 'number' || dur <= 0) return; // 0 = 播完即收尾，交给 animDone / 行为逻辑
    this.actionTimer = window.setTimeout(() => {
      this.actionTimer = null;
      this.meetPhase = 'none';
      this.meetPartner = null;
      // 轮末对齐：动画还在播时不硬切，等 tickAnimation 播到末帧/轮末再收尾，
      // 否则会出现「头摇到一半定住」「种花种到一半站起」这类被截断的观感。
      // 用户主动打断（拖拽/右键/相遇/落地）不走这里，仍保持即时响应。
      if (this.shouldWaitRoundEnd()) {
        this.pendingAdvance = true;
        this.pendingAdvanceAt = performance.now();
        return;
      }
      this.advanceAfterAction(resolver);
    }, dur);
  }

  /** 该动作是否「不需要 durationMs 也能自己结束」：
   *  - 位移类：由 stepWalk/Climb/Ceiling/Chase/Fly 的到达/换目标逻辑收尾
   *  - drag：由用户松手收尾
   *  - 多帧且（非循环 或 声明了 loopCount）：播完末帧/达轮数上限时置 animDone 收尾
   *  单帧 static 动作（sit 这类）不在其中 —— 它必须靠 durationMs，否则会永久卡住。 */
  private hasSelfTermination(def: ActionDef): boolean {
    const beh = def.behavior;
    if (beh === 'walk' || beh === 'climb' || beh === 'ceiling' || beh === 'chase' || beh === 'fly') return true;
    if (beh === 'drag') return true;
    const n = frameNames(def.frames).length;
    if (n > 1 && (def.loop === false || (typeof def.loopCount === 'number' && def.loopCount > 0))) return true;
    return false;
  }

  /** 估算动作的实际持续时长(ms)，用于对话气泡的显示时长。
   *  注意 durationMs:0 的语义是「播完这一轮自然收尾」，**不等于 0 毫秒**——
   *  直接拿它当气泡时长会让台词闪一下就消失（如相遇时的「妮娜！」）。
   *  所以这里按「帧数 × 帧时长 × 轮数」反推真实时长。 */
  private estimateActionMs(def: ActionDef, override?: number): number {
    if (typeof override === 'number' && override > 0) return override;
    if (typeof def.durationMs === 'number' && def.durationMs > 0) return def.durationMs;
    // ⚠️ 必须逐帧累加（perFrameMs），不能用「帧数 × frameMs」：
    //    帧对象自带 ms 的动作（如 mona/cookMilk 尾补 8000ms）会被严重低估
    //    （7 帧 × 700 = 4900ms，真实 13500ms），台词气泡会在动作播到一半时提前消失。
    const n = def.frames?.length || 1;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.perFrameMs(def, i);
    const rounds = def.loop === false
      ? 1
      : (typeof def.loopCount === 'number' && def.loopCount > 0 ? def.loopCount : 1);
    const ms = Math.round(sum * rounds);
    return ms > 0 ? ms : (this.config.interactionDuration ?? 3000);
  }

  // ============ 帧驱动的台词（动作级 dialogueFrame）============

  /** 帧号归一化：正数 = 从头数（0-based）；负数 = 从末帧倒数（-1 末帧、-3 倒数第三帧）；越界夹到 [0, n-1]。
   *  推荐写负数——以后给动作加/减帧，不用回头改这个数字。 */
  private resolveDialogueFrame(raw: number, n: number): number {
    const idx = raw < 0 ? n + raw : raw;
    return Math.min(Math.max(idx, 0), Math.max(0, n - 1));
  }

  /** 该帧没写 ms 时的兜底帧时长（动作级 frameMs > speed）。 */
  private perFrameMs(def: ActionDef, i: number): number {
    const own = frameMs(def.frames || [], i);
    if (own !== null) return own;
    const fps = (def.speed ?? 0.1) * 60;
    return typeof def.frameMs === 'number' && def.frameMs > 0 ? def.frameMs : 1000 / Math.max(1, fps);
  }

  /** 台词挂起：等到播到 dialogueFrame 指定的那一帧再弹。
   *  循环动作也只弹一次（弹完即清空 pendingLine）。 */
  private queueDialogue(line: string, def: ActionDef, durationMs?: number) {
    const n = frameNames(def.frames || []).length;
    const idx = this.resolveDialogueFrame(def.dialogueFrame as number, n);
    if (idx <= 0) { // 目标就是首帧 → 与「立即显示」等价，走老算法
      this.bubble.show(line, this.estimateActionMs(def, durationMs));
      return;
    }
    this.pendingLine = line;
    this.pendingLineFrame = idx;
    this.pendingLineHold = this.remainingDialogueMs(def, idx, durationMs);
  }

  /** 台词从「第 fromFrame 帧」开始该显示多久：默认 = 该帧到动作结束的剩余时长
   *  （对话气泡跟着动作走完，不会早退也不会拖到下一个动作）；`dialogueHoldMs` 可强制覆盖。 */
  private remainingDialogueMs(def: ActionDef, fromFrame: number, durationMs?: number): number {
    if (typeof def.dialogueHoldMs === 'number' && def.dialogueHoldMs > 0) return def.dialogueHoldMs;
    const n = (def.frames || []).length;
    let elapsed = 0;   // 触发帧之前已播的时长
    let remaining = 0; // 触发帧到末帧的时长
    for (let i = 0; i < n; i++) {
      const ms = this.perFrameMs(def, i);
      if (i < fromFrame) elapsed += ms; else remaining += ms;
    }
    // 动作被限时收尾（durationMs / 调用方 override）时，真正的终点是那个时刻，按它算剩余
    const cap = typeof durationMs === 'number' && durationMs > 0
      ? durationMs
      : (typeof def.durationMs === 'number' && def.durationMs > 0 ? def.durationMs : 0);
    if (cap > 0) remaining = cap - elapsed;
    return Math.max(remaining, 600); // 兜底：再短也让台词露出 600ms，避免一闪而过
  }

  /** 每帧检查：播到指定帧就弹出挂起的台词（在 update 里紧跟 tickAnimation 调用）。
   *  放在 tickAnimation 外是为了绕开它内部的多处 return（轮末收尾/animDone 都会提前退出）。 */
  private tickPendingDialogue() {
    if (this.pendingLine === null) return;
    if (this.frameIdx !== this.pendingLineFrame) return;
    const line = this.pendingLine;
    const hold = this.pendingLineHold ?? 0;
    this.pendingLine = null;         // 先清：循环动作不会第二轮再念一遍
    this.pendingLineFrame = -1;
    this.pendingLineHold = null;
    this.bubble.show(line, hold > 0 ? hold : undefined);
  }

  /** 定时器到期时是否要「等当前这一轮播完」再收尾：多帧动画且还没播到末帧/轮末 → 等。
   *  单帧动作（如 sit）没有可截断的中间态，立即收尾。 */
  private shouldWaitRoundEnd(): boolean {
    const n = this.actionTextures.length;
    if (n <= 1 || this.animDone) return false;
    if (!this.actionDef.loop) return this.frameIdx < n - 1; // 一次性动画：等到末帧（下一 tick 即置 animDone）
    return true; // 循环动画：等当前轮播完（tickAnimation 在回绕处消费 pendingAdvance）
  }

  /** 动作结束（时长到期 / 非 loop 播完）后的接续：next 序列优先（权重随机），否则回默认动作。
   *  next 里的位移类（walk/climb/ceiling/chase）走 requestAction 设目标点，其余走 startAction。 */
  private advanceAfterAction(resolver: SpriteResolver) {
    // 相遇/配对动作「自然收尾」（animDone 路径，无 durationMs 定时器）必须在此释放相遇占用：
    // 否则 meetPhase 停在 'interacting'，下一帧 update 的 isMeetBusy 把 wander 卡死（两人原地不动）。
    // 配对动作 eat/sing/cookMilk 均为 durationMs=0 的 static，靠 animDone 收尾而非定时器，
    // 而 setAction 不清 meetPhase（仅 startAction/scheduleActionEnd 定时器会清），故这里补一道释放。
    // 普通 interact（正 durationMs）的定时器已在到点时清过，这里再清一次幂等、对纯漫游序列无害。
    if (this.meetPhase !== 'none') {
      this.meetPhase = 'none';
      this.meetPartner = null;
    }
    const next = this.actionDef?.next;
    if (next && next.length > 0 && this.chainDepth < 8) {
      const pick = weightedPick(next);
      const ndef = pick ? this.config.actions[pick] : undefined;
      if (pick && ndef) {
        this.chainDepth++;
        if (ndef.behavior === 'walk' || ndef.behavior === 'climb' || ndef.behavior === 'ceiling' || ndef.behavior === 'chase') {
          this.requestAction(pick);
        } else {
          this.startAction(pick, resolver);
        }
        return;
      }
    }
    this.chainDepth = 0;
    this.climbSessionActive = false; // 动作收尾离开攀爬 → 会话结束，下次上墙重新获得完整 climbMaxMs 预算
    this.settleToBaselineIfGround();
    this.canTrip = true; // 动画结束、站起后重新允许下次摔倒
    this.setAction(this.config.defaultAction || 'idle', resolver);
  }

  public get currentActionId(): string { return this.actionId; }
  /** 当前 body 显示宽度（合体帧比单人宽，供 app 吸附定位用）。 */
  public bodyWidth(): number { return this.body.width; }
  public isInteracting(): boolean {
    // 配对动作（另一种合体）播的是 eat/sing/cookMilk 而非 interact，但占用态同样是「互动中」，
    // 需让 app.ts 的 maintainSnap 维持脸对脸；否则两人各播各的会背对/侧身。
    return this.actionId === (this.config.interactAction || 'interact') || this.meetPhase === 'interacting';
  }
  /** 配对/合体落位后按「左位→朝右、右位→朝左」强制朝向（maintainSnap 调用），保证面对面。
   *  绕开直接赋值 facingRight 的历史坑：统一走 setFacing 让 facingRight/帧集/翻转三者一致。 */
  public setFacingDir(right: boolean) {
    this.setFacing(right);
  }
  public isDraggingAction(): boolean { return this.isDragging; }

  // —— 相遇阶段查询 ——
  public get meetState(): 'none' | 'approaching' | 'interacting' { return this.meetPhase; }
  public isApproaching(): boolean { return this.meetPhase === 'approaching'; }
  /** 是否处于相遇占用态（走近中或演关键帧），用于调度排除与 climb 边界屏蔽 */
  public isMeetBusy(): boolean { return this.meetPhase !== 'none'; }
  /** 仅在「默认站立(defaultAction) 或 走动(walkAction)」时才可能触发靠近。
   *  必须按 actionId 判而非 behavior：eat/sing/sit/read/creep 等菜单动作同样 behavior:'static'/'walk'，
   *  按 behavior 判会把它们误判成空闲，导致这些占用动作播到一半就被相遇打断。
   *  与 stepStatic 里「只有 defaultAction 才考虑 wander」的判定保持同一套语义。 */
  public isIdleOrWalk(): boolean {
    if (this.isMeetBusy() || this.isDraggingAction()) return false;
    const aid = this.actionId;
    return aid === (this.config.defaultAction || 'idle') || aid === (this.config.walkAction || 'walk');
  }
  /** 是否正在走向某个目标点（walkToX 进行中、尚未到达）：app.ts 的边缘攀爬调度据此让行，
   *  避免「走到一半被抢去贴墙爬」导致目标永远到不了。 */
  public get isWalkingToTarget(): boolean { return this.walkArriveCb !== null; }
  public getMeetPartner(): Pet | null { return this.meetPartner; }

  /** 进入「走近」阶段：朝对方走过去（复用 walk 动作），到足够近由 app 切 interact。 */
  public startApproach(partner: Pet, resolver: SpriteResolver) {
    if (this.isDragging || this.meetPhase !== 'none') return;
    this.meetPhase = 'approaching';
    this.meetPartner = partner;
    this.faceToward(partner); // 进入前先面向对方，避免首帧错向
    const aid = this.config.approachAction || this.config.walkAction || 'walk';
    this.setAction(aid, resolver);
    this.idleMs = 0;
  }

  /** 切换到「演关键帧」阶段（相遇事件本体）。 */
  public startInteract(partner: Pet, resolver: SpriteResolver, durationMs?: number, forcedLine?: string) {
    if (this.isDragging) return;
    this.meetPhase = 'interacting';
    this.meetPartner = partner;
    this.startAction(this.config.interactAction || 'interact', resolver, durationMs, forcedLine);
  }

  /** 配对动作（另一种「合体」）的「到位后」入口：播**自己的**动作、面向对方、标记占用使 maintainSnap 维持脸对脸。
   *  与 startInteract 区别：startInteract 双方播同一 interact；这里每人播各自不同的动作（莫娜做奶冻、妮娜吃）。 */
  public playPairedAction(partner: Pet, actionId: string, resolver: SpriteResolver) {
    if (this.isDragging) return;
    this.startAction(actionId, resolver); // startAction 内部会清 meetPhase/meetPartner，下方重新置位
    this.setFacing(partner.container.x > this.container.x); // 面向对方：对方在右则朝右
    this.meetPhase = 'interacting';
    this.meetPartner = partner;
  }

  /** 取消相遇阶段（被打断/对方消失时）。
   *  opts.skipSettle=true 用于「被鼠标拎起」路径：角色即将由拖拽接管位置，绝不 settleToBaseline，
   *  否则攀爬中（behavior==='climb' 使 physicsActive 返回 false）会被强制钉回屏幕底，重现半空接住 bug。 */
  public cancelMeet(resolver: SpriteResolver, opts?: { skipSettle?: boolean }) {
    this.meetPhase = 'none';
    this.meetPartner = null;
    (this as any)._pendingIsPair = undefined; // 清理配对标记，避免取消后残留导致下次误走配对分支
    // 下落中（含被接住瞬间）：不把角色瞬移到底，位置由物理/拖拽接管；否则空中角色被钉到屏幕最底边
    if (!opts?.skipSettle && !this.physicsActive()) this.settleToBaselineIfGround();
    this.setAction(this.config.defaultAction || 'idle', resolver);
  }

  // ============ 合体合作动作（如拥抱）============
  // 模型：合体帧（如 hug）里已包含两人，由 lead 方承载播放该帧；
  // follow 方（合体帧里被画进去的另一人）visible=false 让位，但位置跟随主演，避免显形瞬移。

  public isCoopLead(): boolean { return this.coopLead !== null; }
  public isCoopFollow(): boolean { return this.coopFollow !== null; }
  /** 是否正处于「合体/配对」占用中（主演或隐身配角）：用于全局「同时只能有一组合体」互斥锁。 */
  public isInCoop(): boolean { return this.coopLead !== null || this.coopFollow !== null; }
  /** 返回当前合体搭档（主演→配角 / 配角→主演），供 app.ts 的 coop 吸附循环识别成对。 */
  public getCoopPartner(): Pet | null { return this.coopLead ?? this.coopFollow; }
  /** 合体帧是否仍在异步加载中（setAction 后置位、帧集 Promise 完成后清除）。
   *  期间 syncFrameSet 会保留「上一动作末帧」，故此时摆位会把旧帧画在合体位 → 触发瞬间「闪一下」。
   *  调用方（app.ts 的 coop 吸附循环）应据此延迟摆位，等合体帧就绪再一次性摆正。 */
  public isFramesPending(): boolean { return this.framesPending; }

  /** 作为「主演」承载合体动作：播放合体帧（lead 帧），按 flip 决定左右翻转。
   *  **返回值至关重要**（2026-10-01 修「配角隐身后没人释放、人凭空消失」）：
   *  false = 没进成合体态（动作不存在 / 不是 coop）。调用方**必须**据此决定是否让配角隐身——
   *  旧写法无条件 `other.startCoopFollow(leadPet)`，主演这边一旦提前 return，配角就永远隐身。 */
  public startCoopLead(actionId: string, resolver: SpriteResolver, partner: Pet, durationMs?: number, forcedLine?: string): boolean {
    const def = this.config.actions[actionId];
    if (!def || !def.coop) return false;
    this.coopLead = partner;
    this.coopFollow = null;
    this.coopActionId = actionId;
    this.meetPhase = 'none';
    this.meetPartner = null;
    this.setAction(actionId, resolver);
    // 合体帧朝向：flip 字段控制水平翻转（应对左右占位），默认不翻
    this.setFacing(!!def.flip);
    this.applyFacing(); // setFacing 同值时短路，这里兜一次保证 scale 与当前朝向一致
    const line = forcedLine ?? (def.dialogue && def.dialogue.length > 0
      ? this.rand(def.dialogue.filter((s) => s && s.trim().length > 0)) : undefined);
    if (line) this.bubble.show(line, this.estimateActionMs(def, durationMs));
    // 合体时长（2026-10-01 修）：调用方没给明确时长时，**按动画实际帧长反推**，不再回退
    // 角色级 interactionDuration(3500)。合照帧配的是 durationMs:0 + loopCount:1（播完一轮即收尾），
    // 用固定 3500 会把 7~12 帧 ×800ms 的合照拦腰截断（旧 bug：拥抱/合体只播一半两人就散开）。
    const dur = (typeof durationMs === 'number' && durationMs > 0)
      ? durationMs
      : this.estimateActionMs(def, undefined);
    if (dur && dur > 0) {
      this.actionTimer = window.setTimeout(() => {
        this.actionTimer = null;
        // ⚠️ 顺序：先释放配角，再切自己的动作。
        // endCoop 要把配角摆到 lead 右侧、y 对齐 lead，必须读到「合体结束时」的 lead 坐标；
        // 反过来先切动作+沉降会让配角被摆到已经变了的位置（且万一 setAction 里出岔子，配角就再没人放了）。
        this.coopLead?.endCoop(resolver);
        this.coopLead = null;
        this.coopActionId = null;
        // 再让 lead 自己回到地面、切回默认动作
        this.settleToBaselineIfGround();
        this.setAction(this.config.defaultAction || 'idle', resolver);
      }, dur);
    }
    return true;
  }

  /** 作为「配角」让位：隐身，位置跟随主演。
   *  ⚠️ 调用前必须先确认主演 `startCoopLead` 返回 true，否则没人负责把配角放回来。
   *  另外这里**切回默认动作**：合体前配角正处在 approach 的 walk 上，若保持 walk，
   *  app.ts 的「边界攀爬」调度会在它贴边时把隐身的它切去爬墙，位置被物理接管，收尾时摆位就乱了。 */
  public startCoopFollow(lead: Pet) {
    this.coopFollow = lead;
    this.coopLead = null;
    this.meetPhase = 'none';
    this.meetPartner = null;
    this.setAction(this.config.defaultAction || 'idle', this.lastResolver);
    this.container.visible = false;
  }

  /** 结束合体：恢复显形并回到默认动作。
   *  配角（coopFollow 指向 lead）恢复显形后**直接留在 app.ts maintainCoopSnap 每帧摆好的「右槽」上**，
   *  与「吃奶冻」(cookIce/eatFromMona) 收尾两人自然并排完全同构 —— 无跳变、不重叠。
   *  ⚠️ 这里**不再重算坐标**：旧写法用带 `-selfSizeW/2` 的错公式把配角摆到 lead.x+14，
   *  两人叠在一起（占位 bug）。位移到「右槽」已由每帧吸附循环负责，收尾只做显形 + 回默认 + 朝对方。 */
  public endCoop(resolver: SpriteResolver) {
    const lead = this.coopFollow;
    if (lead) {
      this.coopFollow = null;
      this.container.visible = true;
      // 收尾姿态：lead 在左朝右、配角在右朝左，保证两人面朝对方（与 maintainSnap 同思路）。
      // 坐标保持 maintainCoopSnap 已摆好的位置，不重算。
      lead.setAction(lead.config.defaultAction || 'idle', resolver);
      this.setAction(this.config.defaultAction || 'idle', resolver);
      lead.setFacing(true);   // lead 在左 → 朝右看向右侧配角
      this.setFacing(false);  // 配角在右 → 朝左看向左侧 lead
    }
    if (this.coopLead) {
      this.coopLead = null;
      this.setAction(this.config.defaultAction || 'idle', resolver);
    }
  }

  /** 拖起 / 强行打断时退出合体占用态，并清反向引用：否则 coopLead 残留会让松手后
   *  重力永远不接管（physicsActive 在 coopLead 置位时 return false），角色悬在松手点半空不掉。 */
  private exitCoopAndMeet(resolver: SpriteResolver, skipSettle = false) {
    if (this.coopLead) {            // 我是主演：释放配角
      this.coopLead.endCoop(resolver);
      this.coopLead = null;
      this.coopActionId = null;
    }
    if (this.coopFollow) {          // 我是配角：恢复显形并清主演反向引用
      this.coopFollow.coopLead = null;
      this.coopFollow.coopActionId = null;
      this.coopFollow = null;
      this.container.visible = true;
    }
    this.cancelMeet(resolver, { skipSettle });
  }

  /** 合体期间：配角跟随主演。
   *  ⚠️ 坐标不再在这里复制（旧写法把配角直接叠到主演容器上，会与 app.ts 的 coop 吸附循环打架、
   *  导致「收尾时配角被摆回 lead 身上重叠」）。配角的「右槽」摆位由 app.ts 的 maintainCoopSnap
   *  每帧统一处理（与 maintainSnap 同思路）。此处仅保留自愈兜底（见 update 调用点），不做坐标移动。 */
  public followCoopLead() {
    // 位置由 app.ts 的 coop 吸附循环统一摆位，此处不移动。
  }

  // ============ 轻触对话 ============

  private rand(arr: string[]) { return arr[Math.floor(Math.random() * arr.length)]; }

  // ============ 贴图应用 ============

  private applyTexture() {
    const tex = this.actionTextures[Math.min(this.frameIdx, this.actionTextures.length - 1)];
    const hasArt = tex !== this.bodyTex;
    this.body.texture = tex;
    this.body.tint = hasArt ? 0xffffff : this.body.tint;
    // 首帧美术加载出结果前不显示（否则开局会看到占位色块，见构造函数注释）；
    // 出结果后即使美术缺失（tex 仍是占位）也显示 —— 保留「美术缺失」的可诊断性。
    this.body.visible = this.artResolved;
    this.applySpriteSize(tex);
    this.applyFacing();
  }

  /** 显示尺寸按「contain 等比适配」：在「高度锚定 targetH」与「宽度不超过 maxW」两个约束下取较小缩放，
   *  保证 texture 真实宽高比不被破坏（永不横向/纵向拉伸）。常用于比角色框更宽的合体帧(如 interact 221x150)。
   *  非 offset 帧：水平居中于角色框、脚贴容器底边(站立贴地)，防止较矮的合体/飞行帧悬空。
   *  动作级 offset：body 基准位置(容器中心)的显示偏移(px)，用于倒挂帧等锚点差异补偿。 */
  private applySpriteSize(tex: PIXI.Texture) {
    const targetH = this.actionDef.height ?? this.config.size.height;
    const maxW = this.actionDef.width ?? this.config.size.width;
    const srcW = tex.width || maxW;
    const srcH = tex.height || targetH;
    if (srcH <= 0) {
      this.body.width = maxW;
      this.body.height = targetH;
      this.body.position.set(this.config.size.width / 2, targetH - targetH / 2);
      return;
    }
    // contain-fit：取「按高度缩放」与「按宽度缩放」的较小值 → 任一方向都不超出约束，宽高比守恒。
    // 若当前帧显式写了 scale，则直接采用该缩放系数（用于修正个别帧因画布变宽被压小的问题）。
    const frameList = this.activeFrames();
    const fs = frameScale(frameList, this.frameIdx);
    const scale = typeof fs === 'number' ? fs : Math.min(targetH / srcH, maxW / srcW);
    this.body.width = srcW * scale;
    this.body.height = srcH * scale;
    const off = this.actionDef.offset;
    if (off) {
      const w = this.config.size.width;
      const h = this.config.size.height;
      this.body.position.set(w / 2 + (off.x ?? 0), h / 2 + (off.y ?? 0));
    } else {
      // 脚贴地：body 底边对齐容器底边(targetH)，水平居中于角色框(size.width)
      this.body.position.set(this.config.size.width / 2, targetH - this.body.height / 2);
    }
  }

  /** 按当前朝向翻转 body。
   *  - 右朝向图集(usingRightFrames)：方向已画在图里，永不翻转(scale.x=1)。
   *  - 左朝向图集：按 facingRight 水平翻转（默认行为，兼容旧单图角色）。 */
  private applyFacing() {
    this.body.scale.x = this.usingRightFrames ? 1 : (this.facingRight ? -1 : 1);
  }

  /** 按当前朝向同步当前显示的帧集：双套已加载则瞬时切换 L/R，无异步空窗、不重置动画帧序。
   *  仅在 setAction 预加载完成后、或朝向翻转（setFacing）时调用。右套未就绪时回退左套，避免空白帧。
   *
   *  【单一真相源】usingRightFrames 必须是 facingRight 的**派生量**，不是独立缓存状态：
   *  旧写法只在 setAction 里按「进入动作那一刻的 facingRight」算一次，之后所有运行时转向
   *  （walkFacing / faceToward / 抛出朝向）只改 facingRight、不更新 usingRightFrames →
   *  一旦进入动作时朝右，整个动作期间就被锁死在右图集且不翻转，
   *  表现为「往左走/往左飞却朝右」的偶发倒着走（命中率 ≈ 进入动作时朝右的概率）。 */
  private syncFrameSet() {
    const def: ActionDef | undefined = this.actionDef;
    // 飞行悬停相位：改用 hoverFrames 帧集。texHL 为空（未配 hoverFrames）时自动退回移动帧集，
    // 于是「没配悬停帧的角色」走的是与改动前完全相同的分支，零影响。
    const useHover = this.flyHovering && this.texHL.length > 0;
    const hasRight = !!def && (useHover
      ? (Array.isArray(def.hoverRightFrames) && def.hoverRightFrames.length > 0)
      : (Array.isArray(def.rightFrames) && def.rightFrames.length > 0));
    const leftArr = useHover ? this.texHL : this.texL;
    const rightArr = useHover ? this.texHR : this.texR;
    // 右套还没加载完 → 回退左套 + 镜像翻转（applyFacing 会翻），视觉方向仍然正确，不会空白帧
    this.usingRightFrames = !!(this.facingRight && hasRight && rightArr.length > 0);
    const arr = this.usingRightFrames
      ? rightArr
      : (leftArr.length ? leftArr : [this.bodyTex]);
    // 两套帧集帧数可能不同（如移动 2 帧 / 悬停 2 帧，但也能是 3 帧）：越界时回到首帧，避免取到 undefined 贴图
    if (this.frameIdx >= arr.length) this.frameIdx = 0;
    this.actionTextures = arr;
    if (this.framesPending) return; // 切换动作且新帧集未就绪：保留上一动作末帧，避免收尾瞬间闪回第一帧
    this.applyTexture(); // 内部先 applySpriteSize（会重算 scale.x）再 applyFacing，翻转不会被尺寸计算抹掉
  }

  /** 当前实际生效的帧定义列表（逐帧 ms / vx / vy / scale 都从这里读）。
   *  飞行悬停相位用 hoverFrames(hoverRightFrames)；其余沿用「右套优先、否则左套」的旧语义。 */
  private activeFrames(): FrameRef[] {
    const def = this.actionDef;
    const useHover = this.flyHovering && this.texHL.length > 0;
    if (useHover) {
      if (this.usingRightFrames && Array.isArray(def.hoverRightFrames)) return def.hoverRightFrames;
      if (Array.isArray(def.hoverFrames)) return def.hoverFrames;
    }
    return this.usingRightFrames && Array.isArray(def.rightFrames) ? def.rightFrames : def.frames;
  }

  /** 切换飞行「移动/悬停」相位并同步帧集（状态没变就不做无谓的贴图重算）。 */
  private setFlyHovering(v: boolean) {
    if (this.flyHovering === v) return;
    this.flyHovering = v;
    this.syncFrameSet(); // 相位切换 = 帧集切换（flymoving ↔ fly）
  }

  /** 飞行相位的随机时长(ms)：移动段取 flyMoveMinMs~flyMoveMaxMs，悬停段取 flyHoverMinMs~flyHoverMaxMs。
   *  缺省值对齐旧桌宠的观感：飞 1.5~3.5s 停 0.5~1.6s。 */
  private randFlyPhaseMs(hover: boolean): number {
    const d = this.actionDef;
    const lo = hover ? (d.flyHoverMinMs ?? 500) : (d.flyMoveMinMs ?? 1500);
    const hi = hover ? (d.flyHoverMaxMs ?? 1600) : (d.flyMoveMaxMs ?? 3500);
    return Math.max(0, lo) + Math.random() * Math.max(0, hi - lo);
  }

  /** 是否启用了飞行「移动 / 悬停」双相位（= 动作配了 hoverFrames）。
   *  它是「对齐旧桌宠节奏」的总开关：自由飞的中途停顿、贴顶飞的中途抓稳 + 随机目标点都由它驱动。
   *  没配的角色走改动前的老路径，行为完全不变。
   *  用**配置**判断而非 texHL：贴图是异步加载的，配置判断才是确定性的。 */
  private get flyDualPhase(): boolean {
    const d = this.actionDef;
    return !!d && Array.isArray(d.hoverFrames) && d.hoverFrames.length > 0;
  }

  /** 推进飞行双相位：到点翻转（移动 ↔ 悬停）并重掷一段随机时长。
   *  未配 hoverFrames 时直接返回 —— 双相位关闭，行为与旧版一致。 */
  private tickFlyPhase() {
    if (!this.flyDualPhase) return;
    if (performance.now() < this.flyPhaseUntil) return;
    this.setFlyHovering(!this.flyHovering);
    this.flyPhaseUntil = performance.now() + this.randFlyPhaseMs(this.flyHovering);
  }

  /** 改朝向的唯一入口：所有「运行时转向」都必须走这里，保证 facingRight 与帧集/翻转三者一致。
   *  直接赋值 this.facingRight 是历史 bug 的根源（见 syncFrameSet 注释），禁止新增此类写法。 */
  private setFacing(right: boolean) {
    if (right === this.facingRight) return;
    this.facingRight = right;
    this.syncFrameSet();
    slog({
      level: 'action',
      petId: this.config.id,
      category: 'facing.change',
      cause: right ? 'right' : 'left',
      before: { action: this.actionId },
      after: { usingRightFrames: this.usingRightFrames, texL: this.texL.length, texR: this.texR.length },
    });
  }

  /** 帧动画推进：loop 动作循环播放；非 loop 动作一次性播放到末帧后停在末帧（animDone 置位，
   *  由 update 触发 next 序列）。逐帧时长：帧写法为 {name, ms} 时用独立时长，否则用动作级 speed。 */
  private tickAnimation(dtMs: number) {
    if (this.actionTextures.length <= 1) return;
    // 拖拽且当前动作含多帧倾斜帧：帧由 updateDragTilt 按鼠标偏移手动选取，不走自动循环
    if (this.isDragging && this.actionTextures.length >= 3) return;
    const frames = this.activeFrames();
    const perFrame = frameMs(frames, this.frameIdx);
    const fps = (this.actionDef.speed ?? 0.1) * 60;
    const interval = perFrame !== null
      ? perFrame
      : (typeof this.actionDef.frameMs === 'number' && this.actionDef.frameMs > 0
        ? this.actionDef.frameMs
        : 1000 / Math.max(1, fps));
    // 关键修复：单帧 dt 不超过当前帧时长。否则遇到卡顿/掉帧（dt 突变偏大）时，
    // animAccum 会一次性超过 interval 很多，而下方每 tick 只前进 1 帧却只减掉 1 个 interval，
    // 剩余累加量在后续 tick 被“快速追帧” → 表现为后面的帧被跳过/看不清。
    // 夹住后：任何卡顿只会让动画暂停，不会丢失中间帧。
    const d = Math.min(dtMs, interval);
    this.animAccum += d;
    if (this.animAccum < interval) return;
    this.animAccum -= interval;
    if (this.actionDef.loop) {
      const isLast = this.frameIdx >= this.actionTextures.length - 1;
      this.frameIdx = (this.frameIdx + 1) % this.actionTextures.length;
      if (isLast) {
        this.loopRound += 1;
        const lc = this.actionDef.loopCount;
        // 已达循环轮数上限：回退到末帧并定格，置 animDone 走 next / 回默认（与 loop:false 收尾一致）
        if (typeof lc === 'number' && lc > 0 && this.loopRound >= lc) {
          this.frameIdx = this.actionTextures.length - 1;
          const tex = this.actionTextures[this.frameIdx];
          this.body.texture = tex;
          this.applySpriteSize(tex);
          this.animDone = true;
          return;
        }
        // 轮末：定时器早已到期 → 这一轮播完整了，此时收尾（不切断动画）
        if (this.pendingAdvance) {
          this.pendingAdvance = false;
          this.advanceAfterAction(this.lastResolver);
          return;
        }
      }
    } else if (this.frameIdx < this.actionTextures.length - 1) {
      // 一次性播放：推进到最后一帧后停留在末帧，直到 next 序列/计时器接续
      this.frameIdx += 1;
    } else {
      this.animDone = true;
      return;
    }
    const tex = this.actionTextures[this.frameIdx];
    this.body.texture = tex;
    this.applySpriteSize(tex);
  }

  // ============ 主循环 ============

  public update(dt: number, resolver: SpriteResolver) {
    const dtMs = dt * (1000 / 60);

    // —— 卡死检测：仅 walk 行为且未被占用时统计“无位移/无帧切换”时长 ——
    const walkIds = [this.config.walkAction || 'walk', this.config.walkActionLeft, this.config.walkActionRight]
      .filter(Boolean) as string[];
    const inWalk = walkIds.includes(this.actionId);
    const occupied = this.isDragging || this.isRemoving || this.isWindowHeld
      || this.meetPhase !== 'none' || this.physicsActive() || this.coopFollow !== null || this.coopLead !== null;
    if (inWalk && !occupied) {
      const px = this.container.x;
      const py = this.container.y;
      const fi = this.frameIdx;
      const now = performance.now();
      if (px === this._lastStuckX && py === this._lastStuckY && fi === this._lastStuckFi) {
        if (this._stuckSince === 0) {
          this._stuckSince = now;
        } else if (now - this._stuckSince > 10000) {
          console.warn('[Pet:' + this.config.id + '] walk 动作 10s 无位移/帧切换（x=' + px.toFixed(0) + ' y=' + py.toFixed(0) + ' frame=' + fi + '），自动重启动作');
          this.requestAction(this.config.walkAction || 'walk');
          this._stuckSince = 0;
          this._stuckWarned = false;
        } else if (now - this._stuckSince > 5000 && !this._stuckWarned) {
          console.warn('[Pet:' + this.config.id + '] walk 动作疑似卡死（5s 无位移），继续观察…');
          this._stuckWarned = true;
        }
      } else {
        this._stuckSince = 0;
        this._stuckWarned = false;
        this._lastStuckX = px;
        this._lastStuckY = py;
        this._lastStuckFi = fi;
      }
    } else {
      this._stuckSince = 0;
      this._stuckWarned = false;
    }

    this.tickAnimation(dtMs);
    this.tickPendingDialogue(); // 帧驱动台词：必须在 tickAnimation 之后，才能看到本帧推进后的 frameIdx
    this.updateDragTilt(dt);

    // 右键菜单打开期间：「原地冻结」—— 只推进帧动画（含上面的倾斜），不跑行为、不跑物理、不接续 next。
    // 必须放在 pendingAdvance 兜底与行为分发**之前**，否则轮末对齐的待办会把动作切走、物理会把人拽回地面。
    if (this.menuHold) return;

    // 轮末对齐超时兜底：动画因故不再推进（如拖拽期间帧由 updateDragTilt 接管）时，
    // 不能把「等轮末」的待办无限挂着，超过上限直接收尾。
    if (this.pendingAdvance && performance.now() - this.pendingAdvanceAt > Pet.ROUND_ALIGN_MAX_MS) {
      this.pendingAdvance = false;
      this.advanceAfterAction(resolver);
      return;
    }

    if (this.isRemoving) return; // 退场动画期间：仅推进帧动画，不做行为/物理位移
    if (this.isDragging) return; // 拖拽期间保持鼠标方向
    if (this.isWindowHeld) return; // 窗口交互占用：位置由 WindowInteract 接管（拖拽时例外，由上面分支放行）

    // —— Look 系：static + trackMouse 的动作按鼠标相对位置实时翻转朝向 ——
    if (this.actionDef.trackMouse && this.actionDef.behavior === 'static') {
      this.walkFacing(mouseState.x > this.container.x + this.config.size.width / 2);
    }

    // —— 非 loop 动作播完：触发 next 序列（无 actionTimer 时；有时长则等到期走同一条链）——
    if (this.animDone && this.actionTimer === null) {
      this.animDone = false;
      this.advanceAfterAction(this.lastResolver);
      return;
    }

    // 合体合作：配角隐身跟随主演（主演负责播放合体帧，此处不额外处理）
    if (this.coopFollow) {
      // —— 自救兜底（2026-10-01 修「合体结束后配角没放回来、人凭空消失」）——
      // 只有「主演仍指着我、且主演仍在播那个合体动作」才算合体进行中。
      // 主演一旦被拖拽 / 退场 / 被别的调度切走动作，它的定时器可能永远等不到、或等到了也放不回我，
      // 这时我自己立刻 endCoop 恢复显形 —— 宁可提前散伙，也不能让人永久消失。
      const lead = this.coopFollow;
      const leadStillInCoop = lead.coopLead === this
        && (lead.coopActionId === null || lead.currentActionId === lead.coopActionId);
      if (!leadStillInCoop) {
        this.endCoop(this.lastResolver);
      } else {
        this.followCoopLead();
      }
      return;
    }
    if (this.coopLead) return; // 主演原地播合体帧，等计时器回 idle

    // 相遇阶段：走近中朝对方移动；演关键帧时原地不动（等计时器回 idle）
    if (this.meetPhase === 'approaching') { this.stepApproach(dt); return; }
    if (this.meetPhase === 'interacting') return;

    // 重力 / 物理下落：拖拽松手后、被推飞等离地状态由此接管位移
    if (this.physicsActive()) {
      this.stepPhysics(dt, resolver);
      return;
    }

    if (this.actionId === (this.config.dragAction || 'drag')) {
      this.setAction(this.config.defaultAction || 'idle', resolver);
      return;
    }

    const behavior = this.actionDef.behavior;
    switch (behavior) {
      case 'walk': this.stepWalk(dtMs); break;
      case 'climb': this.stepClimb(dt, dtMs); break;
      case 'ceiling': this.stepCeiling(dt, dtMs); break;
      case 'chase': this.stepChase(dt, dtMs); break;
      case 'fly': this.stepFly(dt, dtMs); break;
      case 'static':
      default:
        this.stepStatic(dtMs);
        break;
    }
  }

  /** 原地待机：追鼠标或随机开始漫游动作（加权）。 */
  private stepStatic(dtMs: number) {
    this.idleMs += dtMs;
    if (this.actionId !== (this.config.defaultAction || 'idle')) return;
    // —— 追鼠标（ChaseMouse）：鼠标在移动且够近时，低概率发起追击 ——
    const chaseId = this.config.chaseAction;
    if (chaseId && this.config.actions[chaseId]) {
      const range = this.config.actions[chaseId].chaseRange ?? 260;
      const dx = Math.abs(mouseState.x - (this.container.x + this.config.size.width / 2));
      if (mouseActive() && dx < range && Math.random() < 0.004) {
        this.chainDepth = 0;
        this.requestAction(chaseId);
        return;
      }
    }
    if (Math.random() < this.wanderChance(dtMs)) {
      // 回 idle 后必须先站一会儿再考虑 wander——避免"吃→练剑"这样上一个动作刚结束
      // 立刻无缝接到随机动作的诡异观感（用户 v0.4.x 反馈）。默认 1500ms。
      const minDelay = this.config.wanderMinDelayMs ?? 1500;
      if (this.idleMs < minDelay) return;
      // 贴屏幕边缘时优先选攀爬而非 walk：避免从 idle 进入 walk 后立刻撞墙、原地踏步抖动
      // 冷却期（刚从墙上下来）例外 —— 否则刚落地又立刻被判贴边 → 马上重爬，表现为「粘在墙上不下来」
      if (this.atScreenEdge(10) && !this.isClimbBlocked()) {
        this.requestAction(this.config.climbAction || 'climb');
        return;
      }
      const pick = this.pickWanderAction();
      if (pick && pick !== this.actionId) {
        this.chainDepth = 0;
        this.pushRecentWander(pick);
        this.requestAction(pick);
      }
    }
  }

  /** 加权随机选一个漫游动作：wanderActions 支持 ['walk'] 或 [{id:'sit', weight:5}]（缺省权重 1）。
   *  位置上下文过滤：贴边时过滤 walk（立刻撞墙）；只保留配置里真实存在的动作。
   *  防重复：最近 1 个排除、再往前 2 个降权到 20%，避免「一直做同一个动作」。
   *  （纯 i.i.d. 抽样在小样本下极易连抽同一个，尤其池子里只有 7–12 个动作时。） */
  private pickWanderAction(): string | null {
    const raw = this.config.wanderActions && this.config.wanderActions.length > 0
      ? this.config.wanderActions : [this.config.defaultAction || 'idle'];
    const atEdge = this.atScreenEdge(10);
    const pool: { id: string; weight: number }[] = [];
    for (const entry of raw) {
      const e = typeof entry === 'string' ? { id: entry, weight: 1 } : { id: entry.id, weight: entry.weight ?? 1 };
      const def = this.config.actions[e.id];
      if (!def || e.weight <= 0) continue;
      if (atEdge && def.behavior === 'walk') continue; // 贴边不选 walk（撞墙鬼畜）
      pool.push(e);
    }
    if (pool.length === 0) return null;
    // 先按「排除上一次」抽；若被排除到没候选（池子只有 1 个动作），退回完整池，避免抽不到动作
    const pick = this.weightedPickWander(pool, true);
    return pick ?? this.weightedPickWander(pool, false);
  }

  /** 按权重抽一个；applyRecent=true 时应用防重复降权/排除。
   *  规则全部来自角色配置（默认值 = 原硬编码行为）：
   *  - wanderRecentExclude 个「最近」动作直接排除；
   *  - 仍在记忆里（wanderRecentSize 长度）的其余动作权重 × wanderRecentPenalty；
   *  - wanderRecentExempt 内的动作**完全不受防重复影响**。高权重骨架动作（如 walk）通常需要它：
   *    否则「上一次恰好是它」时必被排除，实测频率会从配置的 50% 腰斩到约 26%。 */
  private weightedPickWander(pool: { id: string; weight: number }[], applyRecent: boolean): string | null {
    const excludeN = Math.max(0, this.config.wanderRecentExclude ?? 1);
    const penalty = typeof this.config.wanderRecentPenalty === 'number' ? this.config.wanderRecentPenalty : 0.2;
    const exempt = new Set(this.config.wanderRecentExempt || []);
    const weighted: { id: string; weight: number }[] = [];
    for (const e of pool) {
      let w = e.weight;
      if (applyRecent && !exempt.has(e.id)) {
        const idx = this.recentWander.indexOf(e.id);
        if (idx >= 0 && idx < excludeN) continue;  // 最近的 N 个 → 本次直接排除
        if (idx >= 0) w *= penalty;                // 还在记忆里 → 大幅降权
      }
      if (w > 0) weighted.push({ id: e.id, weight: w });
    }
    if (weighted.length === 0) return null;
    let r = Math.random() * weighted.reduce((s, e) => s + e.weight, 0);
    for (const e of weighted) {
      r -= e.weight;
      if (r <= 0) return e.id;
    }
    return weighted[weighted.length - 1].id;
  }

  /** 记住最近抽到的 wander 动作（新→旧），供防重复降权使用。记忆长度 = wanderRecentSize（默认 3）。 */
  private pushRecentWander(id: string) {
    const size = Math.max(1, this.config.wanderRecentSize ?? 3);
    this.recentWander = [id, ...this.recentWander.filter((x) => x !== id)].slice(0, size);
  }

  /** 左右位移：目标 x 随机，y 固定贴下沿。
   *  - 配置了 walkActionLeft/Right（两套图）→ 按方向切不同动作且**不翻转**（方向已画在图里）。
   *  - 未配置 → 走旧逻辑（单图 + 水平翻转）。 */
  private stepWalk(dtMs: number) {
    const dx = this.targetPos.x - this.container.x;
    if (Math.abs(dx) < 5) {
      if (this.walkArriveCb) {
        const cb = this.walkArriveCb;
        this.walkArriveCb = null;
        petLog(this.config.id + ' 走到目标 x=' + Math.round(this.container.x) + '，触发到达回调');
        cb(); // 到达目标点：把控制权交回调用方（如窗口投掷 approach → grab），不回 idle
        return;
      }
      this.requestAction(this.config.defaultAction || 'idle');
      return;
    }
    // 撞到屏幕边界且目标在墙外够不到 → 改沿边攀爬，避免"动画在播但人不位移"的原地踏步鬼畜。
    // 有到达回调（walkArriveCb 非空）除外：目标点常就贴在屏幕边缘，撞墙=到达；切攀爬会吃掉到达回调。
    const w = this.config.size.width;
    const hitLeftWall = this.container.x <= 0 && dx < 0;
    const hitRightWall = this.container.x >= window.innerWidth - w && dx > 0;
    if ((hitLeftWall || hitRightWall) && !this.walkArriveCb) {
      // —— 监管埋点：walk 撞墙（攀爬误触发 / 原地踏步溯源点）——
      slog({
        level: 'action',
        petId: this.config.id,
        category: 'walk.boundary',
        cause: hitLeftWall ? 'leftWall' : 'rightWall',
        before: { action: this.actionId, x: this.container.x, targetX: this.targetPos.x },
        after: { action: this.config.climbAction || 'climb' },
      });
      const climbId = this.config.climbAction || 'climb';
      if (this.config.actions[climbId] && !this.isClimbBlocked()) {
        this.requestAction(climbId);
        return;
      }
      // 攀爬冷却期内不能上墙：把目标点改到屏幕内侧，否则会在墙边「动画在播但人不位移」地原地踏步
      const inner = hitLeftWall
        ? Math.min(Math.max(0, window.innerWidth - w), 60 + Math.random() * 200)
        : Math.max(0, window.innerWidth - w - 60 - Math.random() * 200);
      this.targetPos = { x: inner, y: this.baselineY() };
      return;
    }
    const movingRight = dx > 0;
    // 两套行走图：left/right 帧集都存在时才启用；否则退回单图 + 翻转（默认行为，所有角色通用）
    const leftId = this.config.walkActionLeft;
    const rightId = this.config.walkActionRight;
    const twoSet = !!(leftId && rightId
      && this.config.actions[leftId] && this.config.actions[rightId]);
    if (twoSet) {
      const want = movingRight ? rightId : leftId;
      if (this.actionId !== want) this.setAction(want, this.lastResolver); // 切帧集，不翻转
      // 方向已画在图里，强制不翻转。facingRight 仍要同步，否则之后切到 climb/fly 会继承陈旧朝向。
      // 此处不走 setFacing：本方案的朝向由 actionId（左走/右走两个动作）表达，
      // setFacing 会去切 usingRightFrames 帧集，与「两套动作 id」方案冲突。
      this.facingRight = movingRight;
      this.body.scale.x = 1;
    } else {
      this.walkFacing(movingRight); // 旧逻辑：单图水平翻转
    }
    // 位移速度取「当前行走帧的 vx」（数据驱动，参考 Shimeji 每帧 Pose 带 Velocity）：
    // 该帧未写 vx → 回退动作级 moveSpeed；vx=0 的支撑帧该帧不位移 → 踩步感。
    // 连续逐帧应用（非「换帧跳一格」），整体速度与原连续滑动一致、但脚步与位移绑定在帧上。
    const speed = frameVx(this.actionDef.frames, this.frameIdx)
      ?? (this.actionDef.moveSpeed ?? this.config.moveSpeed ?? 1.2);
    this.container.x += Math.sign(dx) * speed * (dtMs / 1000) * 60;
    this.container.y = this.baselineY();
    this.clampBounds();
  }

  /** 沿屏幕边框上下攀爬（climb）：一次「攀爬会话」内沿边**上下折返巡逻**，
   *  到 `climbMaxMs`（默认 20s）才下墙 —— 松手掉落或触发飞行动作（`climbEndFlyChance`）。
   *  朝向按所在边决定：贴左 → 朝右（面朝屏幕中心），贴右 → 朝左；中间 → 不翻。
   *  下爬复用同一套攀爬帧（美术是方向无关的「握紧→发力」循环），只把位移方向取反；
   *  若将来补了独立下爬帧，配 `climbDownAction` 即可切换过去（本文件 applyClimbAction）。 */
  private stepClimb(dt: number, dtMs: number) {
    this.vx = 0; this.vy = 0; // 攀爬不受重力/惯性，清零残留速度避免结束转 idle 立即又下落
    if (this.climbStartMs === 0) this.climbStartMs = performance.now();
    // 唯一的主动出口：会话到期 → 掉落 / 起飞。保证「爬上爬下」是有限循环，不会长期挂在墙上。
    const maxClimbMs = typeof this.config.climbMaxMs === 'number' ? this.config.climbMaxMs : 20000;
    if (maxClimbMs > 0 && performance.now() - this.climbStartMs >= maxClimbMs) {
      this.endClimbSession();
      return;
    }
    // 挂壁停顿：一条腿走完先静一下（像踩稳了再迈步），停完再选下一条腿
    if (this.perchTimer > 0) {
      this.perchTimer -= dtMs;
      if (this.perchTimer > 0) return;
      this.perchTimer = 0;
      // 爬到顶附近且配了「贴顶爬」→ 按 ceilingChance 转过去（保留旧的顶→贴顶出口）
      if (this.maybeEnterCeilingAtTop()) return;
      this.pickClimbTarget();
      return;
    }
    const dy = this.targetPos.y - this.container.y;
    if (Math.abs(dy) < 4) {
      // 意外落到地面高度（例如从地面起步后目标被夹到底）：落地结束会话，回到正常漫游
      if (this.container.y >= this.baselineY() - 4) { this.finishClimbOnGround(); return; }
      this.perchTimer = 200 + Math.random() * 300;
      return;
    }
    const side = this.screenEdgeSide(10);
    if (side === 'left') this.walkFacing(false);  // 贴左边，侧身面朝墙（向左看）
    else if (side === 'right') this.walkFacing(true); // 贴右边，侧身面朝墙（向右看）
    // side === null 时不翻（角色在中段启动 climb 的极少数情况，保留美术默认朝向）
    // 竖直位移数据驱动：优先取当前帧的 vy（与 walk 的 vx 踩步逻辑对称），未写 vy 才回退动作级 moveSpeed；
    // vy=0 即握紧帧（该帧不位移），vy>0 的帧真正爬一格。上爬/下爬共用，符号由目标方向决定。
    const speed = frameVy(this.actionDef.frames, this.frameIdx)
      ?? (this.actionDef.moveSpeed ?? this.config.moveSpeed ?? 1.2);
    this.container.y += Math.sign(dy) * speed * dt;
    // 水平也向贴边目标收敛：edgeMargin 让容器可向外探出屏幕，使人物本体真正贴到边框
    const dx = this.targetPos.x - this.container.x;
    if (Math.abs(dx) > 1) {
      const stepX = Math.min(Math.abs(dx), speed * dt * 2);
      this.container.x += Math.sign(dx) * stepX;
    }
    this.clampBounds();
  }

  /** 爬到顶附近时是否转入「贴顶爬」：配了 ceiling 动作 + 概率命中才转。
   *  只从 stepClimb（ticker 内）调用，**不要从 pickClimbTarget 里调** ——
   *  后者会被 requestAction 调用，内部再 requestAction 会形成「请求中嵌套请求」。 */
  private maybeEnterCeilingAtTop(): boolean {
    if (this.container.y > Math.max(60, this.config.size.height * 0.5)) return false;
    const ceilId = this.config.ceilingAction || 'ceiling';
    if (!this.config.actions[ceilId]) return false;
    if (Math.random() >= (this.config.ceilingChance ?? 0.35)) return false;
    this.requestAction(ceilId);
    return true;
  }

  /** 选下一条攀爬腿的目标点（爬上爬下的核心）：
   *  顶/底附近强制折返，中途按 `climbTurnChance` 随机折返 → 形成上下巡逻。
   *  下沿留 CLIMB_EDGE_GAP_PX，避免巡逻目标落到地面上被误判成「已落地」。
   *  历史 bug：旧实现只会选「在角色上方」的目标（值域 [0, currentY-80]），物理上不可能向下，
   *  加「回地面」判据只有 2px 命中窗口 → 角色在墙上无限上爬，等 20s 兜底才被硬拉回地面。 */
  private pickClimbTarget() {
    const side = this.screenEdgeSide(10) || (this.container.x < window.innerWidth / 2 ? 'left' : 'right');
    const margin = this.config.edgeMargin || 0;
    const edgeX = side === 'left' ? -margin : window.innerWidth - this.config.size.width + margin;
    const top = 0;
    const bottom = this.baselineY();
    const zone = Math.max(60, this.config.size.height * 0.5); // 距顶/底小于半个身位即强制折返
    const y = Math.max(top, Math.min(bottom, this.container.y));
    let dir = this.climbDir;
    if (y <= top + zone) dir = 1;                                    // 到顶 → 向下
    else if (y >= bottom - zone) dir = -1;                           // 到底 → 向上
    else if (Math.random() < (this.config.climbTurnChance ?? 0.35)) dir = (dir === 1 ? -1 : 1); // 中途随机折返
    this.climbDir = dir;
    const lo = top;
    const hi = Math.max(lo, bottom - Pet.CLIMB_EDGE_GAP_PX);
    const minLeg = Pet.CLIMB_LEG_MIN_PX;
    let targetY: number;
    if (dir > 0) {
      const a = Math.min(hi, y + minLeg);
      targetY = a + Math.random() * Math.max(0, hi - a);
    } else {
      const b = Math.max(lo, y - minLeg);
      targetY = lo + Math.random() * Math.max(0, b - lo);
    }
    this.targetPos = { x: edgeX, y: targetY };
    this.container.x = edgeX; // 直接吸附屏幕边框，不缓慢横向漂移（修「扔到边缘慢悠悠飘过去」）
    this.applyClimbAction(dir);
  }

  /** 按攀爬方向选择动作 id：配了 `climbDownAction` 且该动作存在 → 下爬用它；否则上下都复用 climbAction。 */
  private applyClimbAction(dir: -1 | 1) {
    const upId = this.config.climbAction || 'climb';
    const downId = this.config.climbDownAction;
    const want = (dir > 0 && downId && this.config.actions[downId]) ? downId : upId;
    if (this.actionId !== want) this.setAction(want, this.lastResolver);
  }

  /** 攀爬会话到期的唯一出口：松手掉落、或按 `climbEndFlyChance` 触发飞行动作。
   *  已在下沿附近（一人身位以内）时改为直接落地走开 —— 从地面高度「掉落」没有意义。 */
  private endClimbSession() {
    const nearGround = this.container.y >= this.baselineY() - Math.max(60, this.config.size.height);
    if (nearGround) { this.finishClimbOnGround(); return; }
    const flyId = this.config.flyAction || 'fly';
    const flyDef = this.config.actions[flyId];
    const canFly = !!flyDef && flyDef.behavior === 'fly';
    const flyChance = typeof this.config.climbEndFlyChance === 'number' ? this.config.climbEndFlyChance : 0.5;
    const useFly = canFly && Math.random() < flyChance;
    // 起飞时长：贴顶飞（ceiling）由会话逻辑收尾（贴顶巡逻 10~20s），不能用 estimateActionMs ——
    // 它的 durationMs 是 0，反推出来只有「帧数 × 帧时长」≈3s，冷却会提前失效。
    const flyMs = flyDef
      ? (flyDef.flyMode === 'ceiling'
        ? (this.config.ceilingMaxMs ?? 20000) + 2000
        : this.estimateActionMs(flyDef))
      : 0;
    slog({
      level: 'action',
      petId: this.config.id,
      category: 'climb.end',
      cause: 'timeout',
      before: { action: this.actionId, y: Math.round(this.container.y), elapsedMs: Math.round(performance.now() - this.climbStartMs) },
      after: { action: useFly ? flyId : (this.config.fallAction || 'fall') },
    });
    if (useFly) {
      this.perchTimer = 0;
      this.climbSessionActive = false;
      // 冷却要覆盖整个飞行时长：否则飞完转 idle 下落时若人仍在边缘区，会被「下落撞边 → 抓墙」
      // 立刻抓回去 → 连续攀爬、从不落地（仿真复现：20s 爬 → 5s 飞 → 立即再爬 20s）。
      this.blockClimb(flyMs + 1500);
      this.requestAction(flyId); // 起飞：贴顶飞由会话逻辑（贴顶巡逻到期）收尾，落回地面后恢复漫游
      return;
    }
    this.dropFromWall();
  }

  /** 从墙上松手掉落：切 fall 帧交给物理接管（airborne 判定 = y < 下沿）。
   *  顺带开启攀爬冷却：落地时人还在屏幕边缘区，否则下一帧就会被「贴边 → climb」再次抓回墙上。 */
  private dropFromWall() {
    this.perchTimer = 0;
    this.blockClimb();
    this.vy = 0.6; // 给一点向下初速，避免零速悬停在空中
    // 朝屏幕内侧给一点水平初速：攀爬时 x 被吸附到 -edgeMargin / W-w+edgeMargin（人为探出屏幕），
    // 若只是垂直掉落，落点仍在边缘区 → 冷却一结束又被 stepStatic 判「贴边」重新爬上同一面墙
    // （表现为「每次都在同一侧反复上墙」）。这里让它掉下来的同时离开边缘区。
    const side = this.screenEdgeSide(10)
      ?? (this.container.x < window.innerWidth / 2 ? 'left' : 'right');
    this.vx = (side === 'left' ? 1 : -1) * Pet.CLIMB_DROP_VX;
    this.setAction(this.config.fallAction || 'fall', this.lastResolver);
  }

  /** 沿墙回到下沿：落地并朝屏幕内侧走一段，恢复正常漫游（攀爬会话在下沿的出口）。 */
  private finishClimbOnGround() {
    this.perchTimer = 0;
    this.climbSessionActive = false; // 已回到地面 → 本次攀爬会话结束
    this.blockClimb();
    const w = this.config.size.width;
    const maxX = Math.max(0, window.innerWidth - w);
    const groundY = this.baselineY();
    this.container.y = groundY;
    this.vx = 0; this.vy = 0;
    const walkId = this.config.walkAction || 'walk';
    if (this.config.actions[walkId]) {
      this.requestAction(walkId);
      // 覆盖 requestAction 的随机目标点：朝屏幕内侧走，避免刚落地就贴着墙又被判撞边
      const inner = this.container.x < window.innerWidth / 2
        ? Math.min(maxX, 140 + Math.random() * 220)
        : Math.max(0, maxX - 140 - Math.random() * 220);
      this.targetPos = { x: inner, y: groundY };
    } else {
      this.setAction(this.config.defaultAction || 'idle', this.lastResolver);
    }
  }

  /** 开启攀爬冷却（climbCooldownMs，默认 3000ms）：期间贴到屏幕边也不触发攀爬。
   *  `minMs` 用于「出口本身要占一段时间」的场景（如起飞后再下墙）：冷却至少覆盖到那之后，
   *  否则飞行结束时人可能正好还在边缘 → 立刻被 stepPhysics 抓回墙上 → 变成「永远在爬、从不落地」。 */
  private blockClimb(minMs?: number) {
    const base = typeof this.config.climbCooldownMs === 'number' ? this.config.climbCooldownMs : 3000;
    const ms = Math.max(base, minMs ?? 0);
    this.climbBlockedUntil = performance.now() + ms;
  }

  /** 是否处于攀爬冷却期（app.ts 与 stepStatic 触发攀爬前都必须检查）。 */
  public isClimbBlocked(): boolean {
    return performance.now() < this.climbBlockedUntil;
  }

  /** 贴顶爬（ceiling）：贴天花板横向位移（倒挂帧）。到达目标后三选一：
   *  松手掉落（物理接管）/ 贴边改下爬 / 换个目标继续爬。 */
  private stepCeiling(dt: number, dtMs: number) {
    void dtMs;
    this.container.y = 0; // 始终贴顶（offset 补偿在 applySpriteSize 里按动作级 offset 处理）
    const dx = this.targetPos.x - this.container.x;
    if (Math.abs(dx) < 5) {
      const r = Math.random();
      const drop = this.config.ceilingDropChance ?? 0.35;
      const edge = this.config.ceilingEdgeChance ?? 0.25;
      if (r < drop) {
        // 松手掉落：统一走 dropFromWall（含攀爬冷却 + 内向初速），
        // 避免出现第二条「掉落」实现漏掉冷却 → 与 climb 之间形成同样的死循环
        this.dropFromWall();
        this.container.y = 1; // 微降一点确保 physicsActive 判定离地
        return;
      }
      if (r < drop + edge && this.atScreenEdge(10)) {
        // 贴边：沿墙下爬
        this.requestAction(this.config.climbAction || 'climb');
        return;
      }
      const w = this.config.size.width;
      this.targetPos = { x: Math.random() * (window.innerWidth - w), y: 0 };
      return;
    }
    this.walkFacing(dx > 0);
    const speed = (this.actionDef.moveSpeed ?? this.config.moveSpeed ?? 1.2);
    this.container.x += Math.sign(dx) * speed * dt;
    this.clampBounds();
  }

  /** 追鼠标（chase）：指针仍在移动且在半径内时朝指针 x 跑（默认 2 倍速）；
   *  指针停了 / 超出范围 / 超时 → 回默认动作。 */
  private stepChase(dt: number, dtMs: number) {
    this.chaseMs += dtMs;
    const range = this.actionDef.chaseRange ?? 260;
    const timeout = this.actionDef.chaseTimeoutMs ?? 4000;
    const cx = this.container.x + this.config.size.width / 2;
    const dx = mouseState.x - cx;
    if (this.chaseMs > timeout || !mouseActive() || Math.abs(dx) > range) {
      this.setAction(this.config.defaultAction || 'idle', this.lastResolver);
      return;
    }
    this.container.y = this.baselineY();
    if (Math.abs(dx) > 8) {
      this.walkFacing(dx > 0);
      const speed = this.actionDef.moveSpeed ?? (this.config.moveSpeed ?? 1.2) * 2;
      this.container.x += Math.sign(dx) * Math.min(Math.abs(dx), speed * dt);
    }
    this.clampBounds();
  }

  /** 自由飞行：在屏幕内 2D 朝目标点移动（不受重力/地面约束），到达后随机选新目标；
   *  朝向随水平移动方向切换（双套图集会重选左/右帧集）。纵向上界 clamp 在屏幕内、下界到地面。 */
  private stepFly(dt: number, dtMs: number) {
    if (this.actionDef.flyMode === 'ceiling') { this.stepFlyCeiling(dt); return; }
    void dtMs;
    // —— 移动 / 悬停双相位：飞一段就原地悬停扑翼片刻（旧桌宠那种「中间偶尔停顿」）——
    // 悬停期间只播 hoverFrames，不产生任何位移（behavior 仍是 fly，重力不接管，所以不会掉下去）。
    this.tickFlyPhase();
    if (this.flyHovering) return;
    const dx = this.targetPos.x - this.container.x;
    const dy = this.targetPos.y - this.container.y;
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) {
      const w = this.config.size.width, h = this.config.size.height;
      this.targetPos = {
        x: Math.random() * (window.innerWidth - w),
        y: Math.random() * Math.max(1, (window.innerHeight - h) * 0.7), // 偏好上半屏
      };
      return;
    }
    if (Math.abs(dx) > 2) this.walkFacing(dx > 0);
    const speed = (this.actionDef.moveSpeed ?? this.config.moveSpeed ?? 1.2);
    const bx = this.container.x, by = this.container.y;
    this.container.x += Math.sign(dx) * Math.min(Math.abs(dx), speed * dt);
    this.container.y += Math.sign(dy) * Math.min(Math.abs(dy), speed * dt);
    this.clampBounds();
    // 撞边 → 目标翻向屏内（「碰到边缘就往反方向飞」）。必须在 clampBounds 之后判，
    // 否则拿到的是夹取前的坐标，判不出「已经顶到边界」。
    if (this.bounceFlyAtEdge()) return;
    // 兜底：两个轴都没挪动（被 clamp 锁在角落）→ 立刻换一个屏内的随机点，杜绝原地卡死。
    if (Math.abs(this.container.x - bx) < 0.01 && Math.abs(this.container.y - by) < 0.01) {
      const w = this.config.size.width, h = this.config.size.height;
      this.targetPos = {
        x: Math.random() * Math.max(1, window.innerWidth - w),
        y: Math.random() * Math.max(1, (Pet.getFloor() - h) * 0.7),
      };
    }
  }

  /** 飞行撞边检测：角色**碰到屏幕左右/上下边缘**时把目标点镜像到屏幕内的反方向，
   *  实现「碰到边就往反方向飞」。
   *
   *  【历史 bug（2026-10-01 用户报）】飞行到屏幕角落附近后偶尔会「一直飞、卡在边上不动」：
   *  `stepFly` 的到达判定是 `|targetPos.x - x| < 6`，而 `clampBounds()` 会把 x **硬夹到 [0, maxX]**。
   *  一旦 targetPos 因窗口尺寸变化（resolution / 任务栏）或极端随机值落到屏幕外，
   *  角色会被夹在边缘、dx 却永远 ≥ 阈值 → 既到不了终点、也不重选目标 → 原地扑翼卡死。
   *  这里在每帧位移后检测「目标点在屏外」或「已顶到边缘且仍朝外飞」，直接把目标翻到对侧。
   *
   *  @returns 是否发生了反弹（调用方据此跳过本帧剩余的朝向/倾斜更新）
   */
  private bounceFlyAtEdge(): boolean {
    const w = this.config.size.width;
    const h = this.config.size.height;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, Pet.getFloor() - h);
    const x = this.container.x;
    const y = this.container.y;
    const EPS = 1;       // 边缘容差：夹取后 x 恰好 == 边界
    const MIRROR_MIN = 80; // 反弹后距当前至少要走这么远，避免在边缘「抖着小步原地翻」
    let flipped = false;

    // —— 水平 ——
    const tx = this.targetPos.x;
    const outLeft = tx < -EPS || (x <= EPS && tx < x);
    const outRight = tx > maxX + EPS || (x >= maxX - EPS && tx > x);
    if (outLeft || outRight) {
      const span = Math.max(MIRROR_MIN, maxX * (0.35 + Math.random() * 0.5));
      const next = outLeft ? Math.min(maxX, x + span) : Math.max(0, x - span);
      this.targetPos.x = next;
      flipped = true;
    }

    // —— 垂直：自由飞会有纵向分量，撞顶/撞地同样翻向 ——
    if (this.actionDef.flyMode !== 'ceiling') {
      const ty = this.targetPos.y;
      const outTop = ty < -EPS || (y <= EPS && ty < y);
      const outBottom = ty > maxY + EPS || (y >= maxY - EPS && ty > y);
      if (outTop || outBottom) {
        const span = Math.max(MIRROR_MIN, maxY * (0.35 + Math.random() * 0.5));
        this.targetPos.y = outTop ? Math.min(maxY, y + span) : Math.max(0, y - span);
        flipped = true;
      }
    }
    return flipped;
  }

  /** 贴顶巡逻的下一个目标 x（对齐旧桌宠 ClimbAlongCeiling 的 TargetX =
   *  `workArea.left + 64 + Math.random()*(workArea.width - 128)`，即工作区内随机、距两侧至少 64px）。
   *  仅当目标离当前位置太近时改去另一侧，避免「挪几像素就重选点」的抖动。 */
  private pickCeilingPatrolX(): number {
    const w = this.config.size.width;
    const scrW = window.innerWidth;
    const maxX = Math.max(0, scrW - w);
    const margin = 64;
    const lo = Math.min(margin, maxX);
    const hi = Math.max(lo, maxX - margin);
    let x = lo + Math.random() * Math.max(0, hi - lo);
    if (Math.abs(x - this.container.x) < 120) x = this.container.x < scrW / 2 ? hi : lo;
    return x;
  }

  /** 贴顶飞（flyMode='ceiling'）：触发后从当前位置垂直升到屏幕顶端，然后贴着上沿左右往返。
   *  参照 Shimeji 的 GrabCeiling（到顶先悬挂 500-1500ms）+ ClimbCeiling（贴顶移动）：
   *  阶段1（尚未到顶）：纯垂直上升，x 保持当前；到达 y≈0 转入阶段2。**不计入贴顶时长**。
   *  阶段2a（刚到顶）：在顶端静止悬挂 random(500,1500)ms，模拟 Shimeji 的 GrabCeiling 悬停。
   *  阶段2b（已悬挂完）：y 锁定 0，x 沿上沿移动，到巡逻预算（≤ ceilingMaxMs，默认 20s）后掉落。
   *  配了 hoverFrames（flyDualPhase）时额外对齐旧桌宠两处：目标点在屏幕内**随机**取（不是固定往返两端）、
   *  巡逻途中**反复抓稳停顿**（移动/悬停相位交替）；没配的角色完全走上面的老路径，行为不变。
   *
   *  【历史 bug】旧实现完全依赖动作级 durationMs（config 里是 5000）收尾，而上升速度 moveSpeed 1.5
   *  ≈ 90px/s、1080p 从地面升到顶要约 10s → 定时器 5s 先到期 → 「飞到一半就掉下来了」。
   *  改为**会话式**（与攀爬同一套思路）：贴顶时长从「贴上缘那一刻」起算，动作级 durationMs 设为 0
   *  （不挂定时器，靠本方法自收尾）；上升段另有 CEILING_RISE_MAX_MS 安全兜底。 */
  private stepFlyCeiling(dt: number) {
    const w = this.config.size.width;
    const topY = 0;
    const speed = (this.actionDef.moveSpeed ?? this.config.moveSpeed ?? 1.2);
    // 倾斜角：贴顶飞时角色整体绕中心旋转一点，模拟「斜着飞」而非竖直升空。
    // 上升段按水平方向斜飞并倾斜；巡逻段按飞行方向倾斜；悬挂段回正。
    const tilt = this.config.ceilingTilt ?? 0.22;
    const dy = topY - this.container.y;
    if (Math.abs(dy) > 4) {
      // 阶段1：斜向升到顶端（带水平分量 + 倾斜，不再纯竖直）
      if (performance.now() - this.flyEnterMs > Pet.CEILING_RISE_MAX_MS) {
        console.warn(`[Pet:${this.config.id}] 贴顶飞行上升超时（>${Pet.CEILING_RISE_MAX_MS}ms 仍未贴上缘），直接掉落`);
        this.dropFromCeiling('rise-timeout');
        return;
      }
      this.container.y += Math.sign(dy) * Math.min(Math.abs(dy), speed * dt);
      this.container.x += this.ceilingDir * Math.min(speed * dt, 2) * 0.7; // 水平斜飞分量
      this.clampBounds();
      this.walkFacing(this.ceilingDir > 0);
      this.tiltNode.rotation = this.ceilingDir * tilt; // 朝飞行方向倾斜
      this.tilt = this.ceilingDir * tilt;
      this.setFlyHovering(false); // 上升段 = 移动相位（播 flymoving 帧）
      return;
    }
    // 已到顶 —— 「贴顶时长」从这一刻起算（上升段不计入）
    this.container.y = topY;
    if (!this.ceilingSessionActive) {
      this.ceilingSessionActive = true;
      this.ceilingStartMs = performance.now();
    }
    // 阶段2a：到顶先悬挂片刻（对应 Shimeji GrabCeiling 的 500-1500ms），悬挂时回正
    if (this.ceilingHangUntil === 0) {
      this.ceilingHangUntil = performance.now() + 500 + Math.random() * 1000;
      this.tiltNode.rotation = 0;
      this.tilt = 0;
      this.setFlyHovering(true); // 到顶悬挂 = 静止飞行（播 fly 两帧）
      return; // 进入悬挂首帧，原地不动
    }
    if (this.ceilingHangUntil > 0 && performance.now() < this.ceilingHangUntil) {
      return; // 悬挂中，静止在顶端
    }
    this.ceilingHangUntil = -1; // 悬挂结束，后续进入巡逻不再触发
    // 巡逻起步必须是「移动段」：进入动作时掷的那段相位在上升途中根本没被消费，到这里多半早已过期，
    // 不重掷的话第一次 tickFlyPhase 会立刻翻成悬停 →「刚到顶就又停住」。
    this.setFlyHovering(false); // 巡逻段 = 移动相位（播 flymoving 帧）
    this.flyPhaseUntil = performance.now() + this.randFlyPhaseMs(false);
    // 阶段2b：贴顶左右往返，撑满本次巡逻预算后掉落
    if (performance.now() - this.ceilingStartMs >= this.ceilingPatrolMs) {
      this.dropFromCeiling('timeout');
      return;
    }
    // —— 对齐旧桌宠：巡逻途中会反复「抓稳一下 → 爬一段 → 再抓稳」——
    // Shimeji 里 HoldOntoCeiling（GrabCeiling 静止）与 ClimbAlongCeiling（贴顶移动）是两个同频次行为，
    // 贴顶期间被随机反复选中，所以是**走走停停**，不是一次爬到底。这里复用自由飞那套移动/悬停相位。
    if (this.flyDualPhase) {
      this.tickFlyPhase();
      if (this.flyHovering) {
        // 中途抓稳：静止在顶端、回正不倾斜（播 fly 两帧），不产生位移
        this.tiltNode.rotation = 0;
        this.tilt = 0;
        return;
      }
    }
    const dx = this.targetPos.x - this.container.x;
    if (Math.abs(dx) < 6) {
      // 到达目标点 → 选下一个。双相位（对齐旧桌宠）在屏幕内**随机**取点，
      // 不是「固定往返屏幕两端」——旧桌宠 ClimbAlongCeiling 的 TargetX 就是工作区内随机值。
      const cur = this.container.x;
      const nextX = this.flyDualPhase
        ? this.pickCeilingPatrolX()
        : (cur < window.innerWidth / 2 ? window.innerWidth - w : 0);
      this.targetPos = { x: nextX, y: topY };
      this.ceilingDir = nextX > cur ? 1 : -1; // 更新水平方向（倾斜随之反向）
      return;
    }
    if (Math.abs(dx) > 2) this.walkFacing(dx > 0);
    const before = this.container.x;
    this.container.x += Math.sign(dx) * Math.min(Math.abs(dx), speed * dt);
    this.clampBounds();
    // 撞边 → 巡逻目标翻到对侧。贴顶巡逻的目标点本就在屏内取值，正常到不了这里；
    // 但「窗口缩放 / 显示器切换」会让存的 targetPos 落在新范围内侧 → 撞上边就永远到不了，卡死。
    if (this.bounceFlyAtEdge()) {
      this.ceilingDir = this.targetPos.x > this.container.x ? 1 : -1; // 倾斜跟着新方向反向
      return;
    }
    // 兜底：本帧一点没挪动（已被 clamp 锁死在边界、dx 又不足以判「到达」）→ 强制重选巡逻目标。
    // 这是「贴到角落后一直飞」的最终防线，保证任何情况下都不会停在边缘空扑翼。
    if (Math.abs(this.container.x - before) < 0.01) {
      const nextX = this.pickCeilingPatrolX();
      this.targetPos = { x: nextX, y: topY };
      this.ceilingDir = nextX > this.container.x ? 1 : -1;
      return;
    }
    this.ceilingDir = dx > 0 ? 1 : -1;
    this.tiltNode.rotation = this.ceilingDir * tilt; // 朝巡逻方向倾斜飞行
    this.tilt = this.ceilingDir * tilt;
  }

  /** 进入飞行动作时重置贴顶会话状态（setAction / requestAction 两个入口都必须调，
   *  否则重新触发贴顶飞时 ceilingSessionActive 残留 → 贴顶时长不会被重新计时）。 */
  private resetFlySession() {
    this.ceilingHangUntil = 0;         // 重置贴顶悬挂状态
    this.ceilingSessionActive = false; // 尚未贴上缘
    this.ceilingStartMs = 0;
    this.flyEnterMs = performance.now();
    // 双相位从「移动段」起步：先飞一段再停。一进来就悬停会像是卡住了，观感不对。
    this.flyHovering = false;
    this.flyPhaseUntil = performance.now() + this.randFlyPhaseMs(false);
    this.ceilingDir = Math.random() < 0.5 ? -1 : 1; // 上升段斜飞方向随机，每次都不同
    const maxMs = typeof this.config.ceilingMaxMs === 'number' ? this.config.ceilingMaxMs : 20000;
    // 实际巡逻预算 = ceilingMaxMs 的 [50%, 100%] 随机值：既每次都不同，又不超过「最大 20s」这个上限。
    this.ceilingPatrolMs = maxMs > 0 ? maxMs * (0.5 + Math.random() * 0.5) : 20000;
  }

  /** 贴顶飞到期/异常 → 松手掉落（切 fall 交给物理接管）。
   *  必须开攀爬冷却：否则在屏幕左右两端掉落时会被 stepPhysics 的「下落撞边 → 抓墙」立刻抓回墙上。 */
  private dropFromCeiling(cause: 'timeout' | 'rise-timeout') {
    this.ceilingSessionActive = false;
    this.ceilingHangUntil = 0;
    this.tiltNode.rotation = 0;        // 复位贴顶飞的倾斜角，落体恢复竖直
    this.tilt = 0;
    this.blockClimb();
    const dropId = this.config.fallAction || 'fall';
    slog({
      level: 'action', petId: this.config.id, category: 'ceiling.end', cause,
      before: { action: this.actionId, x: Math.round(this.container.x), y: Math.round(this.container.y) },
      after: { action: dropId },
      meta: {
        patrolMs: Math.round(this.ceilingPatrolMs),
        elapsedMs: Math.round(performance.now() - this.ceilingStartMs),
        maxMs: this.config.ceilingMaxMs ?? 20000,
      },
    });
    this.vy = 0.6; // 给一点向下初速，避免零速悬停在空中
    // 离开边缘区（同 dropFromWall）：贴顶巡逻到两端时 x 就在边框上，纯垂直掉落会被判「撞边 → 抓墙」
    const side = this.screenEdgeSide(10)
      ?? (this.container.x < window.innerWidth / 2 ? 'left' : 'right');
    this.vx = (side === 'left' ? 1 : -1) * Pet.CLIMB_DROP_VX;
    this.setAction(dropId, this.lastResolver);
  }

  /** 走近阶段：朝对方中心移动（x 优先、y 同步），速度按角色 moveSpeed。够近由 app 切 interact。 */
  private stepApproach(dt: number) {
    const p = this.meetPartner;
    if (!p) { this.cancelMeet(this.lastResolver); return; }
    const dx = p.container.x - this.container.x;
    const dy = p.container.y - this.container.y;
    const speed = (this.actionDef.moveSpeed ?? this.config.moveSpeed ?? 1.2);
    if (Math.abs(dx) > 2) {
      this.walkFacing(dx > 0);
      this.container.x += Math.sign(dx) * Math.min(Math.abs(dx), speed * dt);
    }
    if (Math.abs(dy) > 2) {
      this.container.y += Math.sign(dy) * Math.min(Math.abs(dy), speed * dt);
    }
    this.clampBounds();
  }

  /** 请求切换到一个「漫游/位移」动作（walk/climb/ceiling/chase 等），并设好目标点。 */
  public requestAction(id: string) {
    const def = this.config.actions[id];
    if (!def) return;
    this.walkArriveCb = null; // 任何新动作取消「走向目标」态（到达回调作废）
    // 攀爬冷却的**唯一收口**：冷却期内不得「抓到墙上」。
    // 必须放在 setAction 之前（否则会把动作切过去又什么都不做，等于更严重的卡住）。
    // 历史 P0：冷却原先只在 stepStatic / app.ts 两处检查，漏了 stepPhysics 的「下落撞边自动抓墙」
    // → 从墙顶掉落的那一帧立刻被重新抓回，climbStartMs 每次重置 → 8s 兜底永远不生效 → 顶部死循环。
    // 已在攀爬中（actionId === id）时放行，保证「同一会话内换目标点」不被自己挡住。
    if (def.behavior === 'climb' && this.actionId !== id && this.isClimbBlocked()) return;
    this.chainDepth = 0; // 位移类是序列的终点，接续深度复位
    this.setAction(id, this.lastResolver);
    // 位移类动作的目标点/会话初始化：requestAction 与 startAction（右键菜单手动触发）共用同一套逻辑，
    // 避免「菜单点攀爬却因 targetPos 陈旧而当场被 finishClimbOnGround 取消」（点了没反应）。
    this.setupPositionalTarget(id);
    // —— 统一收尾调度 ——
    // 位移类的兜底超时、static 动作的保持时长都在这里生效。必须放在 setAction 之后
    // （setAction 会清掉上一个动作的定时器）。旧版本 requestAction 不消费 durationMs，
    // 导致 wander 抽到的 sit（单帧 + 只靠 durationMs 结束）永久卡坐，只能手动打断。
    this.scheduleActionEnd(this.lastResolver);
  }

  /** 为位移类动作设好「目标点」与必要的会话状态（walk/climb/ceiling/fly/chase 各自逻辑）。
   *  requestAction（自动漫游）与 startAction（右键菜单手动触发）共用本方法，保证两条路径初始化一致 ——
   *  菜单路径若不在这里初始化，climb 的 targetPos 是陈旧值，stepClimb 会当场被 finishClimbOnGround 取消
   *  （表现为「点了边缘攀爬没反应」）。 */
  private setupPositionalTarget(id: string) {
    const def = this.config.actions[id];
    if (!def) return;
    const beh = def.behavior;
    if (beh === 'walk') {
      const w = this.config.size.width;
      // 局部游走：目标点只在当前位置 ±wanderRangePx 内取。
      // 旧逻辑是全屏随机取点，1920 屏上平均要走 640px（moveSpeed 1.2 ≈ 9 秒），
      // 而限时兜底只有 3.5s → 几乎每次都「走到一半被定时器切停」，表现为走着走着突然站住。
      const range = typeof this.config.wanderRangePx === 'number' ? this.config.wanderRangePx : 320;
      const maxX = Math.max(0, window.innerWidth - w);
      const cur = this.container.x;
      let tx = cur + (Math.random() * 2 - 1) * range;
      // 防抖：目标点离当前位置过近（<40px）会导致 walk 立刻到终点又切 idle 的微距抖动，重抽直到拉开距离
      let guard = 0;
      while (Math.abs(tx - cur) < 40 && guard++ < 8) tx = cur + (Math.random() * 2 - 1) * range;
      // 夹进屏幕后若又被压得太近（贴边时），朝屏幕内侧再取一次
      tx = Math.max(0, Math.min(maxX, tx));
      if (Math.abs(tx - cur) < 40) {
        const dir = cur > maxX / 2 ? -1 : 1;
        tx = Math.max(0, Math.min(maxX, cur + dir * Math.max(40, range * 0.5)));
      }
      this.targetPos = { x: tx, y: this.baselineY() };
    } else if (beh === 'climb') {
      // 攀爬贴着当前所在的屏幕边框上下移动；目标点由 pickClimbTarget 决定（顶/底折返 = 爬上爬下）
      this.perchTimer = 0;
      // 只有「新会话」才重置计时（会话结束点 = 落地 / 到期下墙 / 主动打断）。同一会话内换腿不重置，
      // 否则 climbMaxMs 上限会被无限推迟（见 climbSessionActive 注释里的历史 P0）。
      if (!this.climbSessionActive) {
        this.climbSessionActive = true;
        this.climbStartMs = performance.now();
        this.climbDir = -1; // 新会话默认先向上爬（从地面/边缘起步时向下的观感很怪）
      }
      this.pickClimbTarget();
    } else if (beh === 'ceiling') {
      // 贴顶爬：吸到屏幕顶端，横向选个目标
      this.container.y = 0;
      const w = this.config.size.width;
      let tx = Math.random() * (window.innerWidth - w);
      const cur = this.container.x;
      let guard = 0;
      while (Math.abs(tx - cur) < 60 && guard++ < 8) tx = Math.random() * (window.innerWidth - w);
      this.targetPos = { x: tx, y: 0 };
    } else if (beh === 'fly') {
      this.resetFlySession();
      if (def.flyMode === 'ceiling') {
        // 贴顶飞：先垂直升到顶端
        this.targetPos = { x: this.container.x, y: 0 };
      } else {
        // 自由飞行：屏幕内随机 2D 点（偏上半屏）
        const w = this.config.size.width, h = this.config.size.height;
        this.targetPos = {
          x: Math.random() * (window.innerWidth - w),
          y: Math.random() * Math.max(1, (window.innerHeight - h) * 0.7),
        };
      }
    } else if (beh === 'chase') {
      this.chaseMs = 0;
    }
  }

  /** 通用「走到屏幕某一列再回调」：walk 动作 + 到达检测（walkArriveCb）。
   *  窗口投掷的 approach 阶段（WindowInteract.startThrowShow）用本方法，因此自带两处守卫：
   *   - 行走期间 isWalkingToTarget === true → app.ts 的边缘攀爬调度器跳过，不会走到一半被抢去贴墙爬；
   *   - 撞屏幕边界时 stepWalk 不转攀爬（walkArriveCb 非空），撞墙即视为到达。
   *  x = 容器**左边缘**目标坐标（调用方自行减 宽/2），此处只夹进屏幕，不再二次偏移。
   *  无定时器：靠 walk 到达收尾；中途被其它动作/拖拽打断时，walkArriveCb 在
   *  requestAction / startAction / beginDrag 被清空（到达回调作废）。 */
  public walkToX(x: number, resolver: SpriteResolver, onArrive: () => void) {
    if (this.isDragging || this.isLeaving()) return;
    this.meetPhase = 'none';
    this.walkArriveCb = onArrive;
    this.setAction(this.config.walkAction || 'walk', resolver);
    const w = this.config.size.width;
    const tx = Math.max(0, Math.min(window.innerWidth - w, x));
    this.targetPos = { x: tx, y: this.baselineY() };
    this.scheduleActionEnd(resolver, 0); // 0 = 不挂定时器，仅由到达驱动
  }

  // 保存 resolver 引用供 requestAction 使用
  private lastResolver!: SpriteResolver;

  /** 按移动方向更新 facingRight（美术基础朝向影响翻转语义）。
   *  若当前动作配置了 rightFrames（双套图集），朝向翻转时重选左/右帧集，避免单图翻转导致镜像错误。 */
  private walkFacing(movingRight: boolean) {
    // 双套图集：L-/R- 已含方向，facingRight 直接等于"想面朝的方向"，不再用 config.facing 反转（否则 facing≠'left' 会反）
    // 单图：美术按 config.facing 方向绘制，翻转需 rightCounted 补偿
    const dual = Array.isArray(this.actionDef.rightFrames) && this.actionDef.rightFrames.length > 0;
    const want = dual ? movingRight : (movingRight !== ((this.config.facing || 'left') === 'right'));
    // 统一走 setFacing：帧集切换 + 翻转一起刷新（旧写法只改 facingRight，双套帧集不会跟着换 → 倒着走）
    this.setFacing(want);
  }

  private faceTowardPartner() {
    const p = this.findPartner();
    if (p) this.faceToward(p);
  }

  private faceToward(p: Pet) {
    const rightCounted = (this.config.facing || 'left') === 'right';
    const targetRight = p.container.x > this.container.x;
    // 旧写法只赋值 facingRight 不刷新帧集/翻转 → 相遇首帧到下一次换帧期间朝向是错的
    this.setFacing(targetRight !== rightCounted);
  }

  private findPartner(): Pet | null {
    for (const p of Pet.allInstances) if (p !== this) return p;
    return null;
  }

  public getPosition() {
    return {
      x: this.container.x + this.config.size.width / 2,
      y: this.container.y + this.config.size.height / 2,
    };
  }

  /** 拖拽摆动（Shimeji Pinched 等价逻辑）：
   *  - 容器弹簧缓动追向鼠标目标点（dragTarget），制造滞后偏移（位置仍整体跟随鼠标）；
   *  - 多帧倾斜素材（drag 动作含 swing-1/2/3）：用「目标中心 − 角色中心」的水平偏移选帧——
   *    偏移≈0→swing-1(正中，鼠标不动时静止显示该单帧，不播放动作)、偏移右→swing-2(向右倾)、
   *    偏移左→swing-3(向左倾)，倾斜由帧本身表达，故关闭容器旋转；
   *    tickAnimation 在拖拽期被挡，不再自动循环这三帧；
   *  - 无多帧倾斜素材的角色：退化为旧逻辑（容器旋转倾斜 + 二进制 drag/drag-idle 切换）；
   *  - 朝向始终锁定（facingRight 在拎起时定好，此处不翻转）。 */
  private updateDragTilt(dt: number) {
    if (!this.isDragging) {
      // 贴顶飞行时倾斜角由 stepFlyCeiling 每帧主动设置，此处不要复位（否则与它的设置互相打架）
      if (this.actionDef?.flyMode !== 'ceiling' && (this.tilt !== 0 || this.tiltNode.rotation !== 0)) {
        this.tilt = 0;
        this.tiltNode.rotation = 0;
      }
      this.tiltTarget = 0;
      this.dragTarget = null;
      return;
    }
    // 弹簧跟随：系数按 dt 归一 k = 1-(1-FOLLOW)^dt，任意刷新率手感一致；
    // FOLLOW 提到 0.30 → 60Hz 半周期约 32ms，跟手更紧（上一版 0.14 约 78ms 偏拖）。
    if (this.dragTarget) {
      const k = 1 - Math.pow(1 - Pet.DRAG_FOLLOW, dt);
      this.container.x += (this.dragTarget.x - this.container.x) * k;
      this.container.y += (this.dragTarget.y - this.container.y) * k;
      this.clampBounds();
    }
    // 水平滞后偏移（光标在右 → offsetX>0）
    const w = this.config.size.width;
    const centerX = this.container.x + w / 2;
    const targetCenterX = this.dragTarget ? this.dragTarget.x + w / 2 : centerX;
    const offsetX = targetCenterX - centerX;
    if (this.actionTextures.length >= 3) {
      // 【力度 → 帧】偏移≈0=正中(swing-1)；偏移右=向右倾(swing-2)；偏移左=向左倾(swing-3)。
      // 鼠标停住时弹簧跟随令 offsetX→0，故落下为 swing-1 单帧静止（不播放动作/动画）；
      // 倾斜完全由帧本身表达，关闭容器旋转。
      let fi = 0;
      if (offsetX > Pet.SWAY_FRAME_THRESH) fi = 1;
      else if (offsetX < -Pet.SWAY_FRAME_THRESH) fi = 2;
      const now = performance.now();
      if (fi !== this.frameIdx) {
        // 回正(swing-1)立即切，不卡 90ms；切到倾斜帧尊重最小保持 + 防抖（避免边缘快速抖动闪烁）
        const canSwitch = fi === 0
          || this.swayLastSwitchMs === 0
          || (now - this.swayLastSwitchMs) >= Pet.SWAY_FRAME_HOLD_MS;
        if (canSwitch) {
          this.frameIdx = fi;
          this.swayLastSwitchMs = now;
          const tex = this.actionTextures[fi];
          this.body.texture = tex;
          this.applySpriteSize(tex);
        }
      }
      // 帧本身已表达倾斜，关闭容器旋转
      this.tilt = 0;
      this.tiltNode.rotation = 0;
    } else {
      // 退化：未配置多帧倾斜素材的角色，沿用旧逻辑（旋转倾斜 + 二进制 drag/idle 切换）
      this.tiltTarget = Math.max(-Pet.MAX_SWAY, Math.min(Pet.MAX_SWAY, offsetX * Pet.SWAY_FACTOR));
      this.tilt += (this.tiltTarget - this.tilt) * 0.2;
      this.tiltNode.rotation = this.tilt;
      const sub = Math.abs(offsetX) > Pet.SWAY_FRAME_THRESH
        ? (this.config.dragAction || 'drag')
        : (this.config.dragIdleAction || this.config.dragAction || 'drag');
      if (this.actionId !== sub) this.setAction(sub, this.lastResolver);
    }
  }

  /** 开始拖拽（抓取）。localX/localY 为 stage 坐标系下的抓取点：
   *  - 直接命中：Pixi 局部坐标（container.parent 空间的指针位置）；
   *  - 下落中容差抓取：clientX/clientY（canvas 满屏 fixed 于 0,0，stage 坐标 = CSS 像素）。
   *  抽离自原 container.pointerdown 闭包，使「下落中容差抓取」可复用同一套拖拽/抛投逻辑。
   *  @param snapToCenter 下落容差接住时传 true，抓取锚点取「角色中心」而非「点击相对容器的偏移」，
   *    消除点击落在角色 body 外 40px 容差内导致的悬偏/跳位观感。 */
  public beginDrag(localX: number, localY: number, snapToCenter = false) {
    // 退场等待期(removePending)的宠物也拒绝捉起：否则松手后可能停在 isLeaving 态被 petAt 跳过、
    // 却仍显示在屏上 → 「看得见点不动」。isRemoving 已挡，这里补 removePending。
    if (this.isDragging || this.isRemoving || this.removePending) return;
    this.walkArriveCb = null; // 拖起即取消「走向目标」态（到达回调作废）
    // 拖起即退出任何合体/相遇占用态：否则 coopLead 残留会让 onUp 后重力永不接管，角色悬在半空
    // ⚠️ isDragging 必须在 exitCoopAndMeet 之后才置位：否则 exitCoopAndMeet→cancelMeet 内 physicsActive()
    // 会因 isDragging 为真而返回 false，导致下落中接住时 settleToBaselineIfGround 把空中角色瞬移屏幕底。
    this.exitCoopAndMeet(this.lastResolver, true);
    this.isDragging = true;
    this.dragMoved = false; // 本次按下复位，onMove 中真正移动才置位
    this.grabLineShown = false; // 本次抓取重置：说"放开我"等抓取台词的前置
    this.canTrip = true; // 被鼠标提起（离地），后续松手下落可能触发摔倒
    this.spawnSettling = false; // 被接管即退出开场缓冲期：这是真实交互，该摔就摔
    this.idleMs = 0;
    this.perchTimer = 0;           // 被抓住即打断攀爬
    this.climbSessionActive = false; // 会话结束：松手后再上墙重新获得完整 climbMaxMs 预算
    this.velX = 0; this.velY = 0; // 清空上一次拖拽残留的指针速度
    this.swayLastSwitchMs = 0; // 首次切帧立即生效，不被 90ms 保持时间挡
    this.dragTarget = null; // 防御：清掉上一次拖拽遗留的弹簧目标，避免接住瞬间继承旧位置导致角色跳位
    const dragId = this.config.dragAction || 'drag';
    if (this.actionId !== dragId) this.setAction(dragId, this.lastResolver);
    // 抓取锚点：普通拖拽=「在哪抓在哪拎」（点击点相对容器的偏移）；
    // 下落容差接住=「居中抓取」（角色中心贴光标），消除点击在角色附近 40px 容差内导致的悬偏/跳位观感
    let offX: number, offY: number;
    if (snapToCenter) {
      offX = this.config.size.width / 2;
      offY = this.config.size.height / 2;
    } else {
      offX = localX - this.container.x;
      offY = localY - this.container.y;
    }

    // 抛投速度采样辅助：用相邻 pointermove 事件的「真实指针位移」(非弹簧滞后) 并按事件间隔归一，
    // 使速度量级与刷新率/鼠标轮询率无关——否则不同机器上滞后量不同，会把「往上挪再松手」误判成向上抛投。
    let prevNx = this.container.x + offX;
    let prevNy = this.container.y + offY;
    let lastMoveT = performance.now();
    const onMove = (me: any) => {
      if (!this.isDragging || this.isRemoving) return;
      const p = me.getLocalPosition(this.container.parent);
      const nx = p.x - offX;
      const ny = p.y - offY;
      const dx = nx - this.container.x;
      const dy = ny - this.container.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.dragMoved = true; // 真正拖动过（带死区防抖）
      // 首次真正拖动（被抓起移动）时，说一句抓取台词（如「放开我！」），每只宠物本次抓取只说一次
      if (this.dragMoved && !this.grabLineShown) {
        this.grabLineShown = true;
        const g = this.config.grabDialogue;
        if (g && g.trim().length > 0) this.bubble.show(g, 1100);
      }
      // 拖拽期间【锁定朝向】：帧集在拎起时按当前 facingRight 选定（左→左帧 / 右→右帧），
      // 拖拽过程中不再随鼠标水平移动翻转。位置仍跟随鼠标，但改为「弹簧缓动」由 updateDragTilt
      // 每帧把容器追向目标点，制造滞后偏移 → 角色自然摆动（等价 Shimeji Pinched 的 FootX vs cursor.x）。
      // 摆动倾角与 idle/swing 帧切换都由该滞后偏移驱动，故「晃动随鼠标改变」。
      // 估算指针真实速度：取「相邻事件指针位移 ÷ 事件间隔」并归一化到 60fps 参考帧(px/帧)，
      // 再指数平滑（0.6 偏重最近帧）如实捕获松手瞬间的甩动。用 nx-prevNx（真实位移）而非 nx-container.x
      // （弹簧滞后量），否则角色还没追上鼠标时 dx 被夸大 → 松手误判向上抛投「飞起来」。
      const now = performance.now();
      const dtMove = Math.max(1, now - lastMoveT);
      const instVx = ((nx - prevNx) / dtMove) * (1000 / 60);
      const instVy = ((ny - prevNy) / dtMove) * (1000 / 60);
      this.velX = this.velX * 0.4 + instVx * 0.6;
      this.velY = this.velY * 0.4 + instVy * 0.6;
      prevNx = nx; prevNy = ny; lastMoveT = now;
      this.dragTarget = { x: nx, y: ny }; // 记录目标点，交给 updateDragTilt 弹簧跟随（不再即时贴光标）
    };
    const onUp = () => {
      this.isDragging = false;
      // 抛投惯性：把松手瞬间的指针速度转成初速度（系数缩放 + 限幅），由重力接管飞行+下落。
      // 轻轻放下时 velX/velY≈0 → 角色只受重力竖直下落（保留原"提起松手即落"行为）。
      // 指针速度→物理初速度：水平用 THROW_FACTOR/maxThrow（甩得远），竖直用独立上限 maxThrowV（避免竖直飞太高、在抛物线顶点停留过久）。
      const THROW_FACTOR = this.config.throwFactor ?? 1.0;  // 指针速度→物理初速度 的系数（≈1 时最接近 Shimeji 手感；设为 0 = 彻底关闭抛投，松手一律正常掉落）
      const MAX_THROW = this.config.maxThrow ?? 32;          // 水平初速度上限(px/帧)，参考 Shimeji ThrowIe InitialVX=32
      const MAX_THROW_V = this.config.maxThrowV ?? 24;       // 竖直初速度上限(px/帧)：更小→飞不高、落得快、不飘
      // 抛投判定（参考 Shimeji「Thrown」：直接取松手时指针速度当初速度，无直线度门槛）：
      // 松手瞬间指针速度模 < THROW_DEADZONE → 视为「轻轻放下」，仅受重力自由落体；
      // 否则按指针速度方向抛出。任何方向的甩动（含弧线）都能可靠抛出，不再误判为晃动。
      const idleMs = performance.now() - lastMoveT;
      // 松手前已停顿(>THROW_IDLE_MS 无指针移动)→视为「轻轻放下」而非抛投：
      // 清掉残留速度，避免「往上挪→停顿→松手」被旧逻辑当成向上猛甩而飞起来。
      const settled = idleMs > Pet.THROW_IDLE_MS;
      const releaseSpeed = Math.hypot(this.velX, this.velY);
      if (settled || releaseSpeed < Pet.THROW_DEADZONE || THROW_FACTOR === 0) {
        this.vx = 0; this.vy = 0; // 轻轻放下 / 几乎没动 → 正常掉落
      } else {
        this.vx = Math.max(-MAX_THROW, Math.min(MAX_THROW, this.velX * THROW_FACTOR));
        this.vy = Math.max(-MAX_THROW_V, Math.min(MAX_THROW_V, this.velY * THROW_FACTOR));
        // 抛出朝向：水平分量明显时面朝甩出方向（vx>0 向右 / vx<0 向左），
        // 让下落/落地姿态与飞行方向一致；近似竖直抛时保留拖拽锁定朝向，不翻转。
        if (Math.abs(this.vx) > 0.1) this.setFacing(this.vx > 0);
      }
      this.canTrip = true; // 本次是被鼠标提起/抛出后松手，落地可能触发摔倒
      this.spawnSettling = false;
      this.velX = 0; this.velY = 0;
      // 松手复位倾斜，让角色竖直飞行/下落（由物理接管位置）
      this.tilt = 0;
      this.tiltTarget = 0;
      this.tiltNode.rotation = 0;
      this.container.off('globalpointermove', onMove);
      this.container.off('pointerup', onUp);
      this.container.off('pointerupoutside', onUp);
      // 退场中（程序退出等场景）松手：不得重置动作/施加抛投初速，否则会打断正在播放的退场动画
      if (this.isRemoving) {
        this.tilt = 0; this.tiltTarget = 0; this.tiltNode.rotation = 0;
        return;
      }
      // 松手后的穿透态交由 app.ts reconcile() 在下一个 mouseup/mousemove 统一重算
      // （拖拽结束瞬间 isDragging 已复位，无需在此手动切穿透）
      // 松手回到默认动作（飞行/下落过程播放默认帧，由 physics 接管位置）
      this.setAction(this.config.defaultAction || 'idle', this.lastResolver);
      this.applyFacing(); // 抛出/松手后按当前 facingRight 即时翻转（setAction 内部不调 applyFacing）
    };
    this.container.on('globalpointermove', onMove);
    this.container.on('pointerup', onUp);
    this.container.on('pointerupoutside', onUp);
    eventBus.emit(EVENTS.USER_CLICK, { id: this.config.id });
  }

  /** 是否贴着屏幕左/右边框（供 app 触发攀爬）。edge=距离边框小于该阈值(px)算碰边。 */
  public atScreenEdge(edge = 8): boolean {
    const left = this.container.x <= edge;
    const right = this.container.x + this.config.size.width >= window.innerWidth - edge;
    return left || right;
  }
  /** 当前贴的是哪条边，'left' | 'right' | null */
  public screenEdgeSide(edge = 8): 'left' | 'right' | null {
    if (this.container.x <= edge) return 'left';
    if (this.container.x + this.config.size.width >= window.innerWidth - edge) return 'right';
    return null;
  }

  /** 地面高度（容器坐标 y）：外部编排（窗口投掷等）把角色贴回地面时用，
   *  与 clampBounds / settleToBaselineIfGround 取的是同一个 baselineY。 */
  public groundY(): number { return this.baselineY(); }

  private baselineY(): number {
    return Pet.getFloor() - this.config.size.height - (this.config.bottomMargin || 0);
  }

  /** wander 触发概率：**与帧率无关**。
   *  旧写法是「每帧固定 1%」，等价于把频率绑在刷新率上——144Hz 屏的动作密度是 60Hz 的 2.4 倍，
   *  掉帧时又反过来变迟钝。改为指数分布：单位时间发生率恒定，p = 1 - e^(-dt/τ)，
   *  任意帧率下累积到同一时刻的触发概率一致。τ = wanderTauMs，默认 1667ms
   *  （= 旧版 60fps 下 1%/帧 的期望等待 100 帧），因此 60Hz 下体感不变，高刷屏不再抽风。 */
  private wanderChance(dtMs: number): number {
    const tau = typeof this.config.wanderTauMs === 'number' ? this.config.wanderTauMs : 1667;
    if (tau <= 0) return 1;
    return 1 - Math.exp(-dtMs / tau);
  }

  private clampBounds() {
    const allowEdge = this.actionDef?.behavior === 'climb' || this.actionDef?.behavior === 'ceiling';
    const margin = this.config.edgeMargin || 0;
    const minX = allowEdge ? -margin : 0;
    const maxX = window.innerWidth - this.config.size.width + (allowEdge ? margin : 0);
    this.container.x = Math.max(minX, Math.min(this.container.x, maxX));
    // 纵向下界用「地面」（workArea 底边）：任务栏显示时角色不许沉入任务栏区域
    const maxY = Pet.getFloor() - this.config.size.height;
    this.container.y = Math.max(0, Math.min(this.container.y, maxY));
  }

  /** workArea 变化（任务栏显示/隐藏、分辨率变化）后的重新落位：
   *  在地面附近（含略低于新地面）的角色吸附到新地面；所有角色 clamp 进新边界。 */
  public resettle() {
    const base = this.baselineY();
    if (!this.isDragging && !this.isRemoving
      && this.actionDef?.behavior !== 'climb' && this.actionDef?.behavior !== 'ceiling'
      && this.container.y >= base - 2) {
      this.container.y = base;
    }
    this.clampBounds();
  }

  /** 右键菜单弹出时的「静止」。
   *  - 角色**在地面**（动作可落地 + 已贴下沿 + 无残余速度）→ 打断走动/惯性、切站立帧、贴回地面。
   *  - 角色**在墙上 / 贴顶 / 飞行 / 空中** → 只冻结：清速度、定时器、相遇态，但**既不换动作也不改位置**，
   *    并置 menuHold 让 update() 整体停摆（= 「右键时不动」）。
   *
   *  【历史 bug】旧实现无条件 `settleToBaselineIfGround()`，于是**攀爬中右键会把人瞬移回地面**。
   *  菜单关闭时由 resumeAfterMenu() 解冻；菜单里选了动作时由 queueOnLandAndDrop()/startAction 接手。 */
  public standStill(resolver: SpriteResolver) {
    if (this.isDragging || this.isRemoving) return;
    this.vx = 0;
    this.vy = 0;
    this.canTrip = false;
    this.chainDepth = 0;
    this.meetPhase = 'none';
    this.meetPartner = null;
    this.perchTimer = 0;
    this.pendingAdvance = false; // 作废「等轮末收尾」的待办，否则冻结期间会被它切走动作
    if (this.actionTimer !== null) {
      window.clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
    this.idleMs = 0;
    if (!this.isGroundBound()) {
      // 非地面（climb / ceiling / fly / 空中下落）→ 原地冻结，位置与动作都不动
      this.menuHold = true;
      return;
    }
    // 地面：站住（保证随后的动作从「站在地上的站立帧」开始，无残影位移）
    this.menuHold = false;
    this.climbSessionActive = false; // 在地面被菜单打断 → 攀爬会话结束
    this.setAction(this.config.defaultAction || 'idle', resolver);
    this.settleToBaselineIfGround();
  }

  /** 角色是否「站在可用地面上」：动作能落地（非 climb/ceiling/fly/drag）、已贴下沿、且无残余速度。 */
  public isGroundBound(): boolean {
    const beh = this.actionDef?.behavior;
    if (beh === 'climb' || beh === 'ceiling' || beh === 'fly' || beh === 'drag') return false;
    if (this.container.y < this.baselineY() - 0.5) return false; // 仍在空中
    return this.vx === 0 && this.vy === 0;
  }

  /** 角色是否处于「需要先落地」的状态：攀爬(climb)/贴顶(ceiling)/飞行(fly)/拖拽(drag)，或仍在下落（y 高于地面）。
   *  与 isGroundBound 的区别：不要求 vx/vy===0——**正在走动**的角色不算「需要落地」，可直接开始合体/配对，
   *  否则会把正常走路的宠物也误判成空中、被强制掉落（回归 bug）。供 app.ts 的合体落地闸门使用。 */
  public isAirborne(): boolean {
    const beh = this.actionDef?.behavior;
    if (beh === 'climb' || beh === 'ceiling' || beh === 'fly' || beh === 'drag') return true;
    return this.container.y < this.baselineY() - 0.5;
  }

  /** 菜单关闭但没选动作 → 解除冻结，行为/物理自然接管（攀爬从原位置继续爬）。 */
  public resumeAfterMenu() {
    if (!this.menuHold) return;
    this.menuHold = false;
  }

  /**
   * 右键菜单「点一级动作组 = 随机抽一个样式」的统一入口：随机挑一个变体 id。
   * 池里只剩一个动作时直接返回它；找不到动作返回 null（调用方负责忽略）。
   */
  public pickMenuVariant(pool: string[]): string | null {
    const valid = pool.filter((id) => !!this.config.actions[id]);
    if (valid.length === 0) return null;
    return valid[Math.floor(Math.random() * valid.length)];
  }

  /** 下一次 startAction 是否要随机朝向（仅右键菜单「点一级动作组」时置位，用完即清）。 */
  public randomFacingNext = false;

  /** 菜单选了「地面动作」而角色不在可用地面时：登记「落地后执行」的回调并释放下落。
   *  落地那一刻由 stepPhysics 调该回调 → 满足「先掉落到地上再衔接其他动作」。 */
  public queueOnLandAndDrop(cb: () => void, resolver: SpriteResolver) {
    this.menuHold = false; // 解冻，让物理接管
    this.pendingOnLand = cb;
    this.climbSessionActive = false;
    this.perchTimer = 0;
    // 攀爬冷却覆盖整个下落过程：否则从墙顶松手后会被 stepPhysics 的「下落撞边 → 抓墙」重新抓回墙上
    // （表现为「右键点了地面动作，人却又爬回去了」）。
    this.blockClimb();
    this.vy = 0.6; // 给一点向下初速，避免零速悬停
    const side = this.screenEdgeSide(10)
      ?? (this.container.x < window.innerWidth / 2 ? 'left' : 'right');
    this.vx = (side === 'left' ? 1 : -1) * Pet.CLIMB_DROP_VX; // 离开边缘区，落点不再贴着墙
    this.setAction(this.config.fallAction || 'fall', resolver);
  }

  /** 开始退场（删除角色）：专属 removeAction 帧优先（播 removeActionMs），
   *  随后通用淡出（alpha→0 + 上浮 + 缩小）。完成后 resolve，由调用方移除实例。
   *  期间 isRemoving=true，update 仅推进帧动画，不再做任何行为/物理位移。
   *
   *  【先落地再消失】人不在地上（攀爬/贴顶/飞行/空中）时，先掉回地面再播退场动画——
   *  否则「爆烟变身飞走」会演在半空中/墙面上，脚下悬空，观感不对。
   *  落地等待期间不能置 isRemoving（一置 update 就跳过物理、永远落不了地），
   *  所以另用 removePending 标记，调度侧统一看 isLeaving()。 */
  /** 退场动画的耗时上限估算(ms)：「先落地」等待 + 专属动作 + 通用淡出。
   *  供 app.ts 关闭程序时的兜底超时使用——写死 2500ms 会把 bye(2400)+淡出(300) 的尾巴切掉，
   *  加了落地等待后更是会在人还在半空时就强退。 */
  public estimateRemoveBudgetMs(): number {
    const actMs = Math.max(0, this.config.removeActionMs ?? 700);
    const fadeMs = Math.max(0, this.config.removeFadeMs ?? 400);
    const landMs = this.isAirborne() && !this.isDragging ? Pet.REMOVE_LAND_TIMEOUT_MS : 0;
    return landMs + actMs + fadeMs;
  }

  public beginRemove(resolver: SpriteResolver, overrideAction?: string): Promise<void> {
    if (this.isRemoving || this.removePending) return Promise.resolve();
    // 拖拽中不抢：isDragging 会冻结物理，硬排落地会永远等不到 → 直接原地演退场
    if (this.isAirborne() && !this.isDragging) {
      this.removePending = true;
      return new Promise<void>((res) => {
        this.tiltNode.rotation = 0; // 贴顶飞的倾斜角要复位，否则落地后人是歪的
        this.tilt = 0;
        let settled = false;
        const goRemove = () => {
          if (settled) return;
          settled = true;
          this.removePending = false;
          this.beginRemove(resolver, overrideAction).then(res);
        };
        this.queueOnLandAndDrop(goRemove, resolver);
        // 兜底：物理万一没接管（极端情况），超时后照常演退场，不把退出流程卡死
        window.setTimeout(() => {
          if (this.pendingOnLand) this.pendingOnLand = null;
          goRemove();
        }, Pet.REMOVE_LAND_TIMEOUT_MS);
      });
    }
    this.isRemoving = true;
    this.meetPhase = 'none';
    this.meetPartner = null;
    // 退出合体占用：必须同时清搭档对自己的反向引用——否则搭档 isInCoop() 残留，
    // 其合体定时器未到点前会一直挡住全局「同时只能有一组合体」互斥锁
    // （表现为点别的合体没反应，直到定时器自然到点才自愈）。拖拽路径走 exitCoopAndMeet 已双向清理，这里补上。
    if (this.coopLead) {
      const follower = this.coopLead;
      follower.coopFollow = null;
      follower.coopActionId = null;
      follower.container.visible = true;
      this.coopLead = null;
    }
    if (this.coopFollow) {
      const lead = this.coopFollow;
      lead.coopLead = null;
      lead.coopActionId = null;
      this.coopFollow = null;
      this.container.visible = true;
    }
    this.perchTimer = 0;
    this.climbSessionActive = false;
    if (this.actionTimer !== null) {
      window.clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
    this.bubble.hide();
    const actMs = Math.max(0, this.config.removeActionMs ?? 700);
    const fadeMs = Math.max(0, this.config.removeFadeMs ?? 400);
    // 优先用传入的覆盖动作（程序退出时的 exitAction），否则用退场 removeAction
    const actId = overrideAction || this.config.removeAction;
    const actDef = actId ? this.config.actions[actId] : undefined;
    const act = actDef
      ? new Promise<void>((res) => {
        this.setAction(actId as string, resolver);
        window.setTimeout(res, actMs);
      })
      : Promise.resolve();
    return act.then(() => new Promise<void>((res) => {
      if (fadeMs <= 0) { res(); return; }
      const t0 = performance.now();
      const y0 = this.container.y;
      const x0 = this.container.scale.x;
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / fadeMs);
        this.container.alpha = 1 - k;
        this.container.y = y0 - 24 * k; // 轻微上浮，强化「离开」语义
        this.container.scale.set(x0 * (1 - 0.25 * k));
        if (k < 1) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    }));
  }

  // ============ 重力 / 物理下落 ============

  /** 是否进入物理下落：离地(y 高于底边)或仍有速度，且不处于受控态(拖拽/合体/相遇)。 */
  private physicsActive(): boolean {
    if (this.isDragging || this.coopFollow || this.coopLead) return false;
    if (this.meetPhase !== 'none') return false;
    // 攀爬/贴顶/飞行 行为自带垂直控制，不能被重力接管（否则飞行一离地就被拽回地面）
    if (this.actionDef?.behavior === 'climb' || this.actionDef?.behavior === 'ceiling' || this.actionDef?.behavior === 'fly') return false;
    const airborne = this.container.y < this.baselineY() - 0.5;
    return airborne || this.vy !== 0 || this.vx !== 0;
  }

  /** 重力下落 + 落地处理（触发摔倒 / 小弹跳 / 归位）。dt 为单位帧(1≈1/60s)。 */
  private stepPhysics(dt: number, resolver: SpriteResolver) {
    // 上一版加的 vyRegistance / vxRegistance + Math.pow 跨帧缩放感太"硬"（用户 v0.4.x 反馈"改完手感问题大"），
    // 回退到旧版手感：重力按 config.gravity（默认 0.8）累加 vy，无竖直阻尼；
    // 水平保留 0.99 的轻阻尼（v0.2.x 起的实现，足够让"抛物线峰值水平滑一点"）。
    // 想再追 Nina 风格的硬收敛：单独打开落地分支里 vx*=0.6 / restitution 0.35 即可。
    const g = this.config.gravity ?? 0.8;
    this.vy += g * dt;
    this.container.y += this.vy * dt;
    this.container.x += this.vx * dt;
    this.vx *= Math.pow(0.99, dt); // dt 归一：任意刷新率落地后水平滑距一致

    const floor = this.baselineY();
    // 空中下落阶段显示"掉落"帧：开场掉落优先用 spawnAction（专属入场帧），否则 fallAction；不覆盖脚本动作
    const dropAction = this.spawnFalling && this.config.spawnAction
      ? this.config.spawnAction
      : (this.config.fallAction || 'fall');
    const airborne = this.container.y < floor - 0.5;
    const scripted = this.actionId === 'tripping' || this.meetPhase !== 'none';
    if (airborne && !scripted && this.actionId !== dropAction) {
      this.setAction(dropAction, resolver);
    }
    // 下落中碰到屏幕左右边框 → 改攀爬，不再掉到地面（覆盖"拖/抛到边缘"也必须爬的需求）
    // 但必须尊重攀爬冷却：否则「从墙顶松手掉落」的那一帧就被重新抓回墙上，
    // 与 stepClimb 的到顶出口形成 climb↔fall 死循环，观感就是「爬到最上面卡住不动」。
    const climbId = this.config.climbAction || 'climb';
    if (airborne && this.atScreenEdge(6) && this.config.actions[climbId] && !this.isClimbBlocked()) {
      this.vx = 0; this.vy = 0;
      this.requestAction(climbId);
      return;
    }
    if (this.container.y >= floor) {
      // 本次落地是否属于「开场掉落」——必须在下面置 false 之前取出来
      const wasSpawnDrop = this.spawnFalling;
      this.spawnFalling = false; // 落地即结束开场掉落态，后续离地按正常 fallAction 处理
      // 开场第一次触地 = 进入「缓冲期」：之后照常弹跳，但不再判摔倒 / 不再播触地动画
      if (wasSpawnDrop) this.spawnSettling = true;
      this.climbSessionActive = false; // 落地 = 攀爬会话结束：下次上墙重新获得完整的 climbMaxMs 预算
      // 冷却从「落地」重新起算（climbCooldownMs 的文档语义就是「从墙上下来后的一段时间内不再触发攀爬」）。
      // 否则若落地时人正好在边缘区（抛/飞到边缘再落下），冷却可能已过期 → 站着不动时被 stepStatic 立刻抓回墙上。
      this.blockClimb();
      const impact = this.vy; // 下落为正
      this.container.y = floor;
      const tripTh = this.config.tripThreshold ?? 12;
      const bounceTh = this.config.bounceThreshold ?? 4;
      // —— 右键菜单「先掉落到地再衔接动作」：不做摔倒/弹跳，落地即执行待办（确定性优先，
      //    否则从墙顶/贴顶掉下来的巨大冲击会先弹几下、待办动作被推迟到几秒后）——
      if (this.pendingOnLand) {
        const cb = this.pendingOnLand;
        this.pendingOnLand = null;
        this.vy = 0;
        this.vx = 0;
        cb();
      } else if (impact >= tripTh && this.canTrip && !this.spawnSettling) {
        // 重摔 → 摔倒动画
        this.canTrip = false;
        this.vy = 0;
        this.vx = 0;
        this.requestTrip(resolver);
      } else if (Math.abs(impact) >= bounceTh) {
        // 中小落地 → 弹起一次（restitution 固定 0.35）
        this.vy = -impact * 0.35;
        this.vx *= 0.6;
      } else {
        // 轻微落地（本次下落最终静止）→ 先播「触地」一次性动画（landAction，如 fall-2/3/4 触地缓冲），
        // 播完由 advanceAfterAction 自动接续回默认动作；未配置 landAction 时沿用旧行为直接回默认。
        // 注意：弹跳中(|impact| >= bounceTh)不播触地动画——那一次还没真正停下来。
        this.vy = 0;
        this.vx = 0;
        if (this.spawnSettling) {
          // 开场弹跳彻底停下 → 缓冲期结束，直接站稳（不播触地动画：入场不是被摔）
          this.spawnSettling = false;
          this.setAction(this.config.defaultAction || 'idle', resolver);
        } else {
          const landId = this.landActionId();
          if (landId) {
            this.startAction(landId, resolver);
          } else if (this.actionId !== (this.config.defaultAction || 'idle')) {
            this.setAction(this.config.defaultAction || 'idle', resolver);
          }
        }
      }
    }
    this.clampBounds();
  }

  /** 触地动作 id：优先角色配置 landAction；未配则约定回退到名为 'land' 的动作。
   *  （回退是防御：配置层若漏传字段，也不至于让触地动画静默失效。） */
  private landActionId(): string | undefined {
    const id = this.config.landAction;
    if (id && this.config.actions[id]) return id;
    if (this.config.actions['land']) return 'land';
    return undefined;
  }

  /** 受击/被推飞：施加抛物线初速度（vx 水平、vy 竖直，负=向上）。 */
  public applyImpulse(vx: number, vy: number) {
    // —— 监管埋点：抛投参数异常溯源——
    slog({ level: 'physics', petId: this.config.id, category: 'physics.thrown',
      cause: 'applyImpulse',
      before: { vx: this.vx, vy: this.vy },
      after: { vx, vy },
      meta: { gravity: this.config.gravity ?? 0.8, maxThrowV: this.config.maxThrowV ?? 24 } });
    this.vx = vx;
    this.vy = vy;
    this.canTrip = true;
    this.spawnSettling = false;
  }

  /** 触发摔倒动作（若存在 tripping），否则退化：有 landAction 先播触地动画，再回默认动作。 */
  private requestTrip(resolver: SpriteResolver) {
    if (this.config.actions['tripping']) {
      this.startAction('tripping', resolver, this.config.tripDurationMs ?? 1200);
      return;
    }
    // 没画摔倒动画的角色（如 rose）：重摔落地也别直接跳 idle，先用触地帧缓冲一下
    const landId = this.landActionId();
    if (landId) {
      this.startAction(landId, resolver);
      return;
    }
    this.setAction(this.config.defaultAction || 'idle', resolver);
  }

  /** 当前鼠标悬停的角色（供 app.ts 的原生 contextmenu 监听判断右键点的是谁）。 */
  static hoveredPet: Pet | null = null;
  /** 是否有右键菜单打开中（打开期间 pointerout 不得恢复穿透，否则菜单项点不动）。 */
  static menuOpen = false;

  // ============ 交互（鼠标）============

  private setupInteractions() {
    this.container.eventMode = 'static';
    this.container.cursor = 'pointer';

    this.container.on('pointerover', () => {
      Pet.hoveredPet = this; // 备用命中；实际穿透开关由 app.ts reconcile() 统一驱动
    });
    this.container.on('pointerout', () => {
      if (Pet.hoveredPet === this) Pet.hoveredPet = null;
    });

    this.container.on('pointerdown', (e: any) => {
      if (e.button === 2) return; // 右键交给原生 contextmenu
      const lp = e.getLocalPosition(this.container.parent);
      this.beginDrag(lp.x, lp.y);
    });

    this.container.on('pointertap', () => {
      // 若是「提起拖拽后松手」，Pixi 也会补发 pointertap —— 此时不应弹气泡（否则下落途中仍挂着气泡）
      if (this.dragMoved) { this.dragMoved = false; return; }
      this.idleMs = 0;
      // 轻触对话：从角色配置的 tapDialogue 随机说一句；未配置则安静
      const lines = (this.config.tapDialogue || []) as string[];
      if (lines.length > 0) this.bubble.show(this.rand(lines));
    });
  }
}
