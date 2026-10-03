/** 主进程启动诊断日志（独立小模块，避免 winapi <-> index 循环依赖）。 */
const logBuffer: string[] = [];
let logPath: string | null = null;

export function logBoot(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (logPath) {
    try { require('fs').appendFileSync(logPath, line + '\n'); } catch { /* ignore */ }
  } else {
    logBuffer.push(line);
  }
}

/** 日志落盘路径就绪后，把缓冲的行刷进去（由 index.ts 在 app ready 时调用）。 */
export function attachBootLog(p: string) {
  logPath = p;
  for (const l of logBuffer) {
    try { require('fs').appendFileSync(logPath, l + '\n'); } catch { /* ignore */ }
  }
  logBuffer.length = 0;
}
