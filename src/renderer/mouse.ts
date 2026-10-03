/**
 * 全局鼠标状态（渲染层）：位置 + 速度 + 最近一次移动时间。
 * 穿透窗口的 forward 模式下 mousemove 事件仍会送达页面（见 main 的
 * set-ignore-mouse-events({forward:true})），因此这里能持续拿到指针位置。
 * 供 Look（trackMouse 翻转朝向）与 ChaseMouse（追指针）消费。
 */
export const mouseState = {
  x: -1,
  y: -1,
  vx: 0, // 水平速度(px/事件，指数平滑)
  vy: 0,
  lastMove: 0, // 最近一次 mousemove 时间戳（performance.now()）
  speed: 0, // |v|
};

/** 初始化全局 mousemove 跟踪（在 renderer 入口调用一次）。 */
export function initMouseTracker() {
  window.addEventListener('mousemove', (e: MouseEvent) => {
    const s = mouseState;
    if (s.x >= 0) {
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      s.vx = s.vx * 0.7 + dx * 0.3;
      s.vy = s.vy * 0.7 + dy * 0.3;
    }
    s.x = e.clientX;
    s.y = e.clientY;
    s.speed = Math.hypot(s.vx, s.vy);
    s.lastMove = performance.now();
  });
}

/** 鼠标是否「最近仍在移动」（chase 触发/保持条件之一）。 */
export function mouseActive(windowMs = 1200): boolean {
  return performance.now() - mouseState.lastMove < windowMs && mouseState.speed > 0.5;
}
