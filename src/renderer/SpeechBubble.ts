import * as PIXI from 'pixi.js';
import { BubbleDef } from './types';

/**
 * 对话气泡：三段式（左 / 中 / 右）水平拼接。
 * - 左段固定宽度（含左上角装饰小图标），右段固定宽度（圆角收尾）。
 * - 中段纯背景，按文本宽度水平拉伸；文本垂直落在中段中心。
 * - 整张图按固定高度（源图高 × scale）等比缩放，不做九宫格上下切片，避免竖直拉伸变形。
 * 若纹理缺失/加载失败，回退到白底圆角矩形。
 */
export class SpeechBubble {
  public container: PIXI.Container;
  private bgLeft: PIXI.Sprite;
  private bgMid: PIXI.Sprite;
  private bgRight: PIXI.Sprite;
  private fallback: PIXI.Graphics;
  private label: PIXI.Text;
  private timer: number | null = null;
  private bubbleDef: BubbleDef;
  private currentTexture: PIXI.Texture | null = null;
  private srcH = 0;
  private hasTex = false;

  constructor(bubbleDef?: BubbleDef) {
    this.bubbleDef = bubbleDef || {};
    this.container = new PIXI.Container();
    this.container.eventMode = 'none';

    this.bgLeft = new PIXI.Sprite();
    this.bgMid = new PIXI.Sprite();
    this.bgRight = new PIXI.Sprite();
    this.fallback = new PIXI.Graphics();
    this.label = new PIXI.Text({ text: '', style: this.buildStyle() });
    this.label.anchor.set(0.5);

    this.container.addChild(this.bgLeft, this.bgMid, this.bgRight, this.fallback, this.label);
    this.bgLeft.visible = this.bgMid.visible = this.bgRight.visible = false;
    this.fallback.visible = false;
    this.container.visible = false;
  }

  /** 更新气泡配置（用于 applyConfig 热重载）；若已有纹理则按新 insets 重建。 */
  applyConfig(bubbleDef?: BubbleDef) {
    this.bubbleDef = bubbleDef || {};
    if (this.currentTexture) this.setTexture(this.currentTexture);
  }

  /** 异步设置三段纹理；传入 null 则保留白底 Graphics 兜底。 */
  setTexture(tex: PIXI.Texture | null) {
    this.currentTexture = tex;
    if (tex) {
      const d = this.bubbleDef;
      const leftWidth = d.leftWidth ?? 32;
      const rightWidth = d.rightWidth ?? 32;
      this.srcH = tex.height;
      const srcW = tex.width;
      const midW = Math.max(1, srcW - leftWidth - rightWidth);

      this.bgLeft.texture = new PIXI.Texture({
        source: tex.source,
        frame: new PIXI.Rectangle(0, 0, leftWidth, this.srcH),
      });
      this.bgMid.texture = new PIXI.Texture({
        source: tex.source,
        frame: new PIXI.Rectangle(leftWidth, 0, midW, this.srcH),
      });
      this.bgRight.texture = new PIXI.Texture({
        source: tex.source,
        frame: new PIXI.Rectangle(srcW - rightWidth, 0, rightWidth, this.srcH),
      });
      this.hasTex = true;
    } else {
      this.hasTex = false;
    }
  }

  show(text: string, duration = 2000) {
    this.label.text = text;
    this.label.style = this.buildStyle();

    const d = this.bubbleDef;
    const scale = d.scale ?? 0.4;
    const leftWidth = d.leftWidth ?? 32;
    const rightWidth = d.rightWidth ?? 32;
    const paddingX = d.paddingX ?? 14;
    const paddingY = d.paddingY ?? 8;
    const textOffsetX = d.textOffsetX ?? 2;
    const textOffsetY = d.textOffsetY ?? 3;
    const textW = this.label.width;
    const textH = this.label.height;

    if (this.hasTex && this.srcH > 0) {
      const tex = this.currentTexture!;
      const srcW = tex.width;
      const srcH = this.srcH;
      const midSrcW = Math.max(1, srcW - leftWidth - rightWidth);
      // 中段宽度 = 文本宽度 + 水平留白，至少给 minWidth（短文本也不会缩成一小条）
      const midDispW = Math.max(textW + paddingX * 2, d.minWidth ?? 60);
      // 保持整张气泡原图宽高比：H / totalW = srcH / srcW
      // 推导得 totalH = midDispW * srcH / midSrcW
      const totalH = midDispW * (srcH / midSrcW);
      const totalW = totalH * (srcW / srcH);
      const leftDispW = totalH * (leftWidth / srcH);
      const rightDispW = totalH * (rightWidth / srcH);

      this.bgLeft.visible = this.bgMid.visible = this.bgRight.visible = true;
      this.fallback.visible = false;

      this.bgLeft.width = leftDispW;
      this.bgLeft.height = totalH;
      this.bgLeft.x = -totalW / 2;
      this.bgLeft.y = -totalH / 2;

      this.bgMid.width = midDispW;
      this.bgMid.height = totalH;
      this.bgMid.x = -totalW / 2 + leftDispW;
      this.bgMid.y = -totalH / 2;

      this.bgRight.width = rightDispW;
      this.bgRight.height = totalH;
      this.bgRight.x = -totalW / 2 + leftDispW + midDispW;
      this.bgRight.y = -totalH / 2;

      // 文本落在中段水平中心、容器垂直中心（带微调偏移）
      this.label.position.set(-totalW / 2 + leftDispW + midDispW / 2 + textOffsetX, textOffsetY);
    } else {
      // 回退：白底圆角矩形
      const w = Math.max(textW + paddingX * 2, 60);
      const h = Math.max(textH + paddingY * 2, 30);
      this.bgLeft.visible = this.bgMid.visible = this.bgRight.visible = false;
      this.fallback.visible = true;
      this.fallback.clear();
      this.fallback
        .roundRect(-w / 2, -h / 2, w, h, 8)
        .fill({ color: 0xffffff, alpha: 0.96 })
        .stroke({ width: 1, color: 0xcccccc });
      this.label.position.set(textOffsetX, textOffsetY);
    }

    this.label.anchor.set(0.5);
    this.container.visible = true;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.container.visible = false;
    }, duration);
  }

  setPosition(x: number, y: number) {
    this.container.position.set(x, y);
  }

  /** 立即隐藏气泡（退场/打断时用），清掉自动消失定时器。 */
  hide() {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.container.visible = false;
  }

  private buildStyle(): PIXI.TextStyle {
    const d = this.bubbleDef;
    return new PIXI.TextStyle({
      fill: d.textColor ?? 0xffffff,
      fontSize: d.fontSize ?? 14,
      fontFamily: 'sans-serif',
      fontWeight: '500',
      wordWrap: true,
      wordWrapWidth: d.maxTextWidth ?? 180,
      breakWords: true,
    });
  }
}
