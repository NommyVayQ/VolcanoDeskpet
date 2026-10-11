/**
 * 窗顶专属行为编排（复刻旧桌宠 Shimeji ニナ `conf/behaviors.xml` 的「On Top of IE」条件组）。
 *
 * ## ⚠️ 范围：只做窗口**顶边**（`activeIE.topBorder`）
 *   - **不做** IE 底边悬挂（`ClimbIEBottom` / `GrabIEBottom`）—— 用户明确不要；
 *   - **不做** IE 侧壁攀爬（`HoldOntoIEWall` / `ClimbIEWall`）—— 2026-10-10 已整体删除，
 *     本引擎没有 Wall 地面模型，外挂状态机必然边界 bug 成堆；要再做须先把 Wall Border 融进 Pet 物理。
 *   - 名字里的 `ceiling`（`behavior:'ceiling'`、贴顶飞行）是**屏幕顶**，与窗口无关，别混淆。
 *
 * ## 权威来源（javap -c 读 `Nina Hand.jar` 字节码 + conf 原文，非猜测）
 *
 * behaviors.xml L117-135：整组行为挂在同一条 Condition 下
 *   `<Condition Condition="#{mascot.environment.activeIE.topBorder.isOn(mascot.anchor)}">`
 *   且每条都 `Hidden="true"` —— **不进右键菜单**，只在「站在窗口顶边」时自发。
 *
 * actions.xml L503-563：每条行为都是 Sequence，先 `<ActionReference Walk/Run/Creep TargetX=...>`
 * 再接 Stand / Sit / Falling+Bouncing，值全部随机：
 *   WalkAlongIECeiling        Walk  → AE.left+64+rand*(width-128)
 *   RunAlongIECeiling         Run   → 同上
 *   CrawlAlongIECeiling       Creep → 同上                       （Frequency 10，其余都是 100）
 *   SitOnTheLeftEdgeOfIE      Walk  → AE.left+100+rand*300       → Stand(100+rand100) → Sit(500+rand1000)
 *   SitOnTheRightEdgeOfIE     Walk  → AE.right-100-rand*300      → 同上
 *   JumpFromLeftEdgeOfIE      Walk  → AE.left+rand*50            → Stand(50+rand50) → Falling(VX=-15-rand5, VY=-20-rand5) → Bouncing
 *   JumpFromRightEdgeOfIE     Walk  → AE.right-rand*50           → Falling(VX=+15..20, VY 同上)
 *   WalkLeftAlongIEAndSit     Run   → AE.left+100+rand*300       → Stand(100+rand100) → Sit(500+rand1000)
 *   WalkRightAlongIEAndSit    Run   → AE.right-100-rand*300      → 同上
 *   WalkLeftAlongIEAndJump    Run   → AE.left+rand*50            → Falling(VX=-15-rand5, VY=-20-rand5) → Bouncing
 *   WalkRightAlongIEAndJump   Run   → AE.right-rand*50           → Falling(VX=+15..20, VY 同上)
 *
 *   另：L54 `CrawlAlongIECeiling` 还额外挂在别的 Behavior 的 NextBehavior 里（Freq 100），
 *   这里不重复建模 —— 本池里已经有它，效果等价。
 *
 * ## 单位换算（务必留档）
 * 旧版 Pose 的 Velocity/Duration 单位是 **px / tick（tick = 40ms）**；
 * 本引擎 `Pet` 的速度单位是 **px / 帧（60fps ≈ 16.7ms）** → 换算系数 = 40 / 16.67 ≈ 2.4。
 *   InitialVX 15~20 px/tick → 6.25~8.33 px/帧
 *   InitialVY 20~25 px/tick → 8.33~10.42 px/帧
 * 配上本引擎 gravity 0.8 px/帧²：起跳高度 ≈ 43px、水平飞行 ≈ 130px —— 从窗边跃下的一段抛物线，量级正确。
 *
 * ## 本引擎落地方式（与「窗顶 = 地面」一致）
 * 行为本身**不改 Pet 的运行模式**：走到目标用 `walkToX`（现有 walk behavior），站/坐用现有 static 动作，
 * 「跳下」= 先由 WindowInteract 解除绑定把地面还原为屏幕底边，再 `pet.launch(vx, vy)` 交给 `stepPhysics`
 * 接管（自动切掉落帧 → 落地弹跳 → 回待机）。因此站在窗顶时她**照常能左右走、能 wander 做别的动作**，
 * 窗顶行为只是「在窗顶时额外多出来的一组自发编排」。
 */
import { Pet } from './Pet';
import { SpriteResolver } from './SpriteResolver';
import type { WinInfo } from './windowInteract';

/** 旧版 tick(40ms) → 本引擎帧(≈16.7ms) 的速度换算系数。 */
const TICK_TO_FRAME = 2.4;
/** 两次窗顶行为之间的间隔范围（旧版靠 behavior 调度器的固有节奏，这里给一个不打扰的等待窗）。 */
const GAP_MIN_MS = 1200;
const GAP_MAX_MS = 3600;
/** 单条行为的整体超时（正常远小于此值；走到/等待任一环节卡住时的兜底）。 */
const PLAN_TIMEOUT_MS = 25000;
/** 「她在忙别的（不在待机）」时，隔多久再来看一次。 */
const BUSY_RETRY_MS = 1500;

/** 移动段的三种步态。run = 同一套走帧加速 2 倍（旧版 Walk Velocity=2 / Run=4，正好 2 倍），
 *  creep = 换成 creep 动作但仍是 walk 位移模式（和地面上爬行完全一致）。 */
type Gait = 'walk' | 'run' | 'creep';

/** 到位之后的步骤（逐条对齐 actions.xml 的 ActionReference 序列）。 */
type CeilStep =
  | { kind: 'stand'; minMs: number; maxMs: number }
  | { kind: 'sit'; minMs: number; maxMs: number }
  | { kind: 'jump'; vxMin: number; vxMax: number; vyMin: number; vyMax: number };

interface CeilBehavior {
  /** 沿用旧版行为名，方便对照 conf 排查。 */
  id: string;
  /** behaviors.xml 里的 Frequency。 */
  weight: number;
  move?: Gait;
  /** 额外需要的动作 id（creep 需要角色有 'creep' 帧，否则该项不入池）。 */
  need?: string;
  /** 该行为**能成立的最小窗宽**：由 anchorX 公式的最大偏移量反推，保证目标锚点必落在窗口跨度内
   *  （锚点出窗 = 横向中心离开窗口 = `isOn` 不成立 = 掉下去）。
   *  ⚠️ 不要用「有没有 Stand/Sit 步骤」当判据 —— 那是拍脑袋的，和公式量级对不上。 */
  minW: number;
  /** 目标锚点 x（= 角色中心；容器左边缘 = 该值 − 半个身位）。 */
  anchorX(w: WinInfo): number;
  steps: CeilStep[];
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** Walk/Run/Creep 三条「沿着窗顶走到窗内随机某列」的公共部分 = activeIE.left+64+rand*(width-128)。 */
const alongFloor = (id: string, weight: number, gait: Gait, need?: string): CeilBehavior => ({
  id, weight, move: gait, need, minW: 128, // 公式左端偏移 64、右端留 64 → 窗宽 <128 时目标会贴出窗沿
  anchorX: (w) => w.x + 64 + Math.random() * Math.max(0, w.w - 128),
  steps: [],
});

/** 全部 11 条，权重逐条来自 behaviors.xml（Crawl=10，其余=100）。 */
const BEHAVIORS: CeilBehavior[] = [
  alongFloor('WalkAlongIECeiling', 100, 'walk'),
  alongFloor('RunAlongIECeiling', 100, 'run'),
  alongFloor('CrawlAlongIECeiling', 10, 'creep', 'creep'),
  {
    id: 'SitOnTheLeftEdgeOfIE', weight: 100, move: 'walk', minW: 400, // 公式最大偏移 400
    anchorX: (w) => w.x + rnd(100, 400),
    steps: [{ kind: 'stand', minMs: 100, maxMs: 200 }, { kind: 'sit', minMs: 500, maxMs: 1500 }],
  },
  {
    id: 'SitOnTheRightEdgeOfIE', weight: 100, move: 'walk', minW: 400,
    anchorX: (w) => w.x + w.w - rnd(100, 400),
    steps: [{ kind: 'stand', minMs: 100, maxMs: 200 }, { kind: 'sit', minMs: 500, maxMs: 1500 }],
  },
  {
    id: 'JumpFromLeftEdgeOfIE', weight: 100, move: 'walk', minW: 64, // 公式最大偏移 50
    anchorX: (w) => w.x + rnd(0, 50),
    steps: [{ kind: 'stand', minMs: 50, maxMs: 100 }, { kind: 'jump', vxMin: -20, vxMax: -15, vyMin: -25, vyMax: -20 }],
  },
  {
    id: 'JumpFromRightEdgeOfIE', weight: 100, move: 'walk', minW: 64,
    anchorX: (w) => w.x + w.w - rnd(0, 50),
    steps: [{ kind: 'stand', minMs: 50, maxMs: 100 }, { kind: 'jump', vxMin: 15, vxMax: 20, vyMin: -25, vyMax: -20 }],
  },
  {
    id: 'WalkLeftAlongIEAndSit', weight: 100, move: 'run', minW: 400,
    anchorX: (w) => w.x + rnd(100, 400),
    steps: [{ kind: 'stand', minMs: 100, maxMs: 200 }, { kind: 'sit', minMs: 500, maxMs: 1500 }],
  },
  {
    id: 'WalkRightAlongIEAndSit', weight: 100, move: 'run', minW: 400,
    anchorX: (w) => w.x + w.w - rnd(100, 400),
    steps: [{ kind: 'stand', minMs: 100, maxMs: 200 }, { kind: 'sit', minMs: 500, maxMs: 1500 }],
  },
  {
    id: 'WalkLeftAlongIEAndJump', weight: 100, move: 'run', minW: 64,
    anchorX: (w) => w.x + rnd(0, 50),
    steps: [{ kind: 'jump', vxMin: -20, vxMax: -15, vyMin: -25, vyMax: -20 }],
  },
  {
    id: 'WalkRightAlongIEAndJump', weight: 100, move: 'run', minW: 64,
    anchorX: (w) => w.x + w.w - rnd(0, 50),
    steps: [{ kind: 'jump', vxMin: 15, vxMax: 20, vyMin: -25, vyMax: -20 }],
  },
];

/** 一条正在执行的窗顶行为的运行时状态。 */
interface Plan {
  token: number;                 // 每次开新行为递增，用于作废旧的到达回调
  def: CeilBehavior;
  stepIdx: number;               // 当前推进到 steps 的第几条（-1 = 还在移动段）
  waitingWalk: boolean;          // 还在走在路上 → true，到达回调置 false
  expectAction: string | null;   // 本步期望的动作 id（被人抢走动作 → 放弃编排）
  resumeAt: number;              // 本步结束时刻
  deadline: number;              // 整体超时
}

/** WindowInteract 注入的能力：本编排器自己不该直接碰窗口解绑逻辑。 */
export interface CeilingHost {
  resolver: SpriteResolver;
  /** 解除窗顶绑定（地面还原为屏幕底边）——跳下之前必须走这一步。
   *  @param reason 'jump' = 主动从窗边跃下：需要**更长的禁止重绑冷却**，否则她落回窗顶高度的那一帧
   *         会被「下落穿越顶边」的检测重新接住 —— 表现为跳了个寂寞、原地弹回窗顶。
   *         实测（gravity=0.5）：起跳到落回窗顶高度最长 ≈700ms，故 jump 时冷却取 1500ms。 */
  release(pet: Pet, reason: 'lost' | 'jump'): void;
  log(level: string, msg: string): void;
}

export class CeilingBehavior {
  private plans = new Map<Pet, Plan>();
  private nextAt = new Map<Pet, number>();
  private token = 0;

  constructor(private host: CeilingHost) { }

  /** 刚站上窗顶：安排第一次行为。 */
  bind(pet: Pet) {
    this.plans.delete(pet);
    this.nextAt.set(pet, performance.now() + rnd(GAP_MIN_MS, GAP_MAX_MS));
  }

  /** 离开窗顶 / 换动作 / 退场：立刻作废在手编排（她都不在窗顶了，编排没有意义）。 */
  cancel(pet: Pet) {
    this.plans.delete(pet);
    this.nextAt.delete(pet);
  }

  /** 是否正在执行某个窗顶行为（供外部判断「别抢她」）。 */
  busy(pet: Pet): boolean { return this.plans.has(pet); }

  /** 主循环每帧调用（WindowInteract.update 里对每只已绑定窗顶的宠物调用）。
   *  @param w 该宠物当前所站窗口的实时矩形（未被遮挡的那个）。 */
  update(pet: Pet, w: WinInfo, now: number) {
    if (pet.isDraggingAction() || pet.isLeaving()) { this.cancel(pet); return; }
    const plan = this.plans.get(pet);
    if (!plan) {
      if (now < (this.nextAt.get(pet) ?? 0)) return;
      this.start(pet, w, now);
      return;
    }
    // 整体超时（走到目标没回调 / 某一步没被推进）→ 作废，排下一轮
    if (now > plan.deadline) {
      this.host.log('warn', '[wintop] 行为 ' + plan.def.id + ' 超时未完成，作废');
      this.cancel(pet);
      this.nextAt.set(pet, now + BUSY_RETRY_MS);
      return;
    }
    if (plan.waitingWalk) {
      // 走到一半被别的逻辑抢走动作（菜单、其它编排、相遇）→ walkArriveCb 已被 Pet 清空，编排作废
      if (!pet.isWalkingToTarget) {
        this.host.log('info', '[wintop] 行为 ' + plan.def.id + ' 的行走被打断，作废');
        this.plans.delete(pet);
        this.nextAt.set(pet, now + BUSY_RETRY_MS);
      }
      return;
    }
    if (now < plan.resumeAt) return;
    // 本步要求的动作被人换掉了（用户右键/其它调度）→ 收手，让她继续做自己的事
    if (plan.expectAction && pet.currentActionId !== plan.expectAction) {
      this.host.log('info', '[wintop] 行为 ' + plan.def.id + ' 动作被切换为 ' + pet.currentActionId + '，中止');
      this.plans.delete(pet);
      this.nextAt.set(pet, now + BUSY_RETRY_MS);
      return;
    }
    this.advanceStep(pet, plan, now);
  }

  /** 挑一条当前角色跑得起来的行为开跑。 */
  private start(pet: Pet, w: WinInfo, now: number) {
    // 她正在做别的动作（被菜单/相遇/其它编排占用）→ 不抢，等下一轮
    const idleId = pet.config.defaultAction || 'idle';
    if (pet.currentActionId !== idleId) {
      this.nextAt.set(pet, now + BUSY_RETRY_MS);
      return;
    }
    const def = this.pick(pet, w);
    if (!def) { this.nextAt.set(pet, now + BUSY_RETRY_MS); return; }

    const myToken = ++this.token;
    const petW = pet.config.size.width;
    const targetLeft = def.anchorX(w) - petW / 2;
    const plan: Plan = {
      token: myToken, def, stepIdx: -1, waitingWalk: true,
      expectAction: null, resumeAt: now, deadline: now + PLAN_TIMEOUT_MS,
    };
    this.plans.set(pet, plan);
    const gait = def.move ?? 'walk';
    if (gait === 'creep') {
      // 爬行：先按 walk 起跑拿到 targetPos / 到达回调，再把**动画**换成 creep
      // （creep 也是 behavior='walk' 的位移动作，setAction 不会清掉 targetPos 与 walkArriveCb）。
      tryCreepFirst(pet, targetLeft, this.host.resolver, () => this.onArrive(pet, myToken));
    } else {
      pet.walkToX(targetLeft, this.host.resolver, () => this.onArrive(pet, myToken),
        gait === 'run' ? 2 : 1);
    }
    plan.expectAction = pet.currentActionId;
    this.host.log('info', '[wintop] 窗顶行为 ' + def.id + ' → 走到 anchor x=' + Math.round(targetLeft + petW / 2)
      + '（' + gait + '）');
  }

  private onArrive(pet: Pet, token: number) {
    const plan = this.plans.get(pet);
    if (!plan || plan.token !== token) return; // 过期回调（编排已作废/被覆盖）
    plan.waitingWalk = false;
    plan.resumeAt = performance.now();
  }

  /** 推进到位之后的 steps；全部跑完 → 排下一次。 */
  private advanceStep(pet: Pet, plan: Plan, now: number) {
    plan.stepIdx += 1;
    const step = plan.def.steps[plan.stepIdx];
    if (!step) { // 没有后续步骤（Walk/Run/Creep Along）→ 行为本身到此结束
      this.plans.delete(pet);
      this.nextAt.set(pet, now + rnd(GAP_MIN_MS, GAP_MAX_MS));
      return;
    }
    if (step.kind === 'jump') {
      // 旧版 Falling(InitialVX, InitialVY) → Bouncing：先把地面还原为屏幕底边，再给初速度。
      // ⚠️ 顺序不能反：还绑着窗顶时 launch，她会被「窗顶地面」托回去，看着像原地弯了个腿。
      this.plans.delete(pet);
      this.nextAt.delete(pet);
      const vx = rnd(step.vxMin, step.vxMax) / TICK_TO_FRAME;
      const vy = rnd(step.vyMin, step.vyMax) / TICK_TO_FRAME;
      this.host.release(pet, 'jump');
      pet.launch(vx, vy);
      this.host.log('info', '[wintop] ' + plan.def.id + ' 从窗边跃下 vx=' + vx.toFixed(1) + ' vy=' + vy.toFixed(1));
      return;
    }
    // stand / sit：切到对应动作，等一段随机时长
    const id = step.kind === 'sit' ? 'sit' : (pet.config.defaultAction || 'idle');
    if (!pet.config.actions[id]) { // 角色没这套帧 → 该步整体跳过，直接收尾
      this.plans.delete(pet);
      this.nextAt.set(pet, now + rnd(GAP_MIN_MS, GAP_MAX_MS));
      return;
    }
    pet.setAction(id, this.host.resolver);
    plan.expectAction = id;
    plan.resumeAt = now + rnd(step.minMs, step.maxMs);
  }

  /** 按权重随机挑一条**当前角色跑得起来**的行为。
   *  过滤规则都是「没这套帧就别演」，与该动作是否进右键菜单无关：
   *   - need 指定的动作不存在 → 剔除；
   *   - 含 sit 步骤而角色没有 'sit' 帧 → 剔除；
   *   - 窗宽 < def.minW → 剔除（公式会把锚点送出窗口跨度 → 等于让她自己走下去）。 */
  private pick(pet: Pet, w: WinInfo): CeilBehavior | null {
    const cands: { def: CeilBehavior; weight: number }[] = [];
    for (const def of BEHAVIORS) {
      if (def.need && !pet.config.actions[def.need]) continue;
      if (def.steps.some((s) => s.kind === 'sit') && !pet.config.actions['sit']) continue;
      if (w.w < def.minW) continue;
      cands.push({ def, weight: def.weight });
    }
    if (cands.length === 0) return null;
    const total = cands.reduce((s, c) => s + c.weight, 0);
    let r = Math.random() * total;
    for (const c of cands) { r -= c.weight; if (r <= 0) return c.def; }
    return cands[cands.length - 1].def;
  }
}

/** 先起 Walk 拿位移/回调，再把动画换成 creep 动作。
 *  ⚠️ 角色配了双套走帧（walkActionLeft/Right）时不能这么做：stepWalk 每帧会把 actionId 拉回那两个 id，
 *  creep 帧在第一帧就被抢回 walk —— 这类角色直接退回普通 walk gait。 */
function tryCreepFirst(pet: Pet, targetLeft: number, resolver: SpriteResolver, cb: () => void) {
  pet.walkToX(targetLeft, resolver, cb, 1);
  const twoSet = !!(pet.config.walkActionLeft && pet.config.walkActionRight
    && pet.config.actions[pet.config.walkActionLeft] && pet.config.actions[pet.config.walkActionRight]);
  if (!twoSet) pet.setAction('creep', resolver);
}
