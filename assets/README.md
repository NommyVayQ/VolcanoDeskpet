# 美术资源替换说明 (Assets)

本程序运行时从本目录加载角色贴图。**只要把图片丢进对应目录、并在 `manifest.json` 用「帧名」登记，重启（或开发模式热重载）即生效，无需重新打包、无需改代码。**

## 当前已接入的角色（v0.3.0）

| 角色 id | 显示名 | 走路帧 | 相遇图（循环帧） | 相遇台词 |
|---|---|---|---|---|
| `nina` | 妮娜 | `shime1/2/3` | `shime50/51/52`（3 帧循环） | 露丝！ |
| `rose` | 露丝 | `shime1/2/3` | `shime50` + `shime51-1`（2 帧循环） | 妮娜！ |

## 目录结构

```
assets/
  manifest.json        # 声明 frames[角色id][帧名] = 图片路径
  nina/
    shime1.png         # 帧名 shime1（待机/走路/拖拽通用静止帧）
    shime2.png         # 帧名 shime2
    shime3.png         # 帧名 shime3
    shime50.png        # 帧名 shime50
    shime51.png        # 帧名 shime51
    shime52.png        # 帧名 shime52
  rose/
    shime1.png
    shime2.png
    shime3.png
    shime50.png
    shime51-1.png
```

## 当前 manifest.json 结构（frames）

```json
{
  "frames": {
    "nina": {
      "shime1": "nina/shime1.png",
      "shime2": "nina/shime2.png",
      "shime3": "nina/shime3.png",
      "shime50": "nina/shime50.png",
      "shime51": "nina/shime51.png",
      "shime52": "nina/shime52.png"
    },
    "rose": {
      "shime1": "rose/shime1.png",
      "shime2": "rose/shime2.png",
      "shime3": "rose/shime3.png",
      "shime50": "rose/shime50.png",
      "shime51-1": "rose/shime51-1.png"
    }
  }
}
```

- `frames[角色id][帧名]` = 相对本 assets 目录的图片路径。
- 动作引用帧时**写帧名**（见 `config/config.json` 的 `actions.*.frames`），不再用位置索引——写错帧名会显式告警，不会静默回退。
- 图片缺失 → 该动作回退到内置占位方块，**不会报错崩溃**。

## 自己换美术 / 加帧

1. 把新图放进 `assets/<角色id>/`。
2. 在 `manifest.json` 的 `frames.<角色id>` 下加一条 `"帧名": "<角色id>/文件名.png"`。
3. 在 `config/config.json` 的 `actions.<动作id>.frames` 里用该帧名。
4. 重启（或 dev 模式自动热重载）。

示例（给妮娜加独立待机图）：
```json
// manifest.json
"nina": { "idle1": "nina/idle1.png", ... 其他帧 }
// config.json -> actions.idle.frames: ["idle1"]
```

## 修改参数（台词/速度/气泡/加动作）

这些**行为参数**统一在 `config/config.json`（便携版在 `DeskPet.exe` 同级的 `config/`）。
详见 `config/README.md`。改完重启即生效；开发模式 (`npm run dev`) 自动热重载。

## 图片建议

- 正方形透明背景 PNG 最佳（当前显示高度 = 150，宽度按真实比例自适应，不会拉伸变形）。
- 走路帧：3 张按"左脚→中立→右脚"顺序循环最自然。

## 注意

- 打包后的程序，资源位于 `DeskPet-Portable-*/resources/assets/`。
- 开发模式 (`npm run dev`) 下，修改 `config/` 或 `assets/` 会被 `fs.watch` 监听，自动重建宠物（防抖 300ms），无需手动重启。
