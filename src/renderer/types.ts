// 动作运行模式（有限的代码行为集）。
// 新增「动作」（如行走/攀爬/坐下）只需在配置里加一条数据；
// 只有新增「运行模式」才需要改代码（加到下面这个联合类型 + Pet 的步进函数）。
export type ActionBehavior =
  | 'static'   // 原地
  | 'walk'     // 沿地面左右位移
  | 'climb'    // 沿屏幕左右边框上下位移
  | 'drag'     // 鼠标拖拽
  | 'ceiling'  // 贴天花板横向爬（倒挂）
  | 'chase'    // 追鼠标指针（水平方向跑向指针 x）
  | 'fly';     // 自由飞行（2D 任意方向位移，不受重力/地面约束）

/** 帧引用：字符串（沿用动作级 speed 统一帧率）或对象（逐帧独立时长 ms / 逐帧位移速度 vx,vy / 显示缩放 scale）。
 *  vx/vy 参考 Shimeji 每帧 Pose 的 Velocity：walk 等位移动作里，当前帧的 vx 即该帧前进速度(px/帧@60fps)，
 *  未写 → 回退动作级 moveSpeed；vx=0 即支撑帧（该帧不位移），自然呈现「只在特定帧位移」的踩步感。
 *  scale 用于覆盖本帧的自动 contain-fit 缩放（如画布变宽导致角色被压小），未写则按容器约束自动计算。 */
export type FrameRef = string | { name: string; ms?: number; vx?: number; vy?: number; scale?: number };

/** 动作结束后的接续目标：动作 id 或带权重的 {id, weight}（多个目标按权重随机取一）。 */
export type NextActionRef = string | { id: string; weight?: number };

/**
 * 「动作组」：把同一动作的多种**样式/变体**归到一个一级条目下，右键菜单呈现为二级结构。
 *   <一级：钓鱼>  ← 点击 = 从组内随机抽一个变体执行（可用 group.menuRandom 指定优先抽哪个子动作）
 *     ├ 钓鱼·金鱼
 *     ├ 钓鱼·海豚
 *     └ 钓鱼·水母
 * 零代码：只要动作上写了 `menuGroup: '钓鱼'`，菜单自动生成这一级。
 */
export interface ActionGroupDef {
  label?: string;      // 一级条目显示名（缺省用组的 key / id）
  order?: number;      // 一级条目在菜单里的排序（越小越靠前，缺省取组内最小 menuOrder）
  menuRandom?: string; // 点一级时优先随机走的子动作 id 池键：
                       //   - 动作 id（如 'fish'）：只在该 id 的所有变体里抽
                       //   - 组 key 本身（如 '钓鱼'）：在整个组的所有变体里抽
                       // 缺省 = 组内全部变体等权随机。
}

export interface ActionDef {
  behavior: ActionBehavior;
  frames: FrameRef[]; // 帧名列表（string 或 {name, ms}），对应 manifest.frames[角色id][帧名]
  /** 右朝向帧集：提供后与 frames(左朝向) 形成双套，引擎按 facingRight 自动选左/右图集并**强制不翻转**
   *  （方向已画在图里）。不提供则退回单图 + 水平翻转（默认行为，兼容旧角色）。 */
  rightFrames?: FrameRef[];
  speed?: number; // 帧率系数，实际 fps = speed * 60，默认 0.1（逐帧 ms / frameMs 存在时忽略）
  frameMs?: number; // 动作级统一每帧时长(ms)；数字越大每帧越久，推荐 200~2000；优先级高于 speed
  loop?: boolean; // 是否循环，默认 true
  loopCount?: number; // 仅在 loop:true 时生效：循环轮数上限（如 3 = 播 3 轮后停在末帧走 next/回 idle）；不配 = 无限循环
  dialogue?: string[]; // 触发该动作时显示的对白（数组，随机取一句）
  /** 台词在第几帧触发（不配 = 动作一开始就显示，旧行为）：
   *   正数 = 从头数（0-based，7 = 第 8 帧）；负数 = 从尾数（-1 末帧，-3 倒数第三帧）。
   *  负数更抗改：以后给动作加/减帧，不用回头改这个数字。 */
  dialogueFrame?: number;
  /** 台词气泡的显示时长(ms)覆盖值。不配时按「触发帧 → 动作结束」的剩余时长自动算
   *  （配了 dialogueFrame 才算得准；没配就是整个动作时长）。 */
  dialogueHoldMs?: number;
  facePartner?: boolean; // 触发时是否面向对方（用于相遇等）
  moveSpeed?: number; // 位移速度(px/帧)，覆盖角色级 moveSpeed
  menu?: boolean; // 是否出现在右键动作菜单里（默认 false，需显式 true）
  label?: string; // 右键菜单显示的中文名（可配置；缺省回退到动作 id）
  // —— 右键菜单二级分组：同一动作的多种样式归到一个一级条目下 ——
  menuGroup?: string; // 所属一级条目名（如 '钓鱼'）；写了就归到这个组里，不再作为一级条目单独出现
  menuOrder?: number; // 一级/二级条目排序（越小越靠前，缺省 999）
  menuRandom?: boolean; // 该动作可作为「点一级 → 随机抽一个」的候选（缺省 true）；
                        // 需要「变体只出现在二级、一级随机只抽代表动作」时，把不参与随机的那几个设为 false
  menuHidden?: boolean; // 只参与随机、完全不出现在二级列表（如纯中间过渡帧组）
  // —— 合体合作动作（如拥抱）：一张帧里已包含两人，由屏幕左侧一方承载播放，另一方 visible=false 让位 ——
  coop?: boolean; // 标记：这是「合体」动作（一方承载合体帧，另一方隐身）
  flip?: boolean; // 强制水平翻转美术资源（应对左右占位：当主演在右、帧画的是左抱右时翻转）
  // —— 手动配对触发器（菜单专用）：menu:true 的动作标记 pairTrigger 后，点它 = 触发一次配对相遇 ——
  // 与 MeetRule.pair 不同：这里是菜单入口标记，真正播什么由双方 meetRules 里的 pair 决定。
  pairTrigger?: boolean; // 标记：菜单里点这项 = 找 pairWith 指定/最近的搭档并走近演出配对动作
  pairWith?: string; // 指定搭档角色 id；省略则自动选最近的、与它有 pair 规则的搭档
  pairId?: string; // 与 pairTrigger 配套：指定触发 meetRules 里哪一条 pairs（按 id 选）；省略则自动掷骰按权重随机抽
  width?: number; // 动作级显示宽度(px)，覆盖角色级 size.width（合体帧等需要更宽时用）
  height?: number; // 动作级显示高度(px)，覆盖角色级 size.height
  // —— 受击/被推飞：右键触发该动作时给一个抛物线初速度（px/帧），由 Pet.applyImpulse 接管物理 ——
  impulse?: { vx: number; vy: number }; // vx 水平、vy 竖直（负=向上）；落回地面时可能触发摔倒
  // —— M2 动作序列：非 loop 动作播完 / durationMs 到期后接续的动作（权重随机）——
  next?: NextActionRef[]; // 例：['stand', {id:'walk', weight:3}]
  durationMs?: number; // 动作时长(ms)；到期后走 next 链（无 next 则回默认动作）。不写 = 一直停留
  // —— M4 鼠标交互 ——
  trackMouse?: boolean; // static 动作期间按鼠标相对位置自动翻转朝向（Shimeji 的 Look 系）
  chaseRange?: number; // chase：触发/保持追击的水平半径(px)，默认 260
  chaseTimeoutMs?: number; // chase：最长追击时长(ms)，默认 4000
  // —— M3 帧级锚点补偿 ——
  offset?: { x?: number; y?: number }; // 该动作 body 相对容器中心的显示偏移(px)（倒挂帧 anchor 差异等）
  // —— M5 窗口交互：该动作触发时抓取最近的第三方窗口 ——
  windowMode?: 'carry' | 'ledge' | 'throw'; // carry=搬着窗口走（拖拽可拖动/抛出窗口）；ledge=挂窗沿（站在窗口顶边）；throw=搬走并甩出窗口（走过去→抓住→扛到屏幕另一侧→甩出，整段由 WindowInteract.startThrowShow 编排，目标限定 config 的 window.whitelist）
  // —— 飞行模式开关（behavior='fly' 时生效）——
  flyMode?: 'free' | 'ceiling'; // free=屏幕内任意方向乱飞（默认，保留旧版）；ceiling=触发后先垂直飞到屏幕顶，再贴顶左右往返
  // —— 飞行「移动 / 悬停」双相位（behavior='fly' 时生效）——
  // 对齐旧桌宠（Shimeji）的手感：飞一段 → 原地悬停扑翼片刻 → 再飞一段，中间偶尔有停顿。
  // 移动相位播 frames/rightFrames；悬停相位播 hoverFrames/hoverRightFrames。
  // 没配 hoverFrames → 退化为「全程播 frames」的旧行为，对现有角色零影响。
  hoverFrames?: FrameRef[];      // 悬停（静止飞行）相位的左朝向帧集
  hoverRightFrames?: FrameRef[]; // 悬停相位的右朝向帧集；缺省则退回单套 + 水平翻转
  flyMoveMinMs?: number;  // 移动相位时长随机下界(ms)，默认 1500
  flyMoveMaxMs?: number;  // 移动相位时长随机上界(ms)，默认 3500
  flyHoverMinMs?: number; // 悬停相位时长随机下界(ms)，默认 500
  flyHoverMaxMs?: number; // 悬停相位时长随机上界(ms)，默认 1600
}

/** 一条配对动作（另一种「合体」）：两人在 distance 内按 chance 命中后，**各自播不同动作**（都可见、独立）。
 *  self = 规则拥有者（写了这条 meetRules 的角色）的动作；other = 对方角色的动作。
 *  id = 可选标识，供右键菜单的 pairTrigger 动作**精确选择**某条配对（如 'sing' / 'eat'）；
 *       不写则自动掷骰时按 weight 随机抽。
 *  weight = 自动掷骰时的选择权重（默认 1）。 */
export interface PairDef {
  self?: string;
  other?: string;
  id?: string;
  weight?: number;
}

/** 单对角色的相遇概率规则 */
export interface MeetRule {
  chance?: number; // 每个判定周期(rollInterval)触发相遇的概率，0~1
  distance?: number; // 触发距离门槛(px)，两人中心小于此值才掷骰
  action?: string; // 命中后触发的动作 id（默认 interactAction）；合体动作如 'hug' 在此指定
  // 配对动作（另一种「合体」）：两人在 distance 内按 chance 命中后，**各自播不同动作**（都可见、独立）。
  // 与 action 互斥：写了 pairs/pair 走「配对」分支，否则走原来的单一相遇/合体逻辑。
  // 一条规则可挂**多条**配对（pairs 数组），实现「同一对角色有多种可选合体」：
  //   - 自动掷骰（概率相遇）按各条 weight 随机抽一条；
  //   - 右键菜单每条配对是一个独立可选项（pairTrigger 动作用 pairId 指定抽哪条）。
  // self = 规则拥有者（写了这条 meetRules 的角色）的动作；other = 对方角色的动作。
  // 例：mona.meetRules.rose = { pairs:[ {id:'sing', self:'sing', other:'sing'}, {id:'eat', self:'cookMilk', other:'eat'} ] }
  //   → 莫娜/露丝既会一起唱歌，也会莫娜做奶冻、露丝吃。
  // 注意：配了 pairs/pair 的角色即使没有 interactAction 也能参与触发（放宽了原 interactAction 门槛）。
  // 兼容旧写法：单个 pair 对象等价于 pairs 长度为 1 的数组（normalizeMeetRules 会归一化）。
  pair?: { self?: string; other?: string };
  pairs?: PairDef[];
}

/** 角色专属对话气泡配置（缺失时用代码默认白底圆角气泡兜底）。 */
export interface BubbleDef {
  frameName?: string; // 在 images/<角色>.json 里登记的帧名，默认 'bubble'
  leftWidth?: number; // 九宫格左固定带宽度（纹理像素），默认 32
  rightWidth?: number; // 九宫格右固定带宽度（纹理像素），默认 32
  topHeight?: number; // 九宫格上固定带高度（纹理像素），默认 32
  bottomHeight?: number; // 九宫格下固定带高度（纹理像素），默认 32
  scale?: number; // 纹理相对显示尺寸的缩放系数，默认 0.5（适配 2x 美术稿）
  fontSize?: number; // 气泡文字大小，默认 14
  textColor?: number; // 文字颜色，默认 0x222222
  textOffsetX?: number; // 文字水平微调偏移（显示像素），默认 0
  textOffsetY?: number; // 文字垂直微调偏移（显示像素），默认 0
  paddingX?: number; // 文字区左右内边距（显示像素），默认 24
  paddingY?: number; // 文字区上下内边距（显示像素），默认 14
  maxTextWidth?: number; // 文字自动换行宽度上限（显示像素），默认 180
  minWidth?: number; // 气泡最小宽度（显示像素），默认按固定带计算
  minHeight?: number; // 气泡最小高度（显示像素），默认按固定带计算
}

export interface CharacterConfig {
  id: string;
  name: string;
  size: { width: number; height: number };
  facing?: 'left' | 'right'; // 美术素材基础朝向，默认 'left'（向右走时自动翻转）
  moveSpeed?: number; // 位移默认速度(px/帧)，walk/climb 未指定 moveSpeed 时使用
  bottomMargin?: number; // 距屏幕下沿的上抬像素，0 = 贴边
  bubbleOffset?: number; // 对话气泡相对角色高度的系数（负向=头顶上方），默认 0.35
  bubbleOffsetX?: number; // 对话气泡水平偏移，相对角色宽度的系数（正=向右，负=向左），默认 0
  detectionRadius?: number; // 互动判定半径
  interactionDuration?: number; // 互动持续时间 (ms)
  interactGap?: number; // 相遇吸附后两人中心之间保留的间距(px)，默认 30
  coopEndGap?: number; // 合体动作结束后两人「身体边缘」之间的间距(px)，默认 14；比 interactGap 更紧，贴合"合体"后紧贴
  coopBodyInsetX?: number; // 合体收尾定位用：身体左缘离画布左边缘的偏移(px，角色框空间)。用于按"身体边缘"而非"画布边缘"算间距，消除图片左右占位不一致导致的错位。默认 0（=身体填满画布）
  coopEndShift?: { x?: number; y?: number }; // 合体动作结束后两人各自独立的终位微调(px)，默认 0；负值 x=往左、负值 y=往上；rose/nina 可设不同值实现"分别移动"
  defaultAction?: string; // 默认待机动作 id，默认 'idle'
  interactAction?: string; // 相遇触发动作 id，默认 'interact'
  walkAction?: string; // 左右漫游动作 id，默认 'walk'
  // —— 开场掉落：程序启动 / 角色生成时从屏幕最上方掉下来 ——
  spawnDrop?: boolean; // 是否开场从顶部掉落（默认 false）；true 时生成瞬间置于屏幕顶端，由重力接管落到地面
  spawnAction?: string; // 掉落途中播放的动作 id（默认用 fallAction）；可指向专属「入场掉落」帧
  walkActionLeft?: string; // 向左走用的动作 id（与 walkActionRight 配套，启用后不再水平翻转单图）
  walkActionRight?: string; // 向右走用的动作 id（与 walkActionLeft 配套，启用后不再水平翻转单图）
  approachAction?: string; // 相遇「走近」阶段用的移动动作 id，默认 walkAction
  climbAction?: string; // 攀爬动作 id，默认 'climb'
  dragAction?: string; // 拖拽基础动作 id（静止/上下），默认 'drag'
  dragLeftAction?: string; // 拖拽向左时动作 id，默认 dragAction
  dragRightAction?: string; // 拖拽向右时动作 id，默认 dragAction
  dragIdleAction?: string; // 拖拽静止/上下移动时动作 id，默认 dragAction
  fallAction?: string; // 空中下落阶段播放的"掉落"动作 id（如 shime4），默认 'fall'。
  //   该动作只应配「空中姿态」帧（通常单帧、loop）——触地帧不该放进这个循环，否则空中会闪出落地姿势。
  landAction?: string; // 落地触地瞬间播放的一次性动作 id（如 fall-2/3/4 触地缓冲）。未配则约定回退到名为 'land' 的动作。
  //   需配 loop:false + durationMs:0，播完由 advanceAfterAction 自动回默认动作（否则会挂 interactionDuration 才收尾）。
  //   ⚠️ 新增角色级字段必须同步在 config.ts normalizeCharacter() 的白名单 return 里加一行，否则运行时被静默丢弃。
  //   分工依据 Shimeji：Falling(空中) 与 Bouncing/Tripping(触地) 是两个独立 Action，不混在同一循环里。
  grabDialogue?: string; // 被鼠标「抓起/拖拽」时说的台词（如「放开我！」）；不写则用 knockback 台词兜底
  wanderActions?: (string | { id: string; weight?: number })[]; // 空闲时随机漫游的动作（可带权重，默认 1），默认 ['walk']
  // —— M3 贴顶爬 ——
  ceilingAction?: string; // 贴天花板横爬动作 id，默认 'ceiling'
  ceilingChance?: number; // climb 爬到顶部时进入贴顶爬的概率，默认 0.35
  ceilingDropChance?: number; // 贴顶爬到目标后直接松手掉落的概率，默认 0.35
  ceilingEdgeChance?: number; // 贴顶爬到目标且贴边时改为沿边下爬的概率，默认 0.25
  // —— M4 追鼠标 ——
  chaseAction?: string; // 追鼠标动作 id（behavior='chase'），配置了才会自发触发，默认不追
  // —— 重力 / 物理下落参数（数据驱动，可按角色微调）——
  gravity?: number; // 重力加速度(px/帧²)，默认 0.8（≈ 50 px/秒²，松手掉落自然回收感）
  throwFactor?: number; // 拖拽松手抛投：指针速度→物理初速度的系数，默认 0.9（越大甩得越远）
  maxThrow?: number; // 抛投初速度上限(px/帧)，默认 28（防甩飞出屏）
  maxThrowV?: number; // 竖直方向初速度上限(px/帧)，默认 24（比 maxThrow 小→竖直飞不高、不飘）
  tripThreshold?: number; // 落地竖直速度 >= 该值则触发摔倒(tripping)，默认 12
  bounceThreshold?: number; // 落地竖直速度 >= 该值(且 < tripThreshold)则小弹跳一次，默认 4
  tripDurationMs?: number; // 摔倒动作播放时长(ms)，默认 1200
  wanderMinDelayMs?: number; // 切回 defaultAction 后到下一次 wander 之间的最小停留(ms)，默认 1500
                           // 防"上一个动作刚结束就无缝接到下一个随机动作"的诡异观感。
  wanderTauMs?: number; // wander 触发的时间常数 τ(ms)：等待时长服从指数分布，与帧率无关。
                        // 默认 1667（等价旧版「每帧 1%」在 60fps 下的期望等待 100 帧）。越小越频繁。
  wanderRangePx?: number; // walk 单次目标点相对当前位置的最大跨度(px)，默认 320。
                          // 旧逻辑是全屏随机取点：1920 屏上平均要走 640px（≈9s），而限时只有 3.5s
                          // → 几乎每次都「走一半被切停」。改局部游走后单次行走时长可控。
  // —— wander 抽样「防重复」参数（原为硬编码，现全部可配置；默认值 = 原行为）——
  wanderRecentSize?: number;     // 记忆最近 N 个抽到的动作，默认 3
  wanderRecentExclude?: number;  // 最近的 N 个直接从候选池排除（0 = 不排除），默认 1
  wanderRecentPenalty?: number;  // 仍在记忆里但未被排除的动作，权重乘数，默认 0.2（1 = 不降权）
  wanderRecentExempt?: string[]; // 豁免名单：这些动作不受防重复压制（填 ["walk"] 即走路不被排除，
                                 // 实测频率可从约 26% 回到配置值附近）。默认空 = 全部参与。
  // —— 攀爬（climb）：一次「攀爬会话」= 上墙 → 沿边上下巡逻 → 到期下墙 ——
  climbMaxMs?: number;           // 单次攀爬会话的最长持续时间(ms)，默认 20000（20s）。
                                 // 会话期间在屏幕边框上「爬上爬下」折返巡逻，到期才收尾（掉落或起飞）。
                                 // 这是攀爬唯一的主动出口，保证不会长期挂在墙上不下来。
                                 // 注意：climb 动作自身的 durationMs 只是异常兜底，必须 > 本值
                                 // （现为 25000），否则两者同时到期会随机绕过「起飞」出口。
  climbTurnChance?: number;      // 每条攀爬腿结束时「折返方向」的概率，默认 0.35。
                                 // 到顶/到底附近强制折返；中途按此概率随机换向 → 决定爬上爬下的活跃度。
                                 // 1 = 每条腿都换向（锯齿形上下）；0 = 只在顶/底折返（一路爬到底再回来）。
  climbEndFlyChance?: number;    // 攀爬会话到期时「触发飞行动作」而非「松手掉落」的概率，默认 0.5。
                                 // 角色没有 fly 动作时恒为掉落。已在下沿附近则改为直接落地走开。
  climbDownAction?: string;      // 专用「下爬」动作 id（可选）。不配则复用 climbAction 的帧、位移反向 ——
                                 // 现有美术是方向无关的攀爬循环，复用即可；将来补了独立下爬帧再加这个字段。
  flyAction?: string;            // 飞行动作 id，默认 'fly'。攀爬到期时的「起飞」出口会用它。
  ceilingMaxMs?: number;         // 「贴顶飞行」(flyMode='ceiling') 的贴顶巡逻**最长**时长(ms)，默认 20000（20s）。
  ceilingTilt?: number;          // 「贴顶飞行」倾斜角(rad)，默认 0.22（≈12.6°）。上升段斜飞 + 巡逻段按飞行方向倾斜都用它；0 = 完全竖直不倾斜。
                                 // 计时从「到达屏幕上缘那一刻」开始（上升段不计入），实际巡逻时长取
                                 // [50%, 100%] × 本值 的随机值。到期即松手掉落（fall）。
                                 // 动作级 durationMs 必须设为 0（不挂定时器），由行为自己收尾。
  climbCooldownMs?: number;      // 攀爬结束后的冷却(ms)，默认 3000：这段时间内贴到屏幕边也不再次触发攀爬
                                 // （否则刚从墙上掉下来、人还在边缘区，会立刻又被判定撞边 → 表现为「粘在墙上不下来」）
  edgeMargin?: number; // 攀爬/贴顶时容器允许超出屏幕边缘的像素，默认 0（用负/正值把人物本体贴到边框）
  colors?: { body?: number; eye?: number };
  actions: Record<string, ActionDef>; // 动作注册表（自由 key，可任意增加）
  /** 动作组注册表：key = 组名（= 动作上的 menuGroup 值）；只影响右键菜单层级与随机池。 */
  actionGroups?: Record<string, ActionGroupDef>;
  // 相遇概率规则：按「对方角色 id」索引。chance=每判定周期触发概率，distance=触发距离门槛。
  // 没写某对 → 用全局 meetChance/meetDistance 兜底。
  meetRules?: Record<string, MeetRule>;
  // —— 退场（删除角色）动画 ——
  removeAction?: string; // 退场专属动作 id（如挥手/消失帧），没配则直接走通用淡出
  removeActionMs?: number; // 退场专属动作播放时长(ms)，默认 700
  removeFadeMs?: number; // 通用淡出时长(ms)：alpha→0 + 上浮 + 缩小，默认 400；0 = 只播专属动作
  // —— 关闭程序时的退场动画（区别于「删除角色」的 removeAction；不配则复用 removeAction）——
  exitAction?: string; // 程序退出时播放的专属动作 id；没配则复用 removeAction / 通用淡出
  /** 角色专属对话气泡（NineSlice 图或回退到代码白底气泡） */
  bubble?: BubbleDef;
  // 轻触（点击但不拖动）角色时随机说一句的台词；不写则轻触保持安静（仅用于拖拽/右键菜单）。
  tapDialogue?: string[];
}

/** 全局相遇概率兜底（角色 meetRules 没写某对时用） */
export interface MeetGlobal {
  chance?: number; // 默认每判定周期相遇概率，默认 0.02
  distance?: number; // 默认触发距离门槛(px)，默认 200
  rollInterval?: number; // 掷骰周期(ms)，默认 500
}

// 帧名 -> PNG 路径 映射结构：frames[角色id][帧名] = 相对 assets 目录的图片路径
// 实际数据来自 config/images/<角色>.json（合体帧在 config/images/coop.json）
export interface AssetManifest {
  frames?: Record<string, Record<string, string>>;
}
