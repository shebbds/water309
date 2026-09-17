/* 访问密码门禁 —— 密码：shui309
 * 规则：首次访问需输入密码；解锁后 30 分钟内无任何操作会自动重新锁定。
 *
 * 说明：这是纯前端门禁，只能挡住随手打开链接的人，无法抵御懂技术的人查看源码。
 *      密码本身不以明文保存在代码里（存 SHA-256；非安全上下文时退化为 djb2 校验）。
 *
 * 与 app.js 的协作：本文件在 app.js 之前加载。
 *   - 未解锁：只设 window.__GATE_ENABLED__，app.js 不启动（不拉数据、不建地图）；
 *   - 解锁后：调用 window.__wbStart()（app.js 挂上去的启动函数）。
 */
(function () {
  "use strict";

  var IDLE_MS = 30 * 60 * 1000;          // 30 分钟无操作 → 重新锁定
  var LS_ACT = "sp_shop_last_activity";  // 最近一次操作时间（毫秒时间戳）
  var PW_SHA256 = "7ab2e14cc1575f08d0063bbbdea4a745fc2d1e85d7b9d24baae927d6cde6c6ba";
  var PW_DJB2 = "93410f9a";              // crypto.subtle 不可用时的兜底校验

  window.__GATE_ENABLED__ = true;
  window.__GATE_UNLOCKED__ = false;

  function $(id) { return document.getElementById(id); }
  function now() { return Date.now(); }

  function readAct() {
    try { return parseInt(localStorage.getItem(LS_ACT) || "0", 10) || 0; } catch (e) { return 0; }
  }
  function writeAct(t) {
    try { localStorage.setItem(LS_ACT, String(t)); } catch (e) {}
  }
  function isFresh() {
    var t = readAct();
    return t > 0 && (now() - t) < IDLE_MS;
  }

  function djb2(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }

  async function passwordOk(v) {
    var c = window.crypto;
    if (c && c.subtle && c.subtle.digest && window.TextEncoder) {
      try {
        var buf = await c.subtle.digest("SHA-256", new TextEncoder().encode(v));
        var bytes = new Uint8Array(buf), hex = "";
        for (var i = 0; i < bytes.length; i++) hex += ("0" + bytes[i].toString(16)).slice(-2);
        return hex === PW_SHA256;
      } catch (e) { /* 落到兜底校验 */ }
    }
    return djb2(v) === PW_DJB2;
  }

  /* ---------------- 锁定 / 解锁 ---------------- */
  var idleTimer = null, ticking = false;

  function showLock(reason) {
    var el = $("lock-screen");
    if (!el) return;
    el.classList.add("show");
    el.classList.remove("hide");
    document.body.classList.add("locked");
    var inp = $("lock-pw");
    if (inp) { inp.value = ""; setTimeout(function () { try { inp.focus(); } catch (e) {} }, 60); }
    setMsg(reason === "idle" ? "已超过 30 分钟未操作，请重新输入访问密码" : "", reason === "idle" ? "warn" : "");
    window.__GATE_UNLOCKED__ = false;
  }

  function hideLock() {
    var el = $("lock-screen");
    if (el) { el.classList.remove("show"); el.classList.add("hide"); }
    document.body.classList.remove("locked");
    window.__GATE_UNLOCKED__ = true;
  }

  function setMsg(text, type) {
    var m = $("lock-msg");
    if (!m) return;
    m.textContent = text || "";
    m.className = "lock-msg" + (type ? " " + type : "");
  }

  function unlock() {
    writeAct(now());
    hideLock();
    startIdleWatch();
    bindActivity();
    if (typeof window.__wbStart === "function") window.__wbStart();
  }

  /* ---------------- 无操作自动锁定 ---------------- */
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
      if (t - last < 5000) return;      // 5 秒最多写一次，避免频繁写 localStorage
      last = t;
      writeAct(t);
    }
    ["mousedown", "keydown", "touchstart", "wheel", "click"].forEach(function (ev) {
      document.addEventListener(ev, touch, { passive: true, capture: true });
    });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) return;
      touch();
      if (!window.__GATE_UNLOCKED__) return;
      if (now() - readAct() >= IDLE_MS) showLock("idle");
    });
    // 页面关闭前也记一次，避免刚操作完就判为“久未操作”
    window.addEventListener("pagehide", function () { if (window.__GATE_UNLOCKED__) writeAct(now()); });
  }

  /* ---------------- 提交密码 ---------------- */
  var busy = false;
  async function submit() {
    if (busy) return;
    var inp = $("lock-pw");
    var v = inp ? inp.value : "";
    if (!v) { setMsg("请输入访问密码", "warn"); return; }
    busy = true;
    var ok = false;
    try { ok = await passwordOk(v); } catch (e) { ok = false; }
    busy = false;
    if (ok) { setMsg("", ""); unlock(); return; }
    setMsg("密码不正确，请重试", "err");
    var box = $("lock-card");
    if (box) {
      box.classList.remove("shake");
      void box.offsetWidth;
      box.classList.add("shake");
    }
    if (inp) { inp.select(); }
  }

  function bindLockForm() {
    var btn = $("lock-btn");
    if (btn) btn.addEventListener("click", submit);
    var inp = $("lock-pw");
    if (inp) {
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } });
      inp.addEventListener("input", function () { if ($("lock-msg").textContent) setMsg("", ""); });
    }
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    bindLockForm();
    if (isFresh()) {
      // 30 分钟内刚操作过 → 直接进入，不打扰
      window.__GATE_UNLOCKED__ = true;
      hideLock();
      startIdleWatch();
      bindActivity();
      if (typeof window.__wbStart === "function") window.__wbStart();
      else window.__GATE_PENDING_START__ = true;
    } else {
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
