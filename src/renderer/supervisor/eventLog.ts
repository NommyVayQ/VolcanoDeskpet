/**
 * 监管日志总线（Supervisor Event Log）
 * --------------------------------------------------------------
 * 职责：只读结构化事件环形缓冲，给「角色监管窗口」提供溯源数据源。
 *
 * 与现有 src/renderer/eventBus.ts 的区别：
 * - eventBus.ts 是「业务事件总线」(命名事件 + 任意回调，用于右键菜单/互动等解耦)
 * - 本文件是「监管日志总线」(结构化 PetLogEvent + 环形缓冲 + 快照/导出)
 *
 * 设计原则：
 * 1. 永远不抛异常 —— 任何失败都用 try/catch 包死，绝不污染主流程
 * 2. 极轻量 —— 每事件 < 1KB JSON，emit 仅做 push + 触发订阅
 * 3. 环形缓冲 —— 容量 1000，满了覆盖最老的（卡死复现通常集中在最后几十条）
 * 4. 时间三件套 —— ts(Date.now 给人看) / tsMs(performance.now 给分析) / frame(PIXI 帧号对齐)
 * 5. 延迟挂载 —— 生产版无面板时 IPC flush 是空操作，零成本
 */

export type LogLevel = 'action' | 'physics' | 'system' | 'warn' | 'error';

export interface PetLogEvent {
  /** 给人看的时间戳（ms） */
  ts: number;
  /** 给分析用的相对时间戳（ms），性能计时器 */
  tsMs: number;
  /** PIXI 帧号，用于跨事件对齐 */
  frame: number;
  level: LogLevel;
  /** 当前 pet id（如有）。跨 pet 事件可省 */
  petId?: string;
  /** 事件分类，如 'action.change' / 'physics.thrown' / 'hotreload.debounced' */
  category: string;
  /** 触发源，如 'mouse.left' / 'walk.boundary' / 'config.reload'；非必须 */
  cause?: string;
  /** 触发前状态快照（仅必要时填，控制在 ~200B 内） */
  before?: unknown;
  /** 触发后状态快照 */
  after?: unknown;
  /** 自由元数据：dtMs / vx / vy / facingRight / ... */
  meta?: Record<string, unknown>;
}

type Listener = (batch: PetLogEvent[]) => void;

/** 环形缓冲容量。1000 条够溯源 30s 内事件（约 60fps × 30s = 1800 帧，按 1/2 命中率 1000 命中） */
const RING_CAPACITY = 1000;

/** 当前 PIXI 帧号（由 Pet 初始化时设置一次，每帧 +1） */
let currentFrame = 0;
/** 当前会话开始时间（performance.now） */
const sessionStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** 每 200ms 或 16 条批量 flush 给订阅者（避免每帧 IPC 卡 ticker） */
const FLUSH_INTERVAL_MS = 200;
const FLUSH_BATCH_SIZE = 16;

class SupervisorLog {
  private buffer: PetLogEvent[] = [];
  private writeIndex = 0;
  private filled = 0;
  private listeners = new Set<Listener>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pendingBatch: PetLogEvent[] = [];
  private paused = false;
  /** 累计写入数（用于诊断：是否真的在 emit） */
  public totalEmitted = 0;
  /** 累计订阅者数 */
  public subscriberCount = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  /** 由 Pet.ts 在每帧 PIXI tick 末尾调用，让 frame 字段与画面帧对齐 */
  tickFrame(frame: number) {
    currentFrame = frame;
  }

  /** 主入口：埋点调用此方法。失败也不抛。 */
  emit(partial: Omit<PetLogEvent, 'ts' | 'tsMs' | 'frame'>) {
    if (this.paused) return;
    try {
      const e: PetLogEvent = {
        ...partial,
        ts: Date.now(),
        tsMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - sessionStart,
        frame: currentFrame,
      };
      // 环形写入
      this.buffer[this.writeIndex] = e;
      this.writeIndex = (this.writeIndex + 1) % RING_CAPACITY;
      if (this.filled < RING_CAPACITY) this.filled++;
      this.totalEmitted++;

      // 批量 flush（监听者是 UI 面板或 IPC 桥，不是高频逻辑）
      this.pendingBatch.push(e);
      if (this.pendingBatch.length >= FLUSH_BATCH_SIZE) this.flush();
    } catch (err) {
      // 监管日志绝不影响主流程 —— 静默吞掉
      // eslint-disable-next-line no-console
      console.warn('[supervisorLog] emit failed:', err);
    }
  }

  /** 批量推给订阅者 */
  private flush() {
    if (this.pendingBatch.length === 0) return;
    if (this.listeners.size === 0) {
      this.pendingBatch = [];
      return;
    }
    const batch = this.pendingBatch;
    this.pendingBatch = [];
    for (const fn of this.listeners) {
      try {
        fn(batch);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[supervisorLog] listener failed:', err);
      }
    }
  }

  /** 订阅实时事件流（参数是批量数组，不是单条）。返回 unsubscribe */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    this.subscriberCount = this.listeners.size;
    return () => {
      this.listeners.delete(fn);
      this.subscriberCount = this.listeners.size;
    };
  }

  /** 全量快照（按时间正序）。用于导出和首次打开面板补齐历史 */
  snapshot(): PetLogEvent[] {
    if (this.filled === 0) return [];
    const out: PetLogEvent[] = [];
    if (this.filled < RING_CAPACITY) {
      for (let i = 0; i < this.filled; i++) out.push(this.buffer[i]);
    } else {
      // 环形已满，从 writeIndex 开始（即最老的）到 writeIndex-1（最新的）
      for (let i = 0; i < RING_CAPACITY; i++) {
        out.push(this.buffer[(this.writeIndex + i) % RING_CAPACITY]);
      }
    }
    return out;
  }

  /** 清空所有日志（用户在面板点"清空"时调用） */
  clear() {
    this.buffer = [];
    this.writeIndex = 0;
    this.filled = 0;
    this.pendingBatch = [];
    this.totalEmitted = 0;
  }

  /** 暂停订阅（面板展开太多事件时可临时关） */
  setPaused(p: boolean) {
    this.paused = p;
  }
  isPaused() {
    return this.paused;
  }

  /** 调试用：诊断日志总线自身状态 */
  diagnose() {
    return {
      filled: this.filled,
      capacity: RING_CAPACITY,
      writeIndex: this.writeIndex,
      totalEmitted: this.totalEmitted,
      subscribers: this.listeners.size,
      pendingBatch: this.pendingBatch.length,
      paused: this.paused,
      currentFrame,
    };
  }
}

/** 模块级单例：整个 renderer 进程共用一份 */
export const supervisorLog = new SupervisorLog();