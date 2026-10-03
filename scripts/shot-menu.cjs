// 用项目自带的 Electron 把菜单预览页渲染成 PNG（无需额外安装 Chromium）。
// 用法：npx electron scripts/shot-menu.cjs <html路径> <输出png路径>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const htmlPath = process.argv[2];
const outPath = process.argv[3];

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 720,
    show: false,
    backgroundColor: '#1e1e22',
    webPreferences: { offscreen: true },
  });
  await win.loadFile(htmlPath);
  // 等一帧渲染稳定
  await new Promise((r) => setTimeout(r, 900));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(outPath, img.toPNG());
  console.log('saved ' + outPath);
  app.exit(0);
}).catch((e) => {
  console.error('shot failed:', e);
  app.exit(1);
});
