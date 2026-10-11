/**
 * 「哪扇窗口是屏幕最上层」的判定（纯函数，可 headless 单测）。
 *
 * ## 为什么单独成文件
 * 2026-10-11 用户要求：**站立的窗口必须在屏幕最上层，不在上层就不要触发**。
 * 这条规则要同时作用在四个入口（窗顶穿越检测 / 已站窗顶的每帧校验 / 拖放落点 / 自动站窗），
 * 抽出来是为了只写一遍、且能被 `scripts/test-window-top.mjs` 直接测到——
 * `windowInteract.ts` 顶层就 `require('electron')`，在 Node 里根本 require 不进来。
 *
 * ## 判据
 * - `z`：主进程 `listWindows` 用 `EnumWindows` 枚举，它**按 Z 序顶→底**回调，先 push 的 z 更小。
 *   注意 z 只在「可互动窗口」（白名单命中、非最大化、尺寸达标…）之间递增——
 *   被跳过的窗口（最大化、非名单）不占位，所以 z=0 是「最上层的**可互动**窗口」。
 * - `occluded`：对窗口中心 + 四角内侧 5 个采样点调 `WindowFromPoint`，**全部**没命中自己 = 看不见。
 *   被非名单窗口整个盖住就是这个情况（典型：最大化的浏览器压住了名单里的小窗）。
 *
 * ⇒ 「最上层」= **Z 序最靠前且没被完全遮挡**的那扇。全被遮 → 返回 null（此时一律不触发）。
 *   被盖掉一半仍算可见（屏幕上确实还露着一大块），这种仍可站。
 */
export interface WinLike {
  hwnd: number;
  /** Z 序索引，越小越靠前（顶）。缺省按 0 处理。 */
  z?: number;
  /** 采样点全被更高层窗口覆盖 = 看不见。 */
  occluded?: boolean;
  title?: string;
}

/** 取当前「用户眼中最上层」的那扇可互动窗口；没有看得见的 → null。 */
export function pickTopmostWindow(wins: readonly WinLike[] | null | undefined): WinLike | null {
  if (!wins || wins.length === 0) return null;
  let best: WinLike | null = null;
  let bestZ = Infinity;
  for (const w of wins) {
    if (w.occluded) continue; // 完全看不见 → 不可能是「用户眼中」的最上层
    const z = w.z ?? 0;
    if (z < bestZ) { bestZ = z; best = w; }
  }
  return best;
}

/** 这扇窗是不是当前最上层那扇（用于「不在上层就不要触发」的各处闸门）。 */
export function isTopmostWindow(w: WinLike, wins: readonly WinLike[] | null | undefined): boolean {
  const top = pickTopmostWindow(wins);
  return !!top && top.hwnd === w.hwnd;
}
