/* =============================================================================
 * NativeBridge.js — H5 老虎机游戏的跨平台 WebView ↔ 原生双向通信核心
 * -----------------------------------------------------------------------------
 * 支持通道（自动探测，也可 configure() 显式指定）：
 *   1. iOS  WKWebView : window.webkit.messageHandlers.<name>.postMessage(object)
 *   2. Android        : window.<Interface>.<method>(jsonString)   (@JavascriptInterface)
 *   3. React Native   : window.ReactNativeWebView.postMessage(jsonString)
 *   4. 纯浏览器 / 调试 : 本地 mock，不会发网络请求，便于本地开发与单测
 *
 * 双向通信模型：
 *   JS → Native : call(method, params) 返回 Promise，带自增 id 与超时。
 *   Native → JS : 原生调用 NativeBridge._receive(jsonString|object)，
 *                 可回复响应(type:'res')、推送事件(type:'evt')、心跳(type:'ping')。
 *
 * 运行环境基线：需支持 Promise / Map / Set / class
 *   （iOS 10+、Android 5.1+ 系统 WebView；更老环境请注入 polyfill）。
 *
 * 安全约定：
 *   - 所有来自原生的报文都先 JSON 解析并做结构校验，任何异常都不会抛回原生层。
 *   - 支持方法白名单，防止页面被注入后调用敏感原生能力。
 *   - 业务层只传虚拟币（play-money / CREDITS），绝不传真实货币金额或支付凭证。
 *   - 本模块不持有任何密钥、token 或用户隐私数据。
 *
 * 用法（将本文件通过 script 标签引入页面后，以下示例即可直接调用）：
 *     NativeBridge.configure({ debug: true });
 *     NativeBridge.ready().then(() => NativeBridge.Slots.requestSpin({ bet: 5 }));
 *     NativeBridge.on('wallet.changed', d => console.log(d));
 * ============================================================================= */

(function (root, factory) {
  'use strict';
  var api = factory(root);                    // 必须把宿主对象传给 factory
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;                       // CommonJS（便于单测 / 打包）
  } else {
    root.NativeBridge = api;                    // 浏览器全局：原生侧据此调用 _receive
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  // 注意：root 必须作为 factory 的形参传入。
  // factory 定义在外层 IIFE 的实参位置，其词法作用域是全局，
  // 无法直接捕获外层 IIFE 的形参；显式传参才能让 detect() 等内部函数拿到宿主对象。
  'use strict';

  /* ============ 1. 协议常量 ============ */
  var PROTOCOL = 'lucky-loop/1';                // 协议版本，原生侧可据此做兼容
  var VERSION  = '1.0.0';
  var DEFAULT_TIMEOUT = 8000;                  // 单次 call 默认超时（毫秒）
  var MAX_PENDING = 200;                        // 未完成请求上限，防内存泄漏

  /** 业务事件名常量，避免各处手写字符串拼错 */
  var EVENTS = {
    READY:          'app.ready',                // 原生侧初始化完成
    STATE:          'app.state',                // 前后台切换 active/background
    PAUSE:          'game.pause',               // 原生要求游戏暂停
    RESUME:         'game.resume',
    WALLET_CHANGED: 'wallet.changed',           // 虚拟币余额变化
    CONFIG_CHANGED: 'config.changed',           // 远程配置 / 玩法参数变化
    SPIN_RESULT:    'game.spinResult',          // 原生下发的开奖结果（若由原生做 RNG）
    BRIDGE_ERROR:   'bridge.error',             // 桥接层内部错误
    BRIDGE_WARN:    'bridge.warn'
  };

  /* ============ 2. 可配置项 ============ */
  var cfg = {
    iosHandler:       'luckyLoopBridge',        // WKScriptMessageHandler 名称
    androidInterface: 'LuckyLoopBridge',        // addJavascriptInterface 注入的对象名
    androidMethod:    'postMessage',            // 该对象上 @JavascriptInterface 方法名
    timeout:          DEFAULT_TIMEOUT,
    whitelist:        null,                     // null = 不限制；传数组 = 允许的方法名列表
    debug:            false
  };

  /* ============ 3. 内部状态 ============ */
  var pending   = new Map();                    // id -> { resolve, reject, timer, method }
  var listeners = new Map();                    // event -> Set<handler>
  var seq       = 0;                            // 自增消息 id
  var env       = null;                         // 探测结果缓存
  var mockHandler = null;                       // 浏览器调试用的本地处理器
  var helloed  = false;

  /** 带前缀的调试日志，生产环境静默 */
  function log(){
    if (!cfg.debug || typeof console === 'undefined') return;
    try { console.log.apply(console, ['[NativeBridge]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }
  function warn(){
    if (typeof console === 'undefined') return;
    try { console.warn.apply(console, ['[NativeBridge]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }

  /** 统一的桥接错误类型，便于业务侧 catch 后区分错误来源 */
  function BridgeError(code, message, detail) {
    this.name = 'BridgeError';
    this.code = code || 'E_UNKNOWN';
    this.message = message || 'NativeBridge error';
    this.detail = detail || null;
  }
  BridgeError.prototype = Object.create(Error.prototype);
  BridgeError.prototype.constructor = BridgeError;

  /* ============ 4. 环境探测 ============
   * 顺序很重要：RN WebView 也可能存在 webkit 对象，故优先识别 RN；
   * 探测结果缓存，避免每次 call 都做反射。
   */
  function detect() {
    if (env) return env;
    var w = root;
    var result = { platform: 'web', channel: 'mock', handler: null, method: null, protocol: PROTOCOL };

    if (w.ReactNativeWebView && typeof w.ReactNativeWebView.postMessage === 'function') {
      result.platform = 'react-native';
      result.channel  = 'ReactNativeWebView.postMessage';
      result.handler  = w.ReactNativeWebView;
      result.method   = 'postMessage';
    } else if (w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers[cfg.iosHandler]) {
      result.platform = 'ios';
      result.channel  = 'webkit.messageHandlers.' + cfg.iosHandler;
      result.handler  = w.webkit.messageHandlers[cfg.iosHandler];
      result.method   = 'postMessage';
    } else if (w[cfg.androidInterface] && typeof w[cfg.androidInterface][cfg.androidMethod] === 'function') {
      result.platform = 'android';
      result.channel  = cfg.androidInterface + '.' + cfg.androidMethod;
      result.handler  = w[cfg.androidInterface];
      result.method   = cfg.androidMethod;
    }
    env = result;
    log('detected', result.platform, result.channel);
    return result;
  }

  /** 修改配置；会重置环境探测缓存，允许运行时切换通道（主要用于调试） */
  function configure(options) {
    if (!options || typeof options !== 'object') return getEnv();
    Object.keys(options).forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(cfg, k)) cfg[k] = options[k];
    });
    env = null;                                  // 配置变化后重新探测
    return getEnv();
  }

  function getEnv() {
    var d = detect();
    return {
      platform: d.platform,
      channel:  d.channel,
      protocol: PROTOCOL,
      version:  VERSION,
      isNative: d.platform !== 'web',
      debug:    cfg.debug
    };
  }

  /* ============ 5. 事件总线（Native → JS 的下行通道） ============ */
  function on(event, fn) {
    if (typeof event !== 'string' || typeof fn !== 'function') return function () {};
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    // 返回取消订阅函数，业务侧可直接 off = NativeBridge.on(...)
    return function () { off(event, fn); };
  }

  function once(event, fn) {
    var wrap = function (data) { off(event, wrap); fn(data); };
    return on(event, wrap);
  }

  function off(event, fn) {
    var set = listeners.get(event);
    if (!set) return;
    if (typeof fn === 'function') set.delete(fn);
    else set.clear();
    if (set.size === 0) listeners.delete(event);
  }

  /** 触发事件；单个监听器抛错不影响其它监听器，也不会冒泡到原生层 */
  function emit(event, data) {
    [event, '*'].forEach(function (key) {
      var set = listeners.get(key);
      if (!set) return;
      // 复制一份再遍历，允许监听器内部增删订阅
      Array.from(set).forEach(function (fn) {
        try { fn(data, event); }
        catch (e) { warn('listener error on "' + event + '"', e); }
      });
    });
  }

  /* ============ 6. 报文构造与分发 ============ */
  function nextId() {
    seq += 1;
    return 'js-' + Date.now().toString(36) + '-' + seq.toString(36);
  }

  /** 校验方法名：只允许字母开头的点/下划线/连字符命名，且可走白名单 */
  function assertMethod(method) {
    if (typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(method)) {
      throw new BridgeError('E_METHOD', '非法的方法名: ' + String(method));
    }
    if (cfg.whitelist && cfg.whitelist.length && cfg.whitelist.indexOf(method) === -1) {
      throw new BridgeError('E_FORBIDDEN', '方法不在白名单内: ' + method);
    }
  }

  /** 校验参数可序列化，避免把 DOM / 循环引用对象丢给原生导致崩溃 */
  function serializeParams(params) {
    if (params === undefined || params === null) return {};
    if (typeof params !== 'object') {
      throw new BridgeError('E_PARAMS', 'params 必须是对象');
    }
    try { JSON.stringify(params); }
    catch (e) { throw new BridgeError('E_PARAMS', 'params 无法序列化', e); }
    return params;
  }

  /** 把报文发到实际通道；不同平台对参数类型要求不同 */
  function dispatch(envelope) {
    var d = detect();
    var text = JSON.stringify(envelope);
    try {
      if (d.platform === 'ios') {
        // WKWebView 支持直接传 NSDictionary，不必转成字符串
        d.handler[d.method](envelope);
      } else if (d.platform === 'android') {
        // @JavascriptInterface 只接受基本类型，统一传 JSON 字符串
        d.handler[d.method](text);
      } else if (d.platform === 'react-native') {
        d.handler[d.method](text);
      } else {
        // 纯浏览器：交给本地 mock，或立即回一个明确的 mock 响应
        log('web mock ->', envelope.method);
        if (typeof mockHandler === 'function') {
          mockHandler(envelope, function (data, error) {
            _receive({ v: PROTOCOL, type: 'res', id: envelope.id, ok: !error, data: data, error: error });
          });
        } else {
          _receive({
            v: PROTOCOL, type: 'res', id: envelope.id, ok: true,
            data: { __mock: true, method: envelope.method, params: envelope.params }
          });
        }
      }
      return true;
    } catch (e) {
      warn('dispatch failed', e);
      return false;
    }
  }

  /* ============ 7. JS → Native：call() ============
   * 返回 Promise；原生需在超时前调用 NativeBridge._receive 回 type:'res'。
   */
  function call(method, params, timeout) {
    return new Promise(function (resolve, reject) {
      var envelope;
      try {
        assertMethod(method);
        envelope = {
          v: PROTOCOL,
          id: nextId(),
          type: 'req',
          method: method,
          params: serializeParams(params),
          ts: Date.now()
        };
      } catch (e) { reject(e); return; }

      if (pending.size >= MAX_PENDING) {
        reject(new BridgeError('E_BUSY', '未完成请求过多，请稍后重试'));
        return;
      }

      var ms = (typeof timeout === 'number' && timeout > 0) ? timeout : cfg.timeout;
      var timer = setTimeout(function () {
        pending.delete(envelope.id);
        log('timeout', envelope.method, envelope.id);
        reject(new BridgeError('E_TIMEOUT', '原生响应超时: ' + method, envelope.id));
      }, ms);

      pending.set(envelope.id, { resolve: resolve, reject: reject, timer: timer, method: method });
      log('call ->', method, envelope.id, envelope.params);

      if (!dispatch(envelope)) {
        clearTimeout(timer);
        pending.delete(envelope.id);
        reject(new BridgeError('E_CHANNEL', '通道不可用: ' + method));
      }
    });
  }

  /** 只发不等响应（日志埋点等场景） */
  function notify(method, params) {
    try {
      assertMethod(method);
      var envelope = {
        v: PROTOCOL, id: nextId(), type: 'evt', event: 'js.notify',
        data: { method: method, params: serializeParams(params) }, ts: Date.now()
      };
      dispatch(envelope);
    } catch (e) { warn('notify failed', e); }
  }

  /* ============ 8. Native → JS：统一入口 _receive() ============
   * 原生侧唯一需要调用的 JS 方法。接受 JSON 字符串或对象，永不抛异常。
   *
   * 响应报文：{ v, type:'res', id, ok:true, data } 或 { ..., ok:false, error:{code,message} }
   * 事件报文：{ v, type:'evt', event:'wallet.changed', data:{...} }
   * 心跳报文：{ v, type:'ping', id }  → 自动回 pong
   */
  function _receive(raw) {
    var msg;
    try {
      msg = (typeof raw === 'string') ? JSON.parse(raw) : raw;
    } catch (e) {
      warn('invalid JSON from native', e);
      emit(EVENTS.BRIDGE_ERROR, { code: 'E_PARSE', message: '报文不是合法 JSON' });
      return false;
    }
    if (!msg || typeof msg !== 'object') {
      emit(EVENTS.BRIDGE_ERROR, { code: 'E_SHAPE', message: '报文不是对象' });
      return false;
    }
    if (msg.v && msg.v !== PROTOCOL) {
      emit(EVENTS.BRIDGE_WARN, { code: 'E_VERSION', message: '协议版本不一致', got: msg.v, expect: PROTOCOL });
    }

    try {
      switch (msg.type) {
        case 'res': {
          var id = String(msg.id || '');
          var p = pending.get(id);
          if (!p) { log('drop unknown response', id); return false; }
          pending.delete(id);
          clearTimeout(p.timer);
          if (msg.ok === false) {
            var err = msg.error || {};
            p.reject(new BridgeError(err.code || 'E_NATIVE', err.message || '原生返回失败', err.detail));
          } else {
            p.resolve(msg.data);
          }
          return true;
        }
        case 'evt': {
          var name = String(msg.event || '');
          if (!name) return false;
          log('event <-', name, msg.data);
          emit(name, msg.data);
          return true;
        }
        case 'ping': {
          // 心跳：直接回 pong，让原生确认 JS 侧仍存活
          dispatch({ v: PROTOCOL, id: msg.id || nextId(), type: 'pong', ts: Date.now() });
          return true;
        }
        case 'pong':
          return true;
        default:
          emit(EVENTS.BRIDGE_WARN, { code: 'E_TYPE', message: '未知报文类型: ' + msg.type });
          return false;
      }
    } catch (e) {
      // 关键：任何异常都吞掉，绝不让异常穿透到原生 evaluateJavascript 调用栈
      warn('receive handler error', e);
      emit(EVENTS.BRIDGE_ERROR, { code: 'E_HANDLER', message: String(e && e.message || e) });
      return false;
    }
  }

  /* ============ 9. 就绪握手 ============
   * 原生在 WebView 初始化完成后，应发 evt:'app.ready' 或响应 bridge.hello。
   * 纯浏览器环境立即 resolve，保证同一套代码能在浏览器里跑。
   */
  function ready(timeout) {
    var d = detect();
    if (d.platform === 'web') {
      log('ready (web mock)');
      return Promise.resolve(getEnv());
    }
    if (helloed) return Promise.resolve(getEnv());
    helloed = true;

    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        off(EVENTS.READY, onReady);
        reject(new BridgeError('E_READY', '原生握手超时'));
      }, (typeof timeout === 'number' && timeout > 0) ? timeout : cfg.timeout);

      function onReady(data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off(EVENTS.READY, onReady);
        log('ready (native)');
        resolve({ platform: d.platform, channel: d.channel, protocol: PROTOCOL, data: data });
      }

      on(EVENTS.READY, onReady);
      // 主动打一次招呼；原生回 res 或发 app.ready 事件都能完成握手
      call('bridge.hello', { protocol: PROTOCOL, version: VERSION, ua: (root.navigator && root.navigator.userAgent) || '' })
        .then(function (data) { onReady(data); })
        .catch(function () { /* 交给 app.ready 事件或外层超时处理 */ });
    });
  }

  /* ============ 10. 浏览器调试 mock ============
   * 注册一个本地处理器：(envelope, reply) => reply(data, error)
   * 便于在纯浏览器里模拟原生能力，完全不依赖网络。
   */
  function setMockHandler(fn) {
    mockHandler = (typeof fn === 'function') ? fn : null;
    return api;
  }

  /* ============ 11. 老虎机业务封装（只处理虚拟币） ============
   * 约定：所有金额字段单位都是 CREDITS（玩币），playMoney 恒为 true。
   * 严禁在此层传入真实货币、订单号、支付凭证或用户身份信息。
   */
  var Slots = {
    EVENTS: EVENTS,

    /** 读取玩币余额 -> { balance:number, currency:'CREDITS' } */
    getBalance: function () {
      return call('wallet.balance', { currency: 'CREDITS' });
    },

    /** 请求一次旋转。bet 必须是有限正数；随机源由谁产生由原生配置决定 */
    requestSpin: function (params) {
      params = params || {};
      var bet = Number(params.bet);
      if (!isFinite(bet) || bet <= 0) {
        return Promise.reject(new BridgeError('E_BET', '下注额必须是正数（虚拟币）'));
      }
      return call('game.spin', {
        bet: bet,
        lines: params.lines || 1,
        currency: 'CREDITS',
        playMoney: true,                        // 合规标记：仅玩币
        clientTs: Date.now()
      });
    },

    /** 上报一局结果（埋点 / 对账），同样只含玩币 */
    reportSpinResult: function (result) {
      return call('game.result', {
        spinId: result.spinId || '',
        reels: Array.isArray(result.reels) ? result.reels.slice(0, 5) : [],
        win: Number(result.win) || 0,
        bet: Number(result.bet) || 0,
        currency: 'CREDITS',
        playMoney: true
      });
    },

    /** 请求震动反馈；失败不应影响游戏，故吞掉错误 */
    haptic: function (type) {
      return call('device.haptic', { type: type || 'light' }).catch(function () {});
    },

    /** 通知原生游戏状态变化 */
    setGameState: function (stateName) {
      return notify('game.state', { state: stateName, ts: Date.now() });
    },

    /** 请求原生关闭 WebView / 返回大厅 */
    close: function () { return call('app.close', {}).catch(function () {}); },

    /** 下行事件快捷订阅 */
    onBalanceChanged: function (fn) { return on(EVENTS.WALLET_CHANGED, fn); },
    onAppState:       function (fn) { return on(EVENTS.STATE, fn); },
    onPause:          function (fn) { return on(EVENTS.PAUSE, fn); },
    onResume:         function (fn) { return on(EVENTS.RESUME, fn); },
    onSpinResult:     function (fn) { return on(EVENTS.SPIN_RESULT, fn); }
  };

  /* ============ 12. 对外 API ============ */
  var api = {
    PROTOCOL: PROTOCOL,
    VERSION:  VERSION,
    BridgeError: BridgeError,

    configure: configure,
    getEnv: getEnv,
    isNative: function () { return detect().platform !== 'web'; },

    call: call,
    notify: notify,
    _receive: _receive,                          // 原生侧唯一入口（下划线表示内部约定）
    ready: ready,

    on: on, once: once, off: off, emit: emit,   // emit 主要供调试与本地模拟使用
    setMockHandler: setMockHandler,

    Slots: Slots
  };

  /* 暴露一个显式标记，方便原生检测桥接脚本是否已注入 */
  try { Object.defineProperty(api, 'loaded', { value: true, enumerable: false }); } catch (e) {}

  log('loaded', getEnv());
  return api;
});
