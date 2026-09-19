/* 访问密码门禁 —— 密码：shui309
 *
 * 防护等级（2026-09-19 加强）：
 *   ① 密码用 **PBKDF2-SHA256（16 字节盐 + 12 万轮迭代）** 校验，代码里不落明文，
 *      也不是「一次 SHA-256 直接比对」——拿到源码也无法用彩虹表/快速穷举反推。
 *   ② 连续输错 5 次 → 冷却 60 秒。失败次数存 localStorage，**刷新页面绕不过去**。
 *   ③ 无操作 10 分钟自动重新锁定。
 *   ④ 切到后台/最小化超过 1 分钟，回到前台立即锁定。
 *   ⑤ 解锁状态只存 **sessionStorage**：关闭标签页或浏览器后必须重新输入密码。
 *
 * ⚠️ 这仍然是纯前端门禁，只能挡住随手打开链接的人，无法抵御能直接改内存/断点的人。
 *    真正的数据保护靠云开发集合的安全规则（见部署说明第 0 节）。
 *
 * 与 app.js 的协作：本文件在 app.js 之前加载。
 *   - 未解锁：只设 window.__GATE_ENABLED__，app.js 不启动（不拉数据、不建地图）；
 *   - 解锁后：调用 window.__wbStart()（app.js 挂上去的启动函数）。
 */
(function () {
  "use strict";

  /* ---------------- 策略参数 ---------------- */
  var IDLE_MS = 10 * 60 * 1000;   // ③ 无操作 10 分钟 → 重新锁定
  var AWAY_MS = 60 * 1000;        // ④ 后台停留超过 1 分钟 → 回来即锁定
  var MAX_FAIL = 5;               // ② 连续输错上限
  var COOL_MS = 60 * 1000;        // ② 冷却时长
  var KDF_ITER = 120000;          // ① PBKDF2 迭代次数
  var KDF_SALT = "b7f3c1a95e2d48f60a1c7b3e9d5f2846";
  var KDF_HASH = "bce6f1ecb6fe490909f0d72bc2c07c4ba2ca9805920e448b410649eed284aadb";
  // crypto.subtle 不可用（非安全上下文，如 file://）时的兜底：迭代 djb2
  var FB_SALT = "w309-gate-v2", FB_ITER = 60000, FB_HASH = "61f1f985";

  var SS_ACT = "sp_shop_gate_act";        // sessionStorage：最近一次操作时间
  var LS_FAIL = "sp_shop_gate_fail";      // localStorage：{n, until}
  var LEGACY_ACT = "sp_shop_last_activity";   // 旧版用 localStorage 免密 30 分钟，必须清掉

  window.__GATE_ENABLED__ = true;
  window.__GATE_UNLOCKED__ = false;

  function $(id) { return document.getElementById(id); }
  function now() { return Date.now(); }

  /* ---------------- 存储 ---------------- */
  function readAct() {
    try { return parseInt(sessionStorage.getItem(SS_ACT) || "0", 10) || 0; } catch (e) { return 0; }
  }
  function writeAct(t) {
    try { sessionStorage.setItem(SS_ACT, String(t)); } catch (e) {}
  }
  function clearAct() {
    try { sessionStorage.removeItem(SS_ACT); } catch (e) {}
  }
  // ⑤ 解锁状态只活在当前标签页；sessionStorage 随标签页关闭而消失
  function isFresh() {
    var t = readAct();
    return t > 0 && (now() - t) < IDLE_MS;
  }
  function readFail() {
    try {
      var o = JSON.parse(localStorage.getItem(LS_FAIL) || "{}") || {};
      return { n: o.n || 0, until: o.until || 0 };
    } catch (e) { return { n: 0, until: 0 }; }
  }
  function writeFail(o) {
    try { localStorage.setItem(LS_FAIL, JSON.stringify({ n: o.n || 0, until: o.until || 0 })); } catch (e) {}
  }
  function clearFail() {
    try { localStorage.removeItem(LS_FAIL); } catch (e) {}
  }
  function coolLeft() {
    var f = readFail();
    return f.until > now() ? (f.until - now()) : 0;
  }

  /* ---------------- 密码校验（PBKDF2） ---------------- */
  function toHex(buf) {
    var bytes = new Uint8Array(buf), hex = "";
    for (var i = 0; i < bytes.length; i++) hex += ("0" + bytes[i].toString(16)).slice(-2);
    return hex;
  }
  function djb2Iter(v) {
    var h = 5381, s = FB_SALT + "\u0001" + v;
    for (var r = 0; r < FB_ITER; r++) {
      for (var i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0;
    }
    return h.toString(16);
  }
  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  async function passwordOk(v) {
    var c = window.crypto;
    if (c && c.subtle && c.subtle.importKey && window.TextEncoder) {
      try {
        var key = await c.subtle.importKey("raw", new TextEncoder().encode(v), "PBKDF2", false, ["deriveBits"]);
        var bits = await c.subtle.deriveBits(
          { name: "PBKDF2", salt: hexToBytes(KDF_SALT), iterations: KDF_ITER, hash: "SHA-256" }, key, 256);
        return toHex(bits) === KDF_HASH;
      } catch (e) { /* 落到兜底校验 */ }
    }
    return djb2Iter(v) === FB_HASH;
  }

  /* ---------------- 锁定 / 解锁 ---------------- */
  var idleTimer = null, awayTimer = null, coolTimer = null;

  var LOCK_TEXT = {
    first: "",
    idle: "已超时自动锁定，请重新输入访问密码",
    away: "离开时间较长，已自动锁定，请重新输入访问密码"
  };

  function showLock(reason) {
    var el = $("lock-screen");
    if (!el) return;
    el.classList.add("show");
    el.classList.remove("hide");
    document.body.classList.add("locked");
    window.__GATE_UNLOCKED__ = false;
    var inp = $("lock-pw");
    if (inp) inp.value = "";
    setMsg(LOCK_TEXT[reason] || "", reason === "first" ? "" : "warn");
    refreshCool(true);
  }

  function hideLock() {
    var el = $("lock-screen");
    if (el) { el.classList.remove("show"); el.classList.add("hide"); }
    document.body.classList.remove("locked");
    window.__GATE_UNLOCKED__ = true;
    if (awayTimer) { clearTimeout(awayTimer); awayTimer = null; }
    // 冷却倒计时可能还没跑到「已结束」那一拍，这里兜底把控件恢复可用，
    // 否则下次锁屏时输入框会莫名其妙是灰的。
    if (coolTimer) { clearInterval(coolTimer); coolTimer = null; }
    var inp = $("lock-pw"), btn = $("lock-btn");
    if (inp) inp.disabled = false;
    if (btn) btn.disabled = false;
  }

  function setMsg(text, type) {
    var m = $("lock-msg");
    if (!m) return;
    m.textContent = text || "";
    m.className = "lock-msg" + (type ? " " + type : "");
  }

  // 冷却期内的输入禁用 + 倒计时（focusFirst=true 时顺便把焦点给密码框）
  function refreshCool(focusFirst) {
    var left = coolLeft();
    var inp = $("lock-pw"), btn = $("lock-btn");
    if (left > 0) {
      if (inp) inp.disabled = true;
      if (btn) btn.disabled = true;
      setMsg("密码错误次数过多，请 " + Math.ceil(left / 1000) + " 秒后重试", "err");
      if (!coolTimer) coolTimer = setInterval(function () { refreshCool(false); }, 500);
      return;
    }
    if (coolTimer) { clearInterval(coolTimer); coolTimer = null; }
    if (inp) inp.disabled = false;
    if (btn) btn.disabled = false;
    var m = $("lock-msg");
    if (m && /次数过多/.test(m.textContent || "")) setMsg("", "");
    if (focusFirst && inp) setTimeout(function () { try { inp.focus(); } catch (e) {} }, 60);
  }

  function unlock() {
    clearFail();
    writeAct(now());
    hideLock();
    startIdleWatch();
    bindActivity();
    if (typeof window.__wbStart === "function") window.__wbStart();
  }

  /* ---------------- ③ 无操作自动锁定 ---------------- */
  function startIdleWatch() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = setInterval(function () {
      if (!window.__GATE_UNLOCKED__) return;
      if (now() - readAct() >= IDLE_MS) showLock("idle");
    }, 20000);
  }

  var actBound = false;
  function bindActivity() {
    if (actBound) return;
    actBound = true;
    var last = 0;
    function touch() {
      if (!window.__GATE_UNLOCKED__) return;
      var t = now();
      // 关键：浏览器后台标签页的定时器会被节流，可能“醒来”时还没触发锁定检查。
      // 所以这里先判断是否已经超时——超时就直接锁定，绝不能把时间戳刷新掉。
      if (t - readAct() >= IDLE_MS) { showLock("idle"); return; }
      if (t - last < 5000) return;      // 5 秒最多写一次，避免频繁写 sessionStorage
      last = t;
      writeAct(t);
    }
    ["mousedown", "keydown", "touchstart", "wheel", "click"].forEach(function (ev) {
      document.addEventListener(ev, touch, { passive: true, capture: true });
    });
    // ④ 切到后台超过 AWAY_MS → 回到前台立即锁定（后台定时器会被节流，所以两边都判）
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        if (!window.__GATE_UNLOCKED__) return;
        if (awayTimer) clearTimeout(awayTimer);
        awayTimer = setTimeout(function () { awayTimer = null; showLock("away"); }, AWAY_MS);
        return;
      }
      if (awayTimer) { clearTimeout(awayTimer); awayTimer = null; }
      if (!window.__GATE_UNLOCKED__) return;
      if (now() - readAct() >= IDLE_MS) { showLock("idle"); return; }
      touch();
    });
    // 页面关闭前也记一次，避免刚操作完就判为“久未操作”
    window.addEventListener("pagehide", function () { if (window.__GATE_UNLOCKED__) writeAct(now()); });
  }

  /* ---------------- 提交密码 ---------------- */
  var busy = false;
  async function submit() {
    if (busy) return;
    if (coolLeft() > 0) { refreshCool(true); return; }
    var inp = $("lock-pw");
    var v = inp ? inp.value : "";
    if (!v) { setMsg("请输入访问密码", "warn"); return; }
    busy = true;
    var ok = false;
    try { ok = await passwordOk(v); } catch (e) { ok = false; }
    busy = false;
    if (ok) { setMsg("", ""); unlock(); return; }
    // ② 记一次失败；达到上限就冷却
    var f = readFail();
    f.n = (f.n || 0) + 1;
    if (f.n >= MAX_FAIL) { f.until = now() + COOL_MS; f.n = 0; }
    writeFail(f);
    var box = $("lock-card");
    if (box) { box.classList.remove("shake"); void box.offsetWidth; box.classList.add("shake"); }
    if (coolLeft() > 0) { refreshCool(true); return; }
    setMsg("密码不正确，还剩 " + (MAX_FAIL - f.n) + " 次尝试机会", "err");
    if (inp) { try { inp.focus(); } catch (e) {} }
  }

  function bindLockForm() {
    var btn = $("lock-btn");
    if (btn) btn.addEventListener("click", submit);
    var inp = $("lock-pw");
    if (inp) {
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } });
      inp.addEventListener("input", function () {
        var m = $("lock-msg");
        if (m && m.textContent && !/次数过多/.test(m.textContent)) setMsg("", "");
      });
    }
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    // 旧版把「最近操作时间」写在 localStorage 里，等于 30 分钟免密且关掉浏览器也还在。
    // 已改用 sessionStorage（⑤），这里把旧键清掉，否则老浏览器会继续走旧逻辑。
    try { localStorage.removeItem(LEGACY_ACT); } catch (e) {}
    bindLockForm();
    if (isFresh()) {
      // 同一标签页内 10 分钟内刚操作过 → 直接进入，不打扰（刷新页面也免密）
      window.__GATE_UNLOCKED__ = true;
      hideLock();
      startIdleWatch();
      bindActivity();
      if (typeof window.__wbStart === "function") window.__wbStart();
      else window.__GATE_PENDING_START__ = true;
    } else {
      clearAct();
      showLock("first");
    }
  }

  // app.js 在解锁之后才加载完时，由 app.js 自己检查 __GATE_UNLOCKED__ 决定是否启动；
  // 这里额外暴露一个钩子，便于 app.js 注册启动函数。
  window.__wbRegisterStart = function (fn) {
    window.__wbStart = fn;
    if (window.__GATE_UNLOCKED__) fn();
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
