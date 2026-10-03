import { CharacterConfig, MeetRule, FrameRef } from './types';

// 渲染进程通过 electron 的 node 集成读取外部 config.json（与打包/开发环境无关）
const req: any = (window as any).require;
const fs = req('fs');
const path = req('path');

function log(level: string, msg: string) {
  console.log('[' + level + '] ' + msg);
}

/**
 * 代码里的「默认角色 + 默认动作」。
 * 每个角色有一个 `actions` 注册表（自由 key），每条是一个动作：
 *   { behavior 运行模式, frames 多帧, frameMs(每帧毫秒), loop, dialogue?, facePartner?, moveSpeed? }
 * 新增动作 = 往这个 map 里加一条；运行时也可通过 config.json 覆盖 / 追加（见 loadUserConfig）。
 */
const DEFAULTS: CharacterConfig[] = [
  {
    id: 'rose',
    name: '露丝',
    size: { width: 150, height: 150 },
    facing: 'left',
    moveSpeed: 1.2,
    detectionRadius: 120,
    bottomMargin: 0,
    interactionDuration: 3500,
    interactGap: 30,
    bubbleOffset: 0.35,
    colors: { body: 0x8ab4ff, eye: 0xffffff },
    defaultAction: 'idle',
    interactAction: 'interact',
    walkAction: 'walk',
    climbAction: 'climb',
    dragAction: 'drag',
    dragLeftAction: 'drag-left',
    dragRightAction: 'drag-right',
    dragIdleAction: 'drag-idle',
    wanderActions: ['walk'],
    actions: {
      idle: { behavior: 'static', frames: ['shime1'], frameMs: 1000, loop: true },
      walk: { behavior: 'walk', frames: ['shime1', 'shime2', 'shime3'], frameMs: 1000, loop: true },
      interact: {
        behavior: 'static',
        frames: ['shime50', 'shime51-1'],
        frameMs: 1000,
        loop: true,
        facePartner: true,
        dialogue: ['妮娜！'],
      },
      drag: { behavior: 'drag', frames: ['shime1'], frameMs: 1000, loop: true },
    },
  },
];

export const GlobalConfig = { characters: DEFAULTS };

/** 全局相遇概率兜底配置（角色 meetRules 没写某对时用）。 */
export interface MeetConfig {
  chance: number; // 每判定周期相遇概率，默认 0.02
  distance: number; // 触发距离门槛(px)，默认 200
  rollInterval: number; // 掷骰周期(ms)，默认 500
}
const DEFAULT_MEET: MeetConfig = { chance: 0.02, distance: 200, rollInterval: 500 };

/** 窗口互动配置（顶层 "window" 字段）：白名单 + 自动「搬走窗口」开关。
 *  白名单语义 = 「窗口标题包含任一字符串」（不区分大小写）——照搬原桌宠 Shimeji 的 InteractiveWindows。 */
export interface WindowConfig {
  whitelist: string[];
  throwEnabled: boolean; // 是否自动掷骰发起「搬走并甩出窗口」演出（默认 false，避免擅自搬动用户的窗口）
  throwRollMs: number;   // 自动掷骰周期(ms)
  throwChance: number;   // 每次掷骰命中概率 0~1
}
const DEFAULT_WINDOW: WindowConfig = {
  // 原桌宠 ニナ/conf/settings.properties 的 InteractiveWindows 原样照搬。
  // ⚠️ 匹配是 contains（包含即命中），所以 "conf" / "Data" 这类短词会误伤（Configure、DataGrip…），
  // 觉得吵直接从 config/config.json 删掉对应条目即可，不影响其余项。
  whitelist: ['微信', '微信2', 'QQ', 'TIM', '记事本', 'Notepad', '设置', 'SAI Ver.2',
    'Chat', 'Friends', 'Windows Live Messenger', 'smj', 'conf', 'Shimeji', 'Data'],
  throwEnabled: false,
  throwRollMs: 60000,
  throwChance: 0.3,
};

/** 更新检查配置（顶层 "update" 字段）：检查地址 / 是否自动检查 / 频道。 */
export interface UpdateConfig {
  checkUrl?: string;   // version.json 地址（main 进程 Node fetch，不受 CORS 限制，可用 raw.githubusercontent / Pages / 任意静态地址）
  autoCheck?: boolean; // 启动是否静默检查（默认 true）
  channel?: string;    // 频道（默认 stable），预留
}

/** 把一条原始动作对象规范化为完整 ActionDef（补默认值）。
 *  frames 保持两种写法：['shime1'] 或 [{name:'shime1', ms:1120}]（逐帧独立时长）。 */
/** 帧列表归一化：兼容 string 与 {name, ms?, vx?, vy?, scale?} 两种写法，字段走白名单过滤。
 *  frames / rightFrames / hoverFrames / hoverRightFrames 四套帧集共用同一套规则。 */
function normFrames(arr: any): FrameRef[] {
  return arr.map((f: any) =>
    typeof f === 'string' ? f : (f && typeof f === 'object' && typeof f.name === 'string'
      ? {
          name: f.name,
          ...(typeof f.ms === 'number' ? { ms: f.ms } : {}),
          ...(typeof f.vx === 'number' ? { vx: f.vx } : {}),
          ...(typeof f.vy === 'number' ? { vy: f.vy } : {}),
          ...(typeof f.scale === 'number' ? { scale: f.scale } : {}),
        } : f),
  );
}

function normalizeAction(a: any): any {
  const frames = Array.isArray(a.frames) ? normFrames(a.frames) : [];
  return {
    behavior: a.behavior || 'static',
    frames,
    rightFrames: Array.isArray(a.rightFrames) ? normFrames(a.rightFrames) : undefined,
    // 飞行「悬停相位」帧集：不配则全程播 frames（旧行为），配了才启用移动/悬停双相位
    hoverFrames: Array.isArray(a.hoverFrames) ? normFrames(a.hoverFrames) : undefined,
    hoverRightFrames: Array.isArray(a.hoverRightFrames) ? normFrames(a.hoverRightFrames) : undefined,
    speed: typeof a.speed === 'number' ? a.speed : 0.1,
    frameMs: typeof a.frameMs === 'number' ? a.frameMs : undefined,
    loop: a.loop === undefined ? true : !!a.loop,
    loopCount: typeof a.loopCount === 'number' && a.loopCount > 0 ? Math.floor(a.loopCount) : undefined,
    dialogue: Array.isArray(a.dialogue) ? a.dialogue : undefined,
    // 台词触发帧：必须是整数（正数 0-based 从头数 / 负数从末帧倒数），非数字一律丢弃
    dialogueFrame: Number.isInteger(a.dialogueFrame) ? a.dialogueFrame : undefined,
    dialogueHoldMs: typeof a.dialogueHoldMs === 'number' && a.dialogueHoldMs > 0 ? a.dialogueHoldMs : undefined,
    facePartner: a.facePartner === true,
    moveSpeed: typeof a.moveSpeed === 'number' ? a.moveSpeed : undefined,
    menu: a.menu === true,
    label: typeof a.label === 'string' ? a.label : undefined,
    menuGroup: typeof a.menuGroup === 'string' && a.menuGroup.trim().length > 0 ? a.menuGroup : undefined,
    menuOrder: typeof a.menuOrder === 'number' ? a.menuOrder : undefined,
    // menuRandom 缺省 true：写了 menuGroup 的动作默认都参与「点一级随机抽」的池子
    menuRandom: a.menuRandom === false ? false : true,
    menuHidden: a.menuHidden === true,
    coop: a.coop === true,
    pairTrigger: a.pairTrigger === true,
    pairWith: typeof a.pairWith === 'string' && a.pairWith.trim().length > 0 ? a.pairWith : undefined,
    pairId: typeof a.pairId === 'string' && a.pairId.trim().length > 0 ? a.pairId : undefined,
    flip: a.flip === true,
    width: typeof a.width === 'number' ? a.width : undefined,
    height: typeof a.height === 'number' ? a.height : undefined,
    impulse: (a.impulse && typeof a.impulse.vx === 'number' && typeof a.impulse.vy === 'number')
      ? { vx: a.impulse.vx, vy: a.impulse.vy } : undefined,
    next: Array.isArray(a.next) ? a.next.map((n: any) =>
      typeof n === 'string' ? n : (n && typeof n === 'object' && typeof n.id === 'string'
        ? { id: n.id, weight: typeof n.weight === 'number' ? n.weight : 1 } : n)) : undefined,
    durationMs: typeof a.durationMs === 'number' ? a.durationMs : undefined,
    trackMouse: a.trackMouse === true,
    chaseRange: typeof a.chaseRange === 'number' ? a.chaseRange : undefined,
    chaseTimeoutMs: typeof a.chaseTimeoutMs === 'number' ? a.chaseTimeoutMs : undefined,
    offset: (a.offset && (typeof a.offset.x === 'number' || typeof a.offset.y === 'number'))
      ? { ...(typeof a.offset.x === 'number' ? { x: a.offset.x } : {}), ...(typeof a.offset.y === 'number' ? { y: a.offset.y } : {}) }
      : undefined,
    // throw = 「搬走并甩出窗口」演出（WindowInteract.startThrowShow 驱动整段编排）
    windowMode: a.windowMode === 'carry' || a.windowMode === 'ledge' || a.windowMode === 'throw'
      ? a.windowMode : undefined,
    flyMode: a.flyMode === 'ceiling' ? 'ceiling' : undefined,
    // 飞行双相位时长：移动段与悬停段各自 [min,max] 随机，缺省用 Pet 内的默认值
    flyMoveMinMs: typeof a.flyMoveMinMs === 'number' ? a.flyMoveMinMs : undefined,
    flyMoveMaxMs: typeof a.flyMoveMaxMs === 'number' ? a.flyMoveMaxMs : undefined,
    flyHoverMinMs: typeof a.flyHoverMinMs === 'number' ? a.flyHoverMinMs : undefined,
    flyHoverMaxMs: typeof a.flyHoverMaxMs === 'number' ? a.flyHoverMaxMs : undefined,
  };
}

/** 规范化相遇概率规则：用户写的 meetRules 直接采用（按对方 id 取 chance/distance），没写则用全局兜底。
 *  配对规则统一归一化进 `pairs` 数组：
 *   - 写了 `pairs` 数组 → 逐条取 self/other/id/weight；
 *   - 只写了旧式单个 `pair` 对象 → 等价转成长度为 1 的数组（向后兼容）；
 *   - 都没有 → 该对无配对规则。运行时只读 `pairs`，不再区分 pair/pairs。 */
function normalizeMeetRules(mr: any): Record<string, MeetRule> {
  const out: Record<string, MeetRule> = {};
  if (mr && typeof mr === 'object') {
    for (const k of Object.keys(mr)) {
      const r = mr[k];
      if (!r || typeof r !== 'object') continue;
      let pairs: { self?: string; other?: string; id?: string; weight?: number }[] | undefined;
      if (Array.isArray(r.pairs)) {
        pairs = r.pairs
          .filter((p: any) => p && typeof p === 'object')
          .map((p: any) => ({
            self: typeof p.self === 'string' ? p.self : undefined,
            other: typeof p.other === 'string' ? p.other : undefined,
            id: typeof p.id === 'string' && p.id.trim().length > 0 ? p.id : undefined,
            weight: typeof p.weight === 'number' && p.weight > 0 ? p.weight : undefined,
          }));
      } else if (r.pair && typeof r.pair === 'object') {
        pairs = [{
          self: typeof r.pair.self === 'string' ? r.pair.self : undefined,
          other: typeof r.pair.other === 'string' ? r.pair.other : undefined,
        }];
      }
      // 数组里至少有一条带 self/other 才算有效配对
      const valid = pairs && pairs.filter((p) => p.self || p.other).length > 0 ? pairs : undefined;
      out[k] = {
        chance: typeof r.chance === 'number' ? r.chance : undefined,
        distance: typeof r.distance === 'number' ? r.distance : undefined,
        ...(valid ? { pairs: valid } : {}),
      };
    }
  }
  return out;
}

/** 规范化气泡配置：只保留已知数字/字符串字段，避免无关字段污染。 */
function normalizeBubble(b: any): import('./types').BubbleDef | undefined {
  if (!b || typeof b !== 'object') return undefined;
  return {
    frameName: typeof b.frameName === 'string' ? b.frameName : undefined,
    leftWidth: typeof b.leftWidth === 'number' ? b.leftWidth : undefined,
    rightWidth: typeof b.rightWidth === 'number' ? b.rightWidth : undefined,
    topHeight: typeof b.topHeight === 'number' ? b.topHeight : undefined,
    bottomHeight: typeof b.bottomHeight === 'number' ? b.bottomHeight : undefined,
    scale: typeof b.scale === 'number' ? b.scale : undefined,
    fontSize: typeof b.fontSize === 'number' ? b.fontSize : undefined,
    textColor: typeof b.textColor === 'number' ? b.textColor : undefined,
    paddingX: typeof b.paddingX === 'number' ? b.paddingX : undefined,
    paddingY: typeof b.paddingY === 'number' ? b.paddingY : undefined,
    maxTextWidth: typeof b.maxTextWidth === 'number' ? b.maxTextWidth : undefined,
    minWidth: typeof b.minWidth === 'number' ? b.minWidth : undefined,
    minHeight: typeof b.minHeight === 'number' ? b.minHeight : undefined,
    textOffsetX: typeof b.textOffsetX === 'number' ? b.textOffsetX : undefined,
    textOffsetY: typeof b.textOffsetY === 'number' ? b.textOffsetY : undefined,
  };
}

/** 规范化动作组配置：只保留已知字段，缺省整块忽略。 */
function normalizeActionGroups(g: any): Record<string, import('./types').ActionGroupDef> | undefined {
  if (!g || typeof g !== 'object') return undefined;
  const out: Record<string, import('./types').ActionGroupDef> = {};
  for (const k of Object.keys(g)) {
    const v = g[k];
    if (!v || typeof v !== 'object') continue;
    out[k] = {
      label: typeof v.label === 'string' ? v.label : undefined,
      order: typeof v.order === 'number' ? v.order : undefined,
      menuRandom: typeof v.menuRandom === 'string' ? v.menuRandom : undefined,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 把原始角色配置规范化为完整 CharacterConfig（补所有默认值，确保运行不缺字段） */
function normalizeCharacter(c: any): CharacterConfig {
  const base: any = { ...c };

  // 兼容旧 animations 字段（若用户仍写 animations，转成 actions）
  if (c.animations && !c.actions) {
    base.actions = {};
    for (const k of Object.keys(c.animations)) {
      const an = c.animations[k];
      const kl = k.toLowerCase();
      base.actions[kl] = {
        behavior: kl === 'walking' ? 'walk' : kl === 'interacting' ? 'static' : kl === 'dragging' ? 'drag' : 'static',
        frames: Array.isArray(an.frames) ? an.frames : [],
        speed: an.speed,
        loop: an.loop,
      };
    }
  }

  const actions: Record<string, any> = {};
  if (base.actions) {
    for (const k of Object.keys(base.actions)) actions[k] = normalizeAction(base.actions[k]);
  }

  return {
    id: c.id,
    name: c.name || c.id,
    size: c.size || { width: 150, height: 150 },
    facing: c.facing || 'left',
    moveSpeed: typeof c.moveSpeed === 'number' ? c.moveSpeed : 1.2,
    detectionRadius: typeof c.detectionRadius === 'number' ? c.detectionRadius : 120,
    bottomMargin: c.bottomMargin || 0,
    interactionDuration: typeof c.interactionDuration === 'number' ? c.interactionDuration : 3000,
    interactGap: typeof c.interactGap === 'number' ? c.interactGap : 30,
    coopEndGap: typeof c.coopEndGap === 'number' ? c.coopEndGap : undefined,
    coopBodyInsetX: typeof c.coopBodyInsetX === 'number' ? c.coopBodyInsetX : undefined,
    coopEndShift: (c.coopEndShift && typeof c.coopEndShift === 'object')
      ? { x: typeof c.coopEndShift.x === 'number' ? c.coopEndShift.x : 0, y: typeof c.coopEndShift.y === 'number' ? c.coopEndShift.y : 0 }
      : undefined,
    bubbleOffset: typeof c.bubbleOffset === 'number' ? c.bubbleOffset : 0.35,
    defaultAction: c.defaultAction || 'idle',
    // 互用 fallAction/landAction 的写法：未配则 undefined（运行时由 || 'interact' 兜底，找不到再回 defaultAction）。
    // 让角色可声明"不参与互动"——后续补互动帧时再加回字段。
    interactAction: typeof c.interactAction === 'string' ? c.interactAction : undefined,
    walkAction: c.walkAction || 'walk',
    approachAction: c.approachAction || c.walkAction || 'walk',
    spawnDrop: c.spawnDrop === true,
    spawnAction: typeof c.spawnAction === 'string' ? c.spawnAction : undefined,
    fallAction: typeof c.fallAction === 'string' && c.fallAction.trim().length > 0 ? c.fallAction : undefined,
    landAction: typeof c.landAction === 'string' && c.landAction.trim().length > 0 ? c.landAction : undefined,
    walkActionLeft: typeof c.walkActionLeft === 'string' ? c.walkActionLeft : undefined,
    walkActionRight: typeof c.walkActionRight === 'string' ? c.walkActionRight : undefined,
    climbAction: c.climbAction || 'climb',
    dragAction: c.dragAction || 'drag',
    dragLeftAction: c.dragLeftAction,
    dragRightAction: c.dragRightAction,
    dragIdleAction: c.dragIdleAction,
    wanderActions: Array.isArray(c.wanderActions) ? c.wanderActions : ['walk'],
    ceilingAction: typeof c.ceilingAction === 'string' ? c.ceilingAction : undefined,
    ceilingChance: typeof c.ceilingChance === 'number' ? c.ceilingChance : undefined,
    ceilingDropChance: typeof c.ceilingDropChance === 'number' ? c.ceilingDropChance : undefined,
    ceilingEdgeChance: typeof c.ceilingEdgeChance === 'number' ? c.ceilingEdgeChance : undefined,
    chaseAction: typeof c.chaseAction === 'string' ? c.chaseAction : undefined,
    gravity: typeof c.gravity === 'number' ? c.gravity : 0.8,
    throwFactor: typeof c.throwFactor === 'number' ? c.throwFactor : 0.9,
    maxThrow: typeof c.maxThrow === 'number' ? c.maxThrow : 28,
    maxThrowV: typeof c.maxThrowV === 'number' ? c.maxThrowV : 24,
    tripThreshold: typeof c.tripThreshold === 'number' ? c.tripThreshold : 12,
    bounceThreshold: typeof c.bounceThreshold === 'number' ? c.bounceThreshold : 4,
    tripDurationMs: typeof c.tripDurationMs === 'number' ? c.tripDurationMs : 1200,
    wanderMinDelayMs: typeof c.wanderMinDelayMs === 'number' ? c.wanderMinDelayMs : 1500,
    wanderTauMs: typeof c.wanderTauMs === 'number' ? c.wanderTauMs : 1667,
    wanderRangePx: typeof c.wanderRangePx === 'number' ? c.wanderRangePx : 320,
    wanderRecentSize: typeof c.wanderRecentSize === 'number' ? c.wanderRecentSize : 3,
    wanderRecentExclude: typeof c.wanderRecentExclude === 'number' ? c.wanderRecentExclude : 1,
    wanderRecentPenalty: typeof c.wanderRecentPenalty === 'number' ? c.wanderRecentPenalty : 0.2,
    wanderRecentExempt: Array.isArray(c.wanderRecentExempt)
      ? (c.wanderRecentExempt.filter((x: unknown) => typeof x === 'string') as string[])
      : undefined,
    climbMaxMs: typeof c.climbMaxMs === 'number' ? c.climbMaxMs : 20000,
    climbTurnChance: typeof c.climbTurnChance === 'number' ? c.climbTurnChance : 0.35,
    climbEndFlyChance: typeof c.climbEndFlyChance === 'number' ? c.climbEndFlyChance : 0.5,
    climbDownAction: typeof c.climbDownAction === 'string' ? c.climbDownAction : undefined,
    flyAction: typeof c.flyAction === 'string' ? c.flyAction : 'fly',
    ceilingMaxMs: typeof c.ceilingMaxMs === 'number' ? c.ceilingMaxMs : 20000,
    ceilingTilt: typeof c.ceilingTilt === 'number' ? c.ceilingTilt : 0.22,
    climbCooldownMs: typeof c.climbCooldownMs === 'number' ? c.climbCooldownMs : 3000,
    edgeMargin: typeof c.edgeMargin === 'number' ? c.edgeMargin : 0,
    grabDialogue: typeof c.grabDialogue === 'string' && c.grabDialogue.trim().length > 0
      ? c.grabDialogue
      : (actions['knockback'] && Array.isArray(actions['knockback'].dialogue) && actions['knockback'].dialogue[0]) || '放开我！',
    colors: c.colors || { body: 0xff8a8a, eye: 0xffffff },
    actions,
    actionGroups: normalizeActionGroups(c.actionGroups),
    tapDialogue: Array.isArray(c.tapDialogue) ? c.tapDialogue : undefined,
    meetRules: normalizeMeetRules(c.meetRules),
    removeAction: typeof c.removeAction === 'string' ? c.removeAction : undefined,
    removeActionMs: typeof c.removeActionMs === 'number' ? c.removeActionMs : undefined,
    removeFadeMs: typeof c.removeFadeMs === 'number' ? c.removeFadeMs : undefined,
    exitAction: typeof c.exitAction === 'string' ? c.exitAction : undefined,
    bubble: normalizeBubble(c.bubble),
  };
}

/**
 * 从外部 config.json 深度合并用户覆盖值到默认配置。
 * - config.json 不存在 / 损坏 / 字段缺失 → 全部回退默认值（永不崩溃）。
 * - 按角色 id 匹配；actions 按动作 key 递归合并（既能覆盖现有动作，也能**纯靠 JSON 新增动作**）。
 * - 合并后再 normalize，确保新增动作也补齐 speed/loop 等默认值。
 */
export function loadUserConfig(configDir: string): CharacterConfig[] {
  let parsed: any = null;
  try {
    const p = path.join(configDir, 'config.json');
    if (fs.existsSync(p)) {
      parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      log('info', '[config] loaded user config from ' + p);
    } else {
      log('info', '[config] no config.json at ' + p + ' -> using defaults');
    }
  } catch (e) {
    log('warn', '[config] failed to parse config.json, using defaults: ' + ((e as Error)?.stack || String(e)));
  }

  if (!parsed || !Array.isArray(parsed.characters)) {
    return GlobalConfig.characters.map(normalizeCharacter);
  }

  // 新格式：characters 是角色 id 字符串清单 -> 从子目录（characters/actions/moods）组装
  if (typeof parsed.characters[0] === 'string') {
    return (parsed.characters as string[]).map((id) => assembleCharacter(configDir, id));
  }

  // 旧格式：characters 是对象数组 -> 与内置 DEFAULTS 深合并（向后兼容）
  const result: CharacterConfig[] = [];
  const matched = new Set<string>();
  for (const def of GlobalConfig.characters) {
    const u = (parsed.characters as any[]).find((c) => c && c.id === def.id);
    matched.add(def.id);
    result.push(normalizeCharacter(u ? deepMerge(def, u) : def));
  }
  for (const c of parsed.characters as any[]) {
    if (c && c.id && !matched.has(c.id)) {
      result.push(normalizeCharacter(c));
    }
  }
  return result;
}

/**
 * 从子目录组装单个角色：
 *   characters/<id>.json  (基础属性：size/facing/meetRules/drag 等)
 * + actions/<id>.json     (actions: {...})
 * 合并后统一 normalizeCharacter（补齐缺失的默认字段）。任一子文件缺失也不崩溃。
 */
function assembleCharacter(configDir: string, id: string): CharacterConfig {
  const readJson = (rel: string): any => {
    try {
      const p = path.join(configDir, rel);
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
    } catch {
      return null;
    }
  };
  const base = readJson(path.join('characters', id + '.json')) || {};
  const actionsFile = readJson(path.join('actions', id + '.json'));
  if (actionsFile && actionsFile.actions) base.actions = actionsFile.actions;
  base.id = id; // 子文件可省略 id，这里兜底确保存在
  return normalizeCharacter(base);
}

function deepMerge<T>(base: T, over: any): T {
  if (!over || typeof over !== 'object') return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const k of Object.keys(over)) {
    const bv = (base as any)[k];
    const ov = over[k];
    if (ov && typeof ov === 'object' && !Array.isArray(ov) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = deepMerge(bv, ov);
    } else if (ov !== undefined) {
      out[k] = ov;
    }
  }
  return out;
}

/**
 * 读取全局相遇概率配置（顶层 "meet" 字段）：chance / distance / rollInterval。
 * 没写则用 DEFAULT_MEET 兜底。
 */
export function loadMeetConfig(configDir: string): MeetConfig {
  let parsed: any = null;
  try {
    const p = path.join(configDir, 'config.json');
    if (fs.existsSync(p)) parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { /* ignore */ }
  const m = parsed && parsed.meet ? parsed.meet : {};
  return {
    chance: typeof m.chance === 'number' ? m.chance : DEFAULT_MEET.chance,
    distance: typeof m.distance === 'number' ? m.distance : DEFAULT_MEET.distance,
    rollInterval: typeof m.rollInterval === 'number' ? m.rollInterval : DEFAULT_MEET.rollInterval,
  };
}

/**
 * 读取顶层 "update" 字段作为更新检查配置。
 * 缺失 / 损坏 / 无 update 块 → 返回 { autoCheck:true, channel:'stable' }（不抛错，是否真检查由 checkUrl 是否存在决定）。
 */
export function loadUpdateConfig(configDir: string): UpdateConfig {
  try {
    const p = path.join(configDir, 'config.json');
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const u = parsed && parsed.update;
      if (u && typeof u === 'object') {
        return {
          checkUrl: typeof u.checkUrl === 'string' && u.checkUrl.length > 0 ? u.checkUrl : undefined,
          autoCheck: u.autoCheck === false ? false : true,
          channel: typeof u.channel === 'string' ? u.channel : 'stable',
        };
      }
    }
  } catch { /* ignore */ }
  return { autoCheck: true, channel: 'stable' };
}

/**
 * 把「可互动窗口」名单 / 自动投掷开关写回 config/config.json（顶层 "window" 段）。
 *
 * 供「自定义可互动窗口…」面板使用（对齐原版 Shimeji 设置窗口把 InteractiveWindows /
 * Throwing 写回 settings.properties 的行为）。只改 window 段，其余键原样保留。
 * 写失败（只读目录等）返回 false，调用方负责提示；不抛错。
 */
export function saveWindowConfig(
  configDir: string,
  cfg: { whitelist: string[]; throwEnabled: boolean; throwRollMs?: number; throwChance?: number },
): boolean {
  try {
    const p = path.join(configDir, 'config.json');
    let parsed: any = {};
    if (fs.existsSync(p)) {
      try { parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) || {}; } catch { parsed = {}; }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) parsed = {};
    const prev = typeof parsed.window === 'object' && parsed.window !== null ? parsed.window : {};
    // 频率字段：未显式传入时保留原值（老调用方只传 whitelist/throwEnabled 也不会把它抹掉）。
    // 与 loadWindowConfig 的兜底保持一致：throwRollMs 必须 >0，throwChance clamp 到 0~1。
    const next: any = {
      whitelist: cfg.whitelist.slice(),
      throwEnabled: cfg.throwEnabled === true,
    };
    const rollMs = typeof cfg.throwRollMs === 'number' && cfg.throwRollMs > 0
      ? Math.round(cfg.throwRollMs)
      : (typeof prev.throwRollMs === 'number' && prev.throwRollMs > 0 ? prev.throwRollMs : undefined);
    if (rollMs !== undefined) next.throwRollMs = rollMs;
    const chance = typeof cfg.throwChance === 'number'
      ? Math.max(0, Math.min(1, cfg.throwChance))
      : (typeof prev.throwChance === 'number' ? Math.max(0, Math.min(1, prev.throwChance)) : undefined);
    if (chance !== undefined) next.throwChance = chance;
    parsed.window = Object.assign({}, prev, next);
    fs.writeFileSync(p, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    return true;
  } catch { return false; }
}

/**
 * 读取顶层 "window" 字段：可互动窗口白名单 + 自动投掷开关。
 * 缺失 / 损坏 → 全用 DEFAULT_WINDOW（白名单=原桌宠那份，自动投掷关闭），不抛错。
 */
export function loadWindowConfig(configDir: string): WindowConfig {
  let parsed: any = null;
  try {
    const p = path.join(configDir, 'config.json');
    if (fs.existsSync(p)) parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { /* ignore */ }
  const w = parsed && parsed.window ? parsed.window : {};
  const wl = Array.isArray(w.whitelist)
    ? w.whitelist.filter((s: any) => typeof s === 'string' && s.trim().length > 0)
      .map((s: string) => s.trim())
    : DEFAULT_WINDOW.whitelist;
  return {
    // 显式给了空数组 = 不限制（等于关掉白名单）；只有字段缺失才回退默认白名单
    whitelist: wl,
    throwEnabled: w.throwEnabled === true,
    throwRollMs: typeof w.throwRollMs === 'number' && w.throwRollMs > 0 ? w.throwRollMs : DEFAULT_WINDOW.throwRollMs,
    throwChance: typeof w.throwChance === 'number'
      ? Math.max(0, Math.min(1, w.throwChance)) : DEFAULT_WINDOW.throwChance,
  };
}
