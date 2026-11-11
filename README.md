# Lucky Loop Arcade

免费的 **SLOT 打砖块** H5 小游戏与 **Firebase AI Logic / WebView Bridge** 示例。
仅玩币（play-money）· 18+ · 无真实货币、充值、提现或奖品。

## 在线入口

| 页面 | 说明 |
| --- | --- |
| [`./`](./) | 单文件游戏 `lucky-reels-breaker.html`（HTML + CSS + 原生 JS 全在一个文件，Canvas 自绘全部图形） |
| [`hybrid.html`](./hybrid.html) | 已内联 `NativeBridge` + 胶水层的单文件 Hybrid 版，供 WebView / 原生 App 使用 |
| [`bridge/NativeBridge.js`](./bridge/NativeBridge.js) | 跨平台桥接核心（iOS WKWebView / Android / React Native / 浏览器 mock） |

## 玩法

- **PC**：`← →` / `A D` 移动挡板，`空格` / `回车` 发球，`P` / `Esc` 暂停
- **移动端**：滑动挡板，点击发球
- 击碎老虎机符号砖块得分（樱桃 8 / 星星 12 / 四叶草 20 / 铃铛 40 / 钻石 100 / 7 200），
  连续命中叠加 Combo 加成；每敲碎 8 块触发 **FREE SPIN**，三个相同符号 +500 且 +1 命。
- 掉球扣 1 命，3 命用尽结束；清空砖块进入下一关且球速递增。

## 特性

零外部依赖、无图片、无 CDN、无网络请求；支持触摸与键盘；`prefers-reduced-motion` 降级；
DOM HUD + `aria-live` 播报；最高分本地持久化。

Bridge 协议、Swift / Kotlin 原生接入示例与安全清单见 [`bridge/README.md`](./bridge/README.md)。

> 本文件为发布目录说明。完整源码与构建脚本见项目仓库 `h5/` 目录。
