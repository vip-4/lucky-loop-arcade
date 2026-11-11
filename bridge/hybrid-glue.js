/* =========================================================================
 * hybrid-glue.js — 游戏与 NativeBridge 之间的胶水层（纯 JS，无 HTML 标签）
 * 由 build-hybrid.ps1 读取并用 <script> 包裹后内联进单文件产物。
 * 单独存在时也可在引入 NativeBridge.js 之后直接 <script> 引入。
 *
 * 职责：
 *   下行：原生事件 → 游戏暂停/恢复、玩币余额播报
 *   上行：游戏状态与免费旋转结果 → 原生
 * 纯浏览器环境自动降级为本地 mock，游戏行为完全不变。
 * ========================================================================= */
(function () {
  'use strict';
  if (!window.NativeBridge) return;                 // 桥未加载则静默降级

  var B = window.NativeBridge;
  var live = document.getElementById('live');
  var say = function (msg) { if (live) live.textContent = msg; };

  B.configure({
    debug: false,
    // 方法白名单：页面只允许调用这些原生能力，缩小注入攻击面
    whitelist: [
      'bridge.hello', 'wallet.balance', 'game.spin', 'game.result',
      'game.state', 'device.haptic', 'app.close'
    ]
  });

  /* ---- 原生 → 游戏 ---- */
  B.Slots.onPause(function () {
    if (typeof togglePause === 'function' && typeof state !== 'undefined' && state !== 'paused') togglePause();
  });
  B.Slots.onResume(function () {
    if (typeof togglePause === 'function' && typeof state !== 'undefined' && state === 'paused') togglePause();
  });
  B.Slots.onAppState(function (d) {
    if (d && d.state === 'background' &&
        typeof state !== 'undefined' && state === 'playing' &&
        typeof togglePause === 'function') togglePause();
  });
  B.Slots.onBalanceChanged(function (d) {
    // 玩币余额仅用于对账/播报，绝不覆盖本地游戏分数
    say('玩币余额：' + (d && d.balance));
  });

  /* ---- 游戏 → 原生 ---- */
  // 钩子由游戏本体调用；reportSpinResult 只含 CREDITS 与 playMoney:true
  window.__onSpinResult = function (r) {
    B.Slots.reportSpinResult(r).catch(function () {});
    B.Slots.haptic('light');
  };
  window.__onGameState = function (s) { B.Slots.setGameState(s); };

  /* ---- 握手：web 环境 ready() 立即 resolve，不产生任何等待 ---- */
  B.ready().then(function (env) {
    say('桥接已就绪：' + env.platform);
    if (!env.isNative) return;                     // 仅原生环境才拉取玩币余额
    return B.Slots.getBalance().then(function (w) {
      say('玩币余额：' + (w && w.balance));
    });
  }).catch(function () {
    // 原生桥不可用时完全降级为纯 H5，不提示、不阻塞
  });
})();
