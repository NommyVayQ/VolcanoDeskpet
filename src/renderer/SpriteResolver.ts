import * as PIXI from 'pixi.js';
import { AssetManifest } from './types';

// 通过 electron 的 node 集成读取外部文件（与打包/开发环境无关）
const req: any = (window as any).require;
const fs = req('fs');
const path = req('path');

/**
 * 资源解析器：
 * - 运行时从外部 config/images/ 目录读取「帧名 -> PNG 路径」映射（按角色分文件）
 * - 实际 PNG 仍从 assets/ 目录读取
 * - 找不到映射 / 图片时返回空，调用方回退到占位图形
 * - 图片用 PIXI.Assets.load 异步加载（v8 推荐），避免空壳纹理
 * 用户只需替换 PNG + 改 config/images/<角色>.json，无需重新打包。
 */
export class SpriteResolver {
  private assetDir: string;
  private configDir: string;
  private cache = new Map<string, PIXI.Texture>();
  manifest: AssetManifest | null = null;

  constructor(assetDir: string, configDir: string) {
    this.assetDir = assetDir;
    this.configDir = configDir;
  }

  async init() {
    // 从 config/images/<角色>.json 拼出 frames[角色] 映射；coop 帧也来自此处
    const frames: Record<string, Record<string, string>> = {};
    try {
      const dir = path.join(this.configDir, 'images');
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json')) continue;
          const role = f.replace(/\.json$/, '');
          try {
            frames[role] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
          } catch {
            console.warn('[SpriteResolver] 解析失败，跳过:', f);
          }
        }
      }
      this.manifest = { frames } as AssetManifest;
    } catch {
      this.manifest = null;
    }
  }

  /** 热重载：重新读取 manifest（新增/修改的帧会在 pets 重建时被按需解码） */
  async reload() {
    await this.init();
  }

  /**
   * 异步加载一张 PNG；缺失或加载失败返回 null，调用方继续占位回退。
   * 使用 PIXI v8 的 Assets.load 异步加载，资源编码为 data URI 传入，
   * 规避 Electron 渲染进程对 file:// fetch 的限制。结果按 rel 路径缓存。
   */
  private async loadTexture(rel: string): Promise<PIXI.Texture | null> {
    if (this.cache.has(rel)) return this.cache.get(rel)!;
    const abs = path.join(this.assetDir, rel);
    if (!fs.existsSync(abs)) {
      console.warn('[SpriteResolver] missing:', abs);
      return null;
    }
    try {
      const buf = fs.readFileSync(abs);
      const dataUri = 'data:image/png;base64,' + buf.toString('base64');
      const tex = await PIXI.Assets.load<PIXI.Texture>(dataUri);
      this.cache.set(rel, tex);
      return tex;
    } catch (e) {
      console.warn('[SpriteResolver] load failed:', rel, e);
      return null;
    }
  }

  /** 按帧名加载一张图；帧名在 manifest.frames[charId][frameName] 查路径。
   *  合体动作帧统一放在 frames.coop 下，故查不到时回退到 coop 命名空间。 */
  async loadFrame(charId: string, frameName: string): Promise<PIXI.Texture | null> {
    const rel = this.manifest?.frames?.[charId]?.[frameName]
      ?? this.manifest?.frames?.['coop']?.[frameName];
    if (!rel) {
      console.warn('[SpriteResolver] no manifest entry for', charId, '/', frameName);
      return null;
    }
    return this.loadTexture(rel);
  }

  /** 批量加载一组帧名，返回有效贴图数组（过滤缺失帧） */
  async loadFrames(charId: string, frameNames: string[]): Promise<PIXI.Texture[]> {
    const out: PIXI.Texture[] = [];
    for (const f of frameNames) {
      const tex = await this.loadFrame(charId, f);
      if (tex) out.push(tex);
    }
    return out;
  }
}
