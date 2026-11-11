# NativeBridge — 协议与原生接入约定

面向 **H5 老虎机（Lucky Loop / Reel Breaker）** 的 WebView ↔ 原生双向通信桥。
JS 侧实现见 [`NativeBridge.js`](./NativeBridge.js)；单文件游戏见
[`../lucky-reels-breaker.html`](../lucky-reels-breaker.html)。

> **合规前提**：整个链路只传 `CREDITS`（玩币），`playMoney` 恒为 `true`。
> 禁止传真实货币金额、订单号、支付凭证、身份证号等敏感信息。
> 页面明确标注 18+ / Play money only。

---

## 1. 报文协议（`lucky-loop/1`）

所有报文是 JSON 对象，字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `v` | string | 协议版本，固定 `lucky-loop/1` |
| `id` | string | 消息唯一 id；`res` 必须原样带回 `req.id` |
| `type` | string | `req` / `res` / `evt` / `ping` / `pong` |
| `method` | string | 仅 `req`；点式命名，如 `game.spin` |
| `params` | object | 仅 `req`；必须可 JSON 序列化 |
| `event` | string | 仅 `evt`；事件名，见下表 |
| `data` | any | `res` / `evt` 的载荷 |
| `ok` | bool | 仅 `res`；`false` 时读 `error` |
| `error` | object | 仅 `res` 失败；`{ code, message, detail }` |
| `ts` | number | 毫秒时间戳 |

### JS → Native（`req`）

```json
{
  "v": "lucky-loop/1",
  "id": "js-m1x2y3-1",
  "type": "req",
  "method": "game.spin",
  "params": { "bet": 5, "lines": 1, "currency": "CREDITS", "playMoney": true, "clientTs": 1794420000000 },
  "ts": 1794420000000
}
```

### Native → JS（`res`）

成功：

```json
{ "v":"lucky-loop/1", "id":"js-m1x2y3-1", "type":"res", "ok":true,
  "data": { "reels":["cherry","star","clover"], "win":0, "balance":995 } }
```

失败：

```json
{ "v":"lucky-loop/1", "id":"js-m1x2y3-1", "type":"res", "ok":false,
  "error": { "code":"E_NO_CREDITS", "message":"玩币不足" } }
```

原生侧调用方式（**唯一入口**）：

```text
NativeBridge._receive('<上面的 JSON 字符串>')
```

`_receive` 同时接受字符串与对象；内部全程 try/catch，任何异常都不会回抛到
`evaluateJavascript` 调用栈。

### Native → JS（`evt`，主动推送）

```json
{ "v":"lucky-loop/1", "type":"evt", "event":"wallet.changed",
  "data": { "balance": 995, "currency": "CREDITS" } }
```

| 事件名 | 常量 | 载荷 | 用途 |
| --- | --- | --- | --- |
| `app.ready` | `EVENTS.READY` | `{ config? }` | 原生初始化完成，完成握手 |
| `app.state` | `EVENTS.STATE` | `{ state:"active"\|"background" }` | 前后台切换，游戏自动暂停 |
| `game.pause` | `EVENTS.PAUSE` | `{}` | 原生强制暂停 |
| `game.resume` | `EVENTS.RESUME` | `{}` | 恢复 |
| `wallet.changed` | `EVENTS.WALLET_CHANGED` | `{ balance, currency }` | 玩币余额变化 |
| `config.changed` | `EVENTS.CONFIG_CHANGED` | `{ ... }` | 远程配置更新 |
| `game.spinResult` | `EVENTS.SPIN_RESULT` | `{ spinId, reels, win }` | 若 RNG 在原生侧执行 |

### 心跳

原生发 `{ "v":"lucky-loop/1","type":"ping","id":"..." }`，JS 自动回 `pong`，
可用于检测页面是否存活 / 是否被系统回收。

---

## 2. 通道与注入

| 平台 | JS 发送通道 | 默认名称 |
| --- | --- | --- |
| iOS WKWebView | `window.webkit.messageHandlers.<name>.postMessage(object)` | `luckyLoopBridge` |
| Android | `window.<Interface>.<method>(jsonString)` | `LuckyLoopBridge.postMessage` |
| React Native WebView | `window.ReactNativeWebView.postMessage(jsonString)` | 内置 |
| 浏览器 / 调试 | 本地 mock（无网络请求） | — |

探测顺序：**RN → iOS → Android → Web**。可用
`NativeBridge.configure({ iosHandler, androidInterface, androidMethod })` 覆盖名称。

---

## 3. iOS 接入（Swift / WKWebView）

```swift
import WebKit

final class GameViewController: UIViewController, WKScriptMessageHandler {

    private var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        let content = WKUserContentController()
        // 名称必须与 JS 侧 cfg.iosHandler 一致
        content.add(self, name: "luckyLoopBridge")

        let config = WKWebViewConfiguration()
        config.userContentController = content
        // 只加载本地/受信任域名；不要开启任意 file:// 访问
        config.preferences.javaScriptEnabled = true

        webView = WKWebView(frame: view.bounds, configuration: config)
        view.addSubview(webView)

        if let url = Bundle.main.url(forResource: "lucky-reels-breaker",
                                    withExtension: "html") {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
    }

    // JS → Native
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "luckyLoopBridge",
              let body = message.body as? [String: Any],
              body["v"] as? String == "lucky-loop/1",
              body["type"] as? String == "req",
              let id = body["id"] as? String,
              let method = body["method"] as? String else { return }

        let params = body["params"] as? [String: Any] ?? [:]

        switch method {
        case "bridge.hello":
            reply(id: id, data: ["platform": "ios", "protocol": "lucky-loop/1"])
        case "wallet.balance":
            reply(id: id, data: ["balance": 1000, "currency": "CREDITS"])
        case "game.spin":
            // 虚拟币校验；RNG 建议放在客户端或经签名校验的服务端
            let bet = params["bet"] as? Int ?? 0
            guard bet > 0, params["playMoney"] as? Bool == true else {
                replyError(id: id, code: "E_BET", message: "无效下注")
                return
            }
            reply(id: id, data: ["reels": ["cherry", "star", "clover"],
                                 "win": 0, "balance": 1000 - bet])
        case "device.haptic":
            reply(id: id, data: [:])
        default:
            replyError(id: id, code: "E_METHOD", message: "不支持的方法")
        }
    }

    // Native → JS：统一走 _receive
    private func send(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let json = String(data: data, encoding: .utf8) else { return }
        let js = "NativeBridge._receive(\(json.debugDescription));"
        DispatchQueue.main.async { self.webView.evaluateJavaScript(js, completionHandler: nil) }
    }

    private func reply(id: String, data: [String: Any]) {
        send(["v": "lucky-loop/1", "id": id, "type": "res", "ok": true, "data": data])
    }

    private func replyError(id: String, code: String, message: String) {
        send(["v": "lucky-loop/1", "id": id, "type": "res", "ok": false,
              "error": ["code": code, "message": message]])
    }

    deinit { webView.configuration.userContentController.removeScriptMessageHandler(forName: "luckyLoopBridge") }
}
```

> 注意：`json.debugDescription` 只做字符串转义演示；生产环境请用严格的
> JSON 字符串转义（把 `"`、`\`、`\n`、`\u2028` 等处理干净）后再拼接，
> 或改为 `evaluateJavaScript("NativeBridge._receive(%@)", ...)` 传参形式，
> 避免拼接注入。

---

## 4. Android 接入（Kotlin）

```kotlin
class GameActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // 仅允许加载受信任来源；Android 4.2 以下禁止 addJavascriptInterface
            addJavascriptInterface(Bridge(), "LuckyLoopBridge")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                    return !req.url.host.equals("trusted.example.com", ignoreCase = true)
                }
            }
        }
        setContentView(webView)
        webView.loadUrl("file:///android_asset/lucky-reels-breaker.html")
    }

    private inner class Bridge {
        @JavascriptInterface
        fun postMessage(json: String) {
            // @JavascriptInterface 运行在专用线程，切回主线程操作 WebView
            runOnUiThread { handle(json) }
        }
    }

    private fun handle(json: String) {
        val msg = JSONObject(json)
        if (msg.optString("v") != "lucky-loop/1") return
        if (msg.optString("type") != "req") return
        val id = msg.optString("id")
        val params = msg.optJSONObject("params") ?: JSONObject()

        when (msg.optString("method")) {
            "bridge.hello" -> reply(id, JSONObject().put("platform", "android"))
            "wallet.balance" -> reply(id, JSONObject()
                .put("balance", 1000).put("currency", "CREDITS"))
            "game.spin" -> {
                val bet = params.optInt("bet", 0)
                if (bet <= 0 || params.optBoolean("playMoney") != true) {
                    replyError(id, "E_BET", "无效下注")
                } else {
                    reply(id, JSONObject().put("balance", 1000 - bet)
                        .put("reels", JSONArray().put("cherry").put("star").put("clover"))
                        .put("win", 0))
                }
            }
            "device.haptic" -> reply(id, JSONObject())
            else -> replyError(id, "E_METHOD", "不支持的方法")
        }
    }

    private fun send(obj: JSONObject) {
        // JSONObject.toString() 已做 JSON 转义；再包一层 JS 字符串字面量
        val literal = JSONObject.quote(obj.toString())
        webView.evaluateJavascript("NativeBridge._receive($literal);", null)
    }

    private fun reply(id: String, data: JSONObject) = send(JSONObject()
        .put("v", "lucky-loop/1").put("id", id)
        .put("type", "res").put("ok", true).put("data", data))

    private fun replyError(id: String, code: String, message: String) = send(JSONObject()
        .put("v", "lucky-loop/1").put("id", id)
        .put("type", "res").put("ok", false)
        .put("error", JSONObject().put("code", code).put("message", message)))
}
```

---

## 5. 与单文件游戏集成

`lucky-reels-breaker.html` **刻意保持零外部依赖**（任务要求单文件）。
仓库已提供构建脚本自动生成集成版，产物仍是 100% 单文件、零外部依赖：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File h5/build-hybrid.ps1
# -> h5/dist/lucky-reels-breaker.hybrid.html
```

脚本把 `NativeBridge.js` 全文与 [`hybrid-glue.js`](./hybrid-glue.js) 内联进游戏，
并做产物自检（外部依赖为 0、钩子齐全）。下面的手写示例等价于胶水层的逻辑，
仅在不想跑构建脚本时参考：

```html
<script>
/* ===== 内联 NativeBridge.js 全文 ===== */
</script>
<script>
  // 1) 配置 + 握手
  NativeBridge.configure({ debug: false, whitelist: [
    'bridge.hello', 'wallet.balance', 'game.spin', 'game.result',
    'game.state', 'device.haptic', 'app.close'
  ]});

  NativeBridge.ready().then(function () {
    NativeBridge.Slots.getBalance().then(function (w) {
      // 与游戏内 credits 对账（仅玩币）
      console.log('CREDITS', w.balance);
    });
  }).catch(function (e) {
    console.warn('原生桥不可用，降级为纯 H5 本地模式', e.code);
  });

  // 2) 下行事件 → 游戏状态
  NativeBridge.Slots.onPause(function () { if (typeof togglePause === 'function') togglePause(); });
  NativeBridge.Slots.onAppState(function (d) {
    if (d.state === 'background' && typeof togglePause === 'function') togglePause();
  });

  // 3) 上行：例如免费旋转结果上报（只含玩币）
  // NativeBridge.Slots.reportSpinResult({ spinId:'...', reels:[...], win:500, bet:5 });
</script>
```

纯浏览器打开时 `NativeBridge.isNative() === false`，`call()` 会返回
`{ __mock: true, ... }`，游戏完全不受影响；也可用
`NativeBridge.setMockHandler(fn)` 模拟原生回包做联调。

---

## 6. 安全检查清单

- [ ] **来源白名单**：WKWebView 限制 `navigationAction` 域名；Android 覆写
      `shouldOverrideUrlLoading`，禁止跳转到任意外部页面。
- [ ] **注入面收敛**：Android 4.2 以下禁用 `addJavascriptInterface`；
      iOS 在 `deinit` 里 `removeScriptMessageHandler`，避免循环引用与内存泄漏。
- [ ] **方法白名单**：JS 侧 `configure({ whitelist: [...] })`，原生侧同样只实现白名单方法。
- [ ] **转义**：所有 `evaluateJavascript` 参数必须做 JSON 字符串转义，禁止裸字符串拼接。
- [ ] **不信任入参**：`_receive` 已对 JS 侧做解析/结构校验；原生侧同样校验 `v`、`type`、`method`。
- [ ] **合规**：仅玩币；不采集设备指纹、通讯录、位置；不传真实货币或支付信息。
- [ ] **超时与清理**：JS 侧 `call()` 默认 8s 超时，`pending` 上限 200；
      原生侧收到 `pong` 可判定页面存活。
- [ ] **RNG 公平性**：若开奖结果由原生下发，需保证可验证、不可被客户端篡改，
      且与页面公示的 RTP/赔率一致；否则建议完全在客户端本地生成并上报结果供审计。
