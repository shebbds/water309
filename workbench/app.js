/* 二次供水309 — 应用逻辑
 * 数据源：window.SEED_DATA（默认空）+ 本地 localStorage + 腾讯云 CloudBase 云集合
 * 访问密码门禁由 gate.js 负责，解锁后才调用本文件的 init()。
 */
(function(){
  "use strict";

  // 键名升版（v2）：2026-09-17 首次灌入 791 条真实底档（seed.js），
  // 必须升版才能让「已经打开过 v1 页面」的浏览器重新走一次种子载入流程；
  // 升版同时意味着 v1 的本地缓存作废（当时只有测试数据，无损失）。
  var LS_DATA = "sp_shop_data_v2";
  var LS_SYNCED = "sp_shop_synced_v2";
  var LS_DIRTY = "sp_shop_dirty_v1";
  var LS_SETTINGS = "sp_shop_settings_v1";
  var LEGACY_KEYS = ["hp_workbench_data_v2", "hp_workbench_synced_v2", "hp_workbench_settings",
                     "sp_shop_data_v1", "sp_shop_synced_v1"];

  // 内置默认配置（开箱即用；如需清除请在「设置界面」留空并保存）
  var DEFAULT_SETTINGS = {
    amapKey:"d18a8dd2e58b05ab460f0eaa71eee15e",
    amapSecurity:"348b837bda1afacb88187f829ccf52d3",
    cbEnv:"water309-d8g1c3uy074511212",  // 腾讯云开发环境 ID
    cbRegion:"ap-shanghai",  // 地域，必须与环境所在地域一致
    cbAccessKey:"",          // Publishable Key（可选）
    cbCollection:"units",    // 集合名
    realtime:true            // 多设备实时同步（数据库实时推送）
  };

  // 内置配置版本号：**每次改动 DEFAULT_SETTINGS 里的高德 Key/密钥就要 +1**。
  // 原因：首次运行会把内置值固化进 localStorage，之后 loadSettings 让本地值优先，
  // 于是「换了内置 Key，老用户的浏览器还在用旧 Key」——表现为地图一直空白。
  // 升版后，amapKey / amapSecurity 强制以内置值为准（其余配置如云环境 ID 仍保留用户的）。
  var SETTINGS_REV = 2;

  var state = {
    data: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    view: "home",
    homeWindow: 30,
    selected: {},          // uid -> true
    synced: {},           // cloudKey -> true：已知存在于云端的记录（用于区分“本地新增”与“别处已删除”）
    dirty: {},            // cloudKey -> true：本地改过但【没成功上传】的记录（详见 syncNow 的说明）
    /* rev：本地修订号，只增不减。任何「本地数据被用户改动」都 +1。
     * 用途：见 pullCloud 的「快照过期即丢弃」——云端拉取是「先读快照、后合并」，
     * 读与合并之间有网络等待；如果这段等待里用户改了数据，那份快照就是过期的，
     * 合并回去会把用户的改动静默抹掉（实测过的真实故障）。 */
    rev: 0,
    amap: null,
    geocoder: null,
    amapReady: false,
    markers: {},           // uid -> AMap.Marker
    pickMode: false,        // 地图手动选点模式
    pickTarget: null,       // 选点目标单位 uid
    searchActive: false,    // 是否处于搜索高亮状态
    searchMatches: {},      // uid -> true（搜索命中集合）
    searchJustRan: false,   // 本次搜索刚触发（用于播放一次跳动）
    mapQuery: "",           // 地图当前搜索词
    ledgerQuery: "",        // 台账搜索词
    overdueQuery: "",       // 首页「已过期单位」区块的搜索词
    unlocQuery: "",         // 地图「未编码单位」面板的筛选词
    targetUid: null,        // 地图当前选中的目标单位（红色高亮 + 周边单位锚点）
    targetCircles: [],      // 当前距离圆（AMap.Circle，只保留“选定/自定义”那一个）引用，便于清理
    targetRadius: 200,      // 当前“周围单位”半径（米）
    _clickTimer: null,      // 标记单击延时器（用于区分单击 / 双击）
    _lastClickUid: null,    // 上一次点击的标记 uid（双击判定）
    _lastClickTs: 0,        // 上一次点击时间戳
    _markerClickTs: 0,      // 标记点击时间戳（防地图冒泡误清空）
    _detailOpenTs: 0,       // 详情弹窗最近打开时间（防多条事件路径重复弹窗）
    _nbTimer: null,         // 周围单位列表单击延时器（区分单击 / 双击）
    _nbUid: null,           // 上一次点击的周围单位 uid
    _nbTs: 0,               // 上一次点击时间戳
    _nbDblTs: 0,            // 最近一次双击触发时间（防 click+dblclick 双路径重复切换）
    _flashTimer: null       // 橙色跳动复位计时器
  };

  /* ---------------- 工具函数 ---------------- */
  function uid(){ return "u" + Math.random().toString(36).slice(2,9) + Date.now().toString(36); }
  function $(id){ return document.getElementById(id); }
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]; }); }

  function iso(d){
    return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
  }
  function parseDate(s){
    if(!s) return null;
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m) return null;
    return new Date(+m[1], +m[2]-1, +m[3]);
  }
  // 有效期止 = 所选日期 + 4 年 - 1 天
  function calcValidTo(fromStr){
    var d = parseDate(fromStr);
    if(!d) return "";
    var nd = new Date(d.getFullYear()+4, d.getMonth(), d.getDate());
    nd.setDate(nd.getDate()-1);
    return iso(nd);
  }
  function daysUntil(s){
    var d = parseDate(s);
    if(!d) return null;
    var t = new Date(); t.setHours(0,0,0,0);
    return Math.round((d - t) / 86400000);
  }
  function normDateStr(v){
    v = String(v==null?"":v).trim();
    if(!v) return "";
    var m = v.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
    if(m) return iso(new Date(+m[1], +m[2]-1, +m[3]));
    return v;
  }
  function normExcelDate(v){
    if(v==null || v==="") return "";
    if(v instanceof Date) return iso(v);
    if(typeof v === "number"){
      // Excel 序列号（1900 日期系统）
      var d = new Date((v - 25569) * 86400000);
      return isNaN(d) ? "" : iso(d);
    }
    return normDateStr(v);
  }
  function nextId(){
    var max = 0;
    state.data.forEach(function(r){
      var n = parseInt(r.id, 10);
      if(!isNaN(n) && n > max) max = n;
    });
    return String(max + 1);
  }
  function coordText(r){
    return (r.lng!=null && r.lat!=null) ? (r.lng.toFixed(5)+", "+r.lat.toFixed(5)) : "未编码";
  }

  /* ---------------- 持久化 ---------------- */
  // 清掉旧版本（Supabase 时代）留下的本地缓存与配置：实现“现有单位数据全部清除”
  function purgeLegacy(){
    try{
      LEGACY_KEYS.forEach(function(k){ localStorage.removeItem(k); });
    }catch(e){}
  }
  function loadSettings(){
    // 内置默认（含密钥）作为基础值，仅当用户在某字段填了非空值时才覆盖；
    // 空值不再清空密钥，避免“先存了部分配置”导致后续密钥无法生效。
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
    try{
      var raw = localStorage.getItem(LS_SETTINGS);
      if(raw){
        var parsed = JSON.parse(raw);
        // 内置 rev 变过 → 说明换过高德 Key，此时密钥一律以内置值为准，
        // 否则老浏览器里固化的旧 Key 会一直盖住新值（地图空白且难排查）。
        var revOk = (parsed.__rev === SETTINGS_REV);
        Object.keys(parsed).forEach(function(k){
          if(k === "__rev") return;
          if(parsed[k] === undefined || parsed[k] === "") return;
          if(!revOk && (k === "amapKey" || k === "amapSecurity")) return;
          state.settings[k] = parsed[k];
        });
      } else {
        // 首次运行：把内置默认（含密钥）固化到本地，真正“配置进去”
        saveSettingsLocal();
      }
    }catch(e){}
  }
  function saveSettingsLocal(){
    localStorage.setItem(LS_SETTINGS, JSON.stringify(
      Object.assign({}, state.settings, { __rev: SETTINGS_REV })
    ));
  }
  function loadData(){
    var raw = localStorage.getItem(LS_DATA);
    if(raw){
      try{ state.data = JSON.parse(raw); }catch(e){ state.data = []; }
    }
    try{ var s = localStorage.getItem(LS_SYNCED); state.synced = s ? JSON.parse(s) : {}; }catch(e){ state.synced = {}; }
    try{ var dd = localStorage.getItem(LS_DIRTY); state.dirty = dd ? JSON.parse(dd) : {}; }catch(e){ state.dirty = {}; }
    // 仅在【首次安装、从未保存过】（LS_DATA 键不存在）时才载入种子数据；
    // 用户主动删空（LS_DATA = "[]"）时绝不能重置，否则永远删不干净。
    if(!raw){
      state.data = (window.SEED_DATA||[]).map(function(r){
        return Object.assign({}, r, { _uid: uid(), street:(r.street||""), remark:(r.remark||""),
          deviceType:(r.deviceType||""), contact:(r.contact||"") });
      });
      saveDataLocal();
      // 不在这里标记任何「待推送」状态：init() 拉完云端后统一判断
      // 「本地还有没有从未在云端确认过的记录」，有就补推一次（见 init）。
    } else if(state.data && state.data.length){
      state.data.forEach(function(r){
        if(!r._uid) r._uid = uid();
        if(r.street===undefined) r.street="";
        if(r.remark===undefined) r.remark="";
        if(r.deviceType===undefined) r.deviceType="";
        if(r.contact===undefined) r.contact="";
      });
    }
  }
  function saveSynced(){ try{ localStorage.setItem(LS_SYNCED, JSON.stringify(state.synced||{})); }catch(e){} }
  function saveDirty(){ try{ localStorage.setItem(LS_DIRTY, JSON.stringify(state.dirty||{})); }catch(e){} }
  function markAllSynced(){ state.data.forEach(function(r){ state.synced[cloudKey(r)] = true; }); saveSynced(); }
  /* 本地修订号 +1。凡是「用户/本地发起的改动」都要走这里，pullCloud 靠它判断快照是否过期。 */
  function bumpRev(){ state.rev = (state.rev || 0) + 1; return state.rev; }
  /* 落盘。
   * ⚠️ 默认会把修订号 +1 —— 因为调用它的地方几乎都是「本地数据刚被改动」。
   * 唯一的例外是 pullCloud 合并完成后那次落盘（数据来源是云端，不是本地改动），
   * 那里必须显式传 false，否则会把「同时发起的另一次拉取」误判成快照过期。 */
  function saveDataLocal(fromLocal){
    if(fromLocal !== false) bumpRev();
    localStorage.setItem(LS_DATA, JSON.stringify(state.data));
    saveSynced();
  }
  // 非关键路径（如地理编码逐条落盘）用防抖同步；关键操作请用 commit()
  function saveData(sync){
    saveDataLocal();
    if(sync !== false) scheduleSync();
  }

  /* ---------------- 云同步（腾讯云 CloudBase） ----------------
   * 数据模型：云集合（默认 units）里一条记录 = 一个单位。
   *   - 每条记录带业务主键 key（= 卫生许可证号；无许可证号时用本机 _uid 兜底）；
   *   - 同步策略「全量对齐」：拉取云端全量 → 逐条比对 → 缺的新增 / 变的更新 / 多的删除；
   *   - 多设备合并按 key 进行，因此删除也能跨设备传播。
   */
  /* ⚠️ 必须用 UMD 构建，不要用 CDN 的 ESM 版（+esm）。
   * 原因：@cloudbase/js-sdk 2.28.8 的 ESM 包依赖 text-encoding-shim，
   * 而 CDN 转换后的该模块不导出 TextDecoder，动态 import() 会直接抛
   *   "does not provide an export named 'TextDecoder'"
   * 导致 SDK 根本加载不进来，表现为「实时同步：未连接」+ window.cloudbase 为空。
   * 官方 static.cloudbase.net 提供 UMD 全量包，加载后自行挂到 window.cloudbase。 */
  var CB_SDK_URLS = [
    "https://static.cloudbase.net/cloudbase-js-sdk/2.28.8/cloudbase.full.js",
    "https://cdn.jsdelivr.net/npm/@cloudbase/js-sdk@2.28.8/miniprogram_dist/index.js"
  ];
  var cbApp = null, cbDb = null, cbReady = false, cbPageSize = 100;
  var _sdkPromise = null;

  function cbConfigured(){
    return !!(state.settings.cbEnv && state.settings.cbCollection);
  }
  // 用 <script> 依次尝试多个 CDN 的 UMD 包，任一成功即用
  function loadCloudbaseSdk(){
    if(_sdkPromise) return _sdkPromise;
    _sdkPromise = new Promise(function(resolve){
      var i = 0;
      function tryNext(){
        if(i >= CB_SDK_URLS.length){ resolve(null); return; }
        var url = CB_SDK_URLS[i++];
        var s = document.createElement("script");
        s.src = url; s.async = true;
        s.onload = function(){
          if(window.cloudbase && typeof window.cloudbase.init === "function") resolve(window.cloudbase);
          else tryNext();                      // 加载成功但不是我们要的东西 → 换下一个
        };
        s.onerror = function(){ tryNext(); };
        document.head.appendChild(s);
      }
      tryNext();
    });
    return _sdkPromise;
  }
  /* ---------------- 把 CloudBase 网关请求改道到本站同源代理 ----------------
   * 【为什么需要】
   * 浏览器直连腾讯云网关（<env>.<region>.tcb-api.tencentcloudapi.com）时，网关只在
   * 「Web 安全域名」白名单内的来源上返回 CORS 头；白名单默认只有 localhost 等，
   * 线上域名 water-309.onrender.com 不在其中 → 浏览器直接拦掉（net::ERR_FAILED）。
   * 而**添加自定义安全域名需要付费套餐**（腾讯云 API 错误码 OperationDenied.FreePackageDenied），
   * 所以这条路走不通。
   *
   * 【解法】render.yaml 里配了一条 rewrite：/cbapi/* → 腾讯云网关。
   * 浏览器请求的是本站同源地址 /cbapi/...，由 Render 在服务端转发到腾讯云。
   * 同源请求根本不触发 CORS 机制，因此**不需要任何白名单、不需要付费**。
   * （已在 2026-09-17 实测：/web 与 /auth/* 两条路径都能正确转发，响应与直连一致。）
   *
   * 【为什么必须同时拦 fetch 和 XMLHttpRequest】
   * SDK 在不同环境下选不同传输；而且认证接口(/auth/*)与数据接口(/web)是两条独立路径，
   * 只拦一个就会出现「登录成功但读不到数据」这类半通不通的状态。
   *
   * 【为什么 localhost 不改道】
   * localhost 本来就在 CloudBase 默认白名单里，直连即可；而且本地开发时没有这个代理，
   * 改道反而会把请求打到不存在的地方。
   */
  function cbGatewayRewrite(u){
    var env = (state.settings.cbEnv || "").trim();
    var region = (state.settings.cbRegion || "ap-shanghai").trim();
    if(!env || typeof u !== "string") return u;
    var host = (env + "." + region + ".tcb-api.tencentcloudapi.com").replace(/\./g, "\\.");
    var re = new RegExp("^https?://" + host, "i");
    if(!re.test(u)) return u;
    return location.origin + "/cbapi" + u.replace(re, "");
  }
  function patchCloudBaseEndpoint(){
    if(window.__cbEndpointPatched) return;
    if(location.protocol !== "http:" && location.protocol !== "https:") return;   // file:// 等
    if(/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname)) return;     // 本机直连即可
    window.__cbEndpointPatched = true;

    var _fetch = window.fetch;
    if(_fetch){
      window.fetch = function(input, init){
        try{
          if(typeof input === "string") input = cbGatewayRewrite(input);
          else if(input && typeof input.url === "string"){
            var nu = cbGatewayRewrite(input.url);
            if(nu !== input.url) input = new Request(nu, input);
          }
        }catch(e){}
        return _fetch.call(window, input, init);
      };
    }
    var XHR = window.XMLHttpRequest;
    if(XHR && XHR.prototype && XHR.prototype.open){
      var _open = XHR.prototype.open;
      XHR.prototype.open = function(m, u){
        var args = Array.prototype.slice.call(arguments);
        try{ args[1] = cbGatewayRewrite(u); }catch(e){}
        return _open.apply(this, args);
      };
    }
  }
  // 初始化 + 匿名登录（只做一次）
  async function ensureCloud(){
    if(cbReady) return true;
    if(!cbConfigured()) return false;
    patchCloudBaseEndpoint();          // 必须在 SDK 加载【之前】改道
    var cb = window.cloudbase || await loadCloudbaseSdk();
    if(!cb) throw new Error("CloudBase SDK 加载失败，请检查网络后重试");
    var cfg = { env: state.settings.cbEnv };
    if(state.settings.cbRegion) cfg.region = state.settings.cbRegion;
    if(state.settings.cbAccessKey) cfg.accessKey = state.settings.cbAccessKey;
    cbApp = cb.init(cfg);
    var authApi = cbApp.auth, authInst = authApi;
    if(typeof authApi === "function"){
      try{ var a = authApi({ persistence:"local" }); if(a && typeof a.signInAnonymously === "function") authInst = a; }catch(e){}
    }
    if(authInst && typeof authInst.signInAnonymously === "function"){
      var r;
      try{ r = await authInst.signInAnonymously(); }
      catch(e){ throw new Error("匿名登录失败：" + errText(e) + " —— 请在云开发控制台「身份认证」中开启匿名登录"); }
      if(r && (r.error || r.code)) throw new Error("匿名登录失败：" +
        errText(r.error || r) + " —— 请在云开发控制台「身份认证」中开启匿名登录");
    }
    cbDb = cbApp.database();
    cbReady = true;
    return true;
  }
  function resetCloud(){ cbReady = false; cbApp = null; cbDb = null; }

  function strHash(s){
    var h = 5381;
    for(var i=0;i<s.length;i++) h = (((h<<5)+h) + s.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }
  // 业务主键：卫生许可证号优先（超长时截断+哈希，避免过长字符串带来的兼容问题）
  function cloudKey(rec){
    var k = String(rec.license==null ? "" : rec.license).trim();
    if(!k) return "u:" + rec._uid;
    return k.length > 60 ? (k.slice(0,40) + "~" + strHash(k)) : k;
  }
  function toDoc(rec){
    return {
      key: cloudKey(rec),
      id: rec.id||"", name: rec.name||"", address: rec.address||"",
      street: rec.street||"",
      license: rec.license||"",
      valid_from: rec.validFrom||"", valid_to: rec.validTo||"",
      lng: (rec.lng==null ? null : rec.lng), lat: (rec.lat==null ? null : rec.lat),
      remark: rec.remark||"", device_type: rec.deviceType||"", contact: rec.contact||"",
      updated_at: Date.now()
    };
  }
  function fromDoc(d){
    return { _uid: uid(), id:d.id||"", name:d.name||"", address:d.address||"",
      street:d.street||"",
      license:d.license||"", validFrom:d.valid_from||"", validTo:d.valid_to||"",
      lng:(d.lng==null?null:d.lng), lat:(d.lat==null?null:d.lat),
      remark:d.remark||"", deviceType:d.device_type||"", contact:d.contact||"" };
  }
  // 业务字段比对（updated_at 不参与，否则每次都会判定为“已变更”而全量重写）
  var DOC_FIELDS = ["key","id","name","address","street","license","valid_from","valid_to","lng","lat","remark","device_type","contact"];
  function sameDoc(a, b){
    for(var i=0;i<DOC_FIELDS.length;i++){
      var f = DOC_FIELDS[i];
      var x = a[f], y = b[f];
      if(x===undefined) x = null;
      if(y===undefined) y = null;
      if(x==null && y==="") x = "";
      if(y==null && x==="") y = "";
      if(x !== y) return false;
    }
    return true;
  }
  // 分页拉取云端全量（单次 get 有条数上限：先按 100 取，被拒则降到 20 重来）
  async function fetchAllDocs(){
    var col = cbDb.collection(state.settings.cbCollection);
    var all = [], skip = 0, guard = 0;
    while(guard++ < 800){
      var arr;
      try{
        var r = unwrap(await col.skip(skip).limit(cbPageSize).get(), "读取云端失败");
        arr = (r && r.data) || [];
        /* ⚠️ 必须显式校验返回值形状：SDK 在响应异常（空响应/解析失败）时可能
         * 静默返回非数组，后续 `arr.length < cbPageSize` 会因 undefined 而判假，
         * 表现为「一个请求就结束、rows 为空、却不报错」——正是 2026-09-17 线上
         * 遇到的「浏览器读到 0 条」。这里把它变成显式异常，宁可报错也不静默读空。 */
        if(!Array.isArray(arr)) throw new Error("云端返回格式异常（data 不是数组）");
      }catch(e){
        // 注意：集合不存在 / 无权限属于「确定性错误」，降页大小重试没有意义，
        // 直接抛出（上面的 unwrap 已经把 code 转成异常）。
        if(e && e.code) throw e;
        if(cbPageSize > 20){ cbPageSize = 20; all = []; skip = 0; continue; }
        throw e;
      }
      all = all.concat(arr);
      if(arr.length < cbPageSize) break;
      skip += cbPageSize;
    }
    return all;
  }
  // 有限并发执行（云开发没有批量写接口，只能逐条；并发 4 兼顾速度与限流）
  async function runPool(items, size, fn){
    var i = 0, n = items.length;
    var limit = Math.max(1, Math.min(size, n));
    var workers = [];
    for(var w=0; w<limit; w++){
      workers.push((async function(){
        while(i < n){ var idx = i++; await fn(items[idx], idx); }
      })());
    }
    await Promise.all(workers);
  }
  // 静默自动同步失败时也要让用户看见，否则“保存失败”会被完全吞掉，
  // 表现为“导入了、看着有，刷新就没了”却没有任何提示。同一条错误 60 秒内只提示一次。
  var _syncErrAt = {};
  // 把已知的云端错误码翻译成「用户能照着做」的提示。
  // 没有这一步的话，用户只会看到一句英文报错，不知道要去控制台点哪里。
  function cloudHint(msg){
    if(/DATABASE_COLLECTION_NOT_EXIST|not exist/i.test(msg))
      return " —— 云开发控制台「文档型数据库 → 集合管理」里还没有这个集合，请先新建一个，名字要和「设置界面 → 集合名」一致";
    if(/DATABASE_PERMISSION_DENIED|permission|权限|安全规则|502002|502003/i.test(msg))
      return " —— 请在云开发控制台把该集合权限设为自定义安全规则：{\"read\": true, \"write\": true}";
    if(/PreflightMissingAllowOriginHeader|CORS|Access-Control|Failed to fetch|network request error/i.test(msg))
      return " —— 云开发控制台「环境配置 → 安全来源」（旧名「安全域名」）里没加 " + location.hostname +
             "，加上后约 1-2 分钟生效（注意：加自定义安全域名需要付费套餐）";
    if(/WRITE_NOT_APPLIED|只影响了|仅创建者可写/i.test(msg))
      return " —— 这条记录是别的设备/身份创建的，而集合安全规则是「仅创建者可写」，云端拒绝了本次修改。" +
             "请到云开发控制台 → 数据库 → 集合 units → 权限设置 → 自定义安全规则，改成 " +
             "{\"read\": true, \"write\": true}（免费，改完立刻生效）";
    if(/INVALID_ACCESS_TOKEN|匿名登录|登录方式未开启/i.test(msg))
      return " —— 请在云开发控制台「身份认证 → 登录授权」开启「匿名登录」";
    return "";
  }
  function warnSyncError(msg){
    var key = String(msg).slice(0, 80);
    var now = Date.now();
    // 常驻提示条先亮起来（这是关键：toast 只显示 2.6 秒，
    // 用户在解锁后立刻同步失败时会完全错过，之后 60 秒内还被去重，等于永远看不见）
    showSyncWarn(msg);
    if(_syncErrAt[key] && now - _syncErrAt[key] < 15000) return;
    _syncErrAt[key] = now;
    toast("云端保存失败（数据仅存本地）：" + msg + cloudHint(msg), "err");
  }
  // 云同步异常常驻提示：只有真正同步成功才会消失（或用户手动关掉本次会话）
  var _syncWarnClosed = false;
  function showSyncWarn(msg){
    var box = $("sync-warn"), txt = $("sync-warn-text");
    if(!box || !txt || _syncWarnClosed) return;
    txt.textContent = msg + cloudHint(msg);
    box.classList.add("show");
  }
  function clearSyncWarn(){
    var box = $("sync-warn");
    if(box) box.classList.remove("show");
    _syncWarnClosed = false;
  }
  function errText(e){
    if(!e) return "未知错误";
    return e.message || e.errMsg || e.code || String(e);
  }
  /* ⚠️⚠️ 这是 CloudBase JS SDK 2.28.8 的一个致命坑，务必理解后再改云同步代码：
   * 接口层报错时，SDK 是 **resolve 一个 {code, message, requestId} 对象**，而不是 reject！
   * 也就是说 `await col.get()` 在「集合不存在 / 无权限 / 参数非法」时**不会抛异常**，
   * 只会安静地返回一个带 code 的对象。
   * 后果（本项目真实踩过）：
   *   - fetchAllDocs 把错误对象当成「云端为空」→ 认为 791 条都要新增；
   *   - 写入同样返回错误对象，代码却当成写成功 → 提示「同步成功」，实际一条没写；
   *   - 「测试连接」显示「连接正常：云端共 0 条」——纯属假阳性。
   * 所以：**所有云调用都必须过 unwrap()**，让它变成一个真正的异常，才能被 catch 到。 */
  function unwrap(res, what){
    if(res && typeof res === "object" && res.code){
      var e = new Error((what ? what + "：" : "") + (res.message || res.code));
      e.code = res.code;
      throw e;
    }
    return res;
  }

  /* ⚠️⚠️ 第二个静默坑（2026-09-17 实测）—— 比 unwrap 那个更阴，务必理解：
   * 写操作【被云端拒绝】时，SDK 同样**不报错**，而是正常 resolve 一个
   *   {"deleted": 0}   /   {"updated": 0}
   * 实测：删除一条别的身份创建的文档 → remove() 返回 {"deleted":0}，不抛异常。
   * 触发条件：集合安全规则是「仅创建者可写」，而这条文档是另一台设备/另一个身份建的。
   * 后果极严重：用户在手机上改了一条电脑上建的记录，界面提示「已保存」，
   * 云端却一个字都没变 —— 下次拉取时改动凭空消失，全程没有任何报错。
   * 所以：**写操作必须校验「真的影响了 N 条」**，不能只看有没有 code。 */
  function mustAffect(res, field, want, what){
    var r = unwrap(res, what);
    var n = null;
    if(r && typeof r[field] === "number") n = r[field];
    else if(field === "id" && r){
      if(typeof r.id === "string" && r.id) n = 1;
      else if(r.ids && r.ids.length) n = r.ids.length;
      else if(Array.isArray(r.ids)) n = 0;   // ⚠️ 空 ids 数组 = 什么都没写进去（批量写坏的征兆）
    }
    if(n === null) return r;                 // 网关没回这个字段，无法判定，放行
    if(n < want){
      var e = new Error((what || "写入") + "：云端只影响了 " + n + " 条（期望 " + want + " 条）");
      e.code = "WRITE_NOT_APPLIED";
      throw e;
    }
    return r;
  }

  /* ---------------- 即时全量对齐（台账操作后调用） ----------------
   * 立即执行，且让【云端与本地完全一致】：新增/编辑=写入，本地已删=从云端删除。
   * 删除判定直接看「云端有但本地没有」：用户主动删除是明确的意图，必须立即
   * 反映到云端；多设备间的数据合并由启动时的 pullCloud(merge) 保证，不会因为本函数被误删。
   */
  var _aligning = false, _alignPending = false;
  async function syncNow(opts){
    opts = opts || {};
    if(_aligning){ _alignPending = true; return; }   // 已有同步在跑 → 结束后补跑一次
    if(!cbConfigured()){ if(!opts.silent) toast("请先在「设置界面」填写腾讯云开发环境 ID", "warn"); return; }
    _aligning = true;
    try{
      await ensureCloud();
      var col = cbDb.collection(state.settings.cbCollection);
      var cloud = await fetchAllDocs();

      // 建索引：key → 云端文档；同一 key 出现多条（多设备并发新增）时，多余的直接清理
      var cloudByKey = {}, dupIds = [];
      cloud.forEach(function(d){
        if(!d || !d.key) return;
        if(cloudByKey[d.key]) dupIds.push(d._id);
        else cloudByKey[d.key] = d;
      });

      var localKeys = {}, toAdd = [], toSet = [];
      state.data.forEach(function(rec){
        var doc = toDoc(rec);
        localKeys[doc.key] = true;
        var c = cloudByKey[doc.key];
        if(!c) toAdd.push(doc);
        else if(!sameDoc(doc, c)){ doc._id = c._id; toSet.push(doc); }
      });
      /* ⚠️ stale（要从云端删掉的）判据必须带上 state.synced[d.key]：
       * 本函数是「先读云端全量、再比对、再删」——读全量要十几秒。如果这十几秒里
       * 别的设备【新增】了一条记录，我们这份快照里没有它、本地也没有它，
       * 按「云端有但本地没有就删」的旧判据就会把别人刚存进去的数据删掉。
       * 加上 synced 判据后语义变成「本机曾经确认过、现在本地没了 = 用户主动删除」，
       * 这才是真正想表达的意图；没见过的云端记录一律不动，交给 pullCloud 合并进来。 */
      var stale = cloud.filter(function(d){ return d && d.key && !localKeys[d.key] && state.synced[d.key]; })
                       .concat(dupIds.map(function(id){ return { _id: id, key: null }; }));

      var wrote = 0, removed = 0, firstErr = null;
      /* 记录「没成功传上去的 key」——见文件里 state.dirty 的说明。
       * 目的：下次打开时既不会被云端旧值覆盖，也一定会被重推一次。 */
      var failKeys = {};
      /* 1) 新增 —— ⚠️ 必须【逐条】add，绝对不能用 col.add([数组])「批量」。
       * 这个网关下传数组不会写入多条，而是把整个数组当成 **一个文档** 落库
       * （变成 {"0":{...},"1":{...}} 的畸形结构），而且 **不抛错、不返回 id**。
       * 也就是说批量写入是「静默写坏数据」：调用方以为写了 20 条，实际写了 1 条垃圾。
       * 并发 4 兼顾速度与限流。 */
      await runPool(toAdd, 4, async function(doc){
        try{ mustAffect(await col.add(doc), "id", 1, "写入云端失败"); wrote++; }
        catch(e){ if(doc.key) failKeys[doc.key] = true; if(e && e.code) throw e; if(!firstErr) firstErr = e; }
      });
      // 2) 更新（整文档覆盖写，_id 保持不变）
      await runPool(toSet, 4, async function(d){
        var id = d._id, k = d.key; delete d._id;
        try{ mustAffect(await col.doc(id).set(d), "updated", 1, "更新云端失败"); wrote++; }
        catch(e){ if(k) failKeys[k] = true; if(!firstErr) firstErr = e; }
      });
      // 3) 删除云端残留（本地已删 / 重复文档）
      await runPool(stale, 4, async function(d){
        try{ mustAffect(await col.doc(d._id).remove(), "deleted", 1, "删除云端文档失败"); removed++; }
        catch(e){ if(d.key) failKeys[d.key] = true; if(!firstErr) firstErr = e; }
      });

      if(firstErr){
        /* 把没传上去的 key 记进 dirty：下次打开时
         *   ① pullCloud(merge) 不会用云端旧值覆盖它们；
         *   ② init() 的补推会重新推一次。
         * 没有这一步的话，本地改动会在下次打开时被云端旧值悄悄盖掉。 */
        Object.keys(failKeys).forEach(function(k){ state.dirty[k] = true; });
        saveDirty();
        throw firstErr;
      }
      /* ⚠️ markAllSynced() 必须放在「确认没出错」之后。
       * 它一旦提前执行，写失败的记录会被标成「已在云端确认过」，
       * 而 init() 的补推判据正是「有没有还没在云端确认过的记录」——
       * 于是这些记录再也不会被重试，本地与云端永久分叉。 */
      state.dirty = {}; saveDirty();
      markAllSynced();
      clearSyncWarn();                 // 真正对齐成功才撤掉异常提示条
      if(!opts.silent){
        toast("已与云端对齐：" + state.data.length + " 条（写入 " + wrote + " 条" +
              (removed ? "，删除 " + removed + " 条" : "") + "）", "ok");
      }
    }catch(e){
      var m = errText(e);
      /* ⚠️ 无论是不是静默同步，都必须亮起常驻提示条。
       * 「写被静默拒绝」这类错误一旦被错过，用户会以为已经保存，
       * 而云端其实一个字都没变 —— 必须持续可见，不能只弹 2.6 秒的 toast。 */
      showSyncWarn(m);
      if(!opts.silent) toast("云端对齐失败：" + m + cloudHint(m), "err");
      else warnSyncError(m);
    }finally{
      _aligning = false;
      if(_alignPending){ _alignPending = false; syncNow(opts); }
    }
  }
  // 台账操作后的统一提交：立即落盘 + 立即与云端对齐
  function commit(opts){ saveDataLocal(); syncNow(opts); }
  // 非关键路径的防抖同步（如地理编码收尾），1.5 秒内多次调用只跑一次
  var syncTimer = null;
  function scheduleSync(){
    if(syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function(){ syncTimer = null; syncNow({silent:true}); }, 1500);
  }

  /* ---------------- 多设备实时同步（云开发数据库实时推送） ----------------
   * 订阅集合变更，任何设备改动后本页立即自动合并（沿用 pullCloud(merge) 规则）。
   * 若实时通道连不上，退化为每 45 秒静默拉取一次 + 页面重新可见时拉一次。
   */
  var rtListener = null, rtTimer = null, rtState = "off";   // off|syncing|connecting|on|error
  var rtRetries = 0;                                        // 掉线后的重连尝试次数
  var rtDownAt = 0;                                         // 掉线时刻（用于日志里「已降级多久」）
  function updateRtBadge(){
    var el = $("rt-badge");
    if(!el) return;
    var txt, cls = "";
    if(!cbConfigured()){ txt = "云同步：未配置"; }
    else if(state.settings.realtime === false){ txt = "实时同步：已关闭"; }
    else {
      txt = rtState === "on" ? "实时同步：已连接"
          : rtState === "connecting" ? "实时同步：连接中…"
          : rtState === "syncing" ? "实时同步：等待首次同步完成…"  // 正在拉云端 + 对齐，完成才开实时通道
          : rtState === "error" ? "实时同步：未连接（兜底轮询中）"
          : "实时同步：等待首次同步完成…";
      cls = rtState;
    }
    el.textContent = txt;
    el.className = "rt-badge " + cls;
  }
  // 收到变更事件后防抖拉取；若本端正上传，稍后再拉，避免与 syncNow 打架
  function scheduleRealtimePull(){
    if(rtTimer) clearTimeout(rtTimer);
    rtTimer = setTimeout(function(){
      rtTimer = null;
      if(_aligning){ scheduleRealtimePull(); return; }
      pullCloud({ confirm:false, merge:true, quietError:true, silent:true });
    }, 800);
  }
  /* 实时通道掉线后自己重新连。
   * 为什么必须自己重连：SDK 内部的实时通道用的是**有限次数的重连凭据**
   * （控制台会打 `use a retry ticket, now only N retry left`，用尽即不再重连），
   * 而页面可能一开就是几个小时、期间经历多次切网/休眠。没有这一步的话，
   * 一旦凭据耗光，徽标就会永久停在「未连接（兜底轮询中）」，直到用户手动刷新页面。
   * 退避：30s → 60s → 120s → 300s（封顶），避免服务器侧不可用时疯狂重试。 */
  var rtReconnectTimer = null;
  function scheduleRtReconnect(){
    if(rtReconnectTimer) return;
    if(state.settings.realtime === false || !cbConfigured()) return;
    var delay = Math.min(30000 * Math.pow(2, Math.min(rtRetries, 3)), 300000);
    if(rtRetries === 0) delay = 30000;
    rtRetries++;
    if(!rtDownAt) rtDownAt = Date.now();
    rtReconnectTimer = setTimeout(function(){
      rtReconnectTimer = null;
      if(document.hidden) return;             // 后台不折腾，回到前台由 onPageVisible 触发
      console.log("[实时同步] 第 " + rtRetries + " 次重连尝试（已降级 " +
        Math.round((Date.now() - rtDownAt) / 1000) + " 秒，兜底轮询仍在工作）");
      startRealtime();
    }, delay);
  }
  function cancelRtReconnect(){
    if(rtReconnectTimer){ clearTimeout(rtReconnectTimer); rtReconnectTimer = null; }
  }
  async function startRealtime(){
    if(state.settings.realtime === false || !cbConfigured()){ updateRtBadge(); return; }
    if(rtListener) return;
    rtState = "connecting"; updateRtBadge();
    try{
      await ensureCloud();
      rtListener = cbDb.collection(state.settings.cbCollection).watch({
        onChange: function(){ scheduleRealtimePull(); },
        onError: function(e){
          // 不要把原因吞掉：实时连不上时，云同步/权限问题全靠这条日志定位
          console.warn("[实时同步] 连接中断，已退化为 45 秒兜底轮询：", errText(e));
          rtState = "error"; updateRtBadge(); stopRealtime(true);
          scheduleRtReconnect();               // ← 自己安排重连，别指望 SDK 无限重试
        }
      });
      rtState = "on"; updateRtBadge();
      rtRetries = 0; rtDownAt = 0; cancelRtReconnect();
    }catch(e){
      console.warn("[实时同步] 启动失败，已退化为 45 秒兜底轮询：", errText(e));
      rtState = "error"; updateRtBadge();
      scheduleRtReconnect();
    }
  }
  function stopRealtime(keepState){
    if(rtTimer){ clearTimeout(rtTimer); rtTimer = null; }
    try{ if(rtListener && rtListener.close) rtListener.close(); }catch(e){}
    rtListener = null;
    if(!keepState){ rtState = "off"; updateRtBadge(); }
  }
  // 兜底轮询：实时通道不可用时，保证多设备仍能在大约 1 分钟内收敛
  var pollTimer = null;
  function startFallbackPoll(){
    if(pollTimer) return;
    pollTimer = setInterval(function(){
      if(document.hidden) return;
      if(!cbConfigured() || _aligning) return;
      if(rtState === "on") return;
      pullCloud({ confirm:false, merge:true, quietError:true, silent:true });
      // 顺带补一次重连：定时器在后台被节流可能会错过，这里兜住
      if(rtState === "error" && !rtReconnectTimer) scheduleRtReconnect();
    }, 45000);
  }
  function onPageVisible(){
    if(document.hidden || !cbConfigured() || _aligning) return;
    pullCloud({ confirm:false, merge:true, quietError:true, silent:true });
    // 回到前台时，如果实时通道正断着，立刻重连一次（不等退避窗口）
    if(rtState === "error"){
      cancelRtReconnect();
      rtRetries = 0;
      startRealtime();
    }
  }

  // 从云端拉取。opts: { confirm:是否先确认覆盖, merge:按 key 合并(保留本地独有记录、坐标不空覆盖),
  //                  quietError:静默错误提示, silent:静默全部提示 }
  async function pullCloud(opts){
    opts = opts || {};
    if(!cbConfigured()){ if(!opts.silent) toast("请先在「设置界面」填写腾讯云开发环境 ID", "warn"); return; }
    /* ⚠️ 闸门一：全量对齐（syncNow）正在进行时，合并式拉取必须让路。
     * 两者都会重写 state.data，谁后跑谁说了算 —— 让它们并行就是在赌时序。 */
    if(_aligning && opts.merge === true) return false;
    if(opts.confirm !== false && opts.merge !== true){
      if(!confirm("从云端拉取将用云端数据覆盖本地全部记录，确定继续？")) return;
    }
    /* ⚠️⚠️ 闸门二（2026-09-17 实测故障的正解）：记住「开始读快照时的本地修订号」。
     * 本函数的结构是【读云端全量 → 合并进 state.data】，中间隔着十几秒网络等待。
     * 若这段等待里用户点了一次保存（commit → bumpRev），我们手里这份快照就是
     * 【编辑之前】的旧数据；合并回去会把用户刚保存的改动静默抹掉，而且：
     *   - 没有报错（写根本没被尝试）
     *   - state.dirty 帮不上忙（它只在「写失败之后」才设置，此刻还没写）
     *   - 最终 syncNow 还会提示「已与云端对齐（写入 0 条）」，看起来一切正常
     * 实测表现就是：本地改了一条备注 → 提示已保存 → 几秒后备注变回原样、云端也没变。
     * 对策：快照一旦过期就整份丢弃，不合并、不剪枝、不落盘，并安排一次重试。 */
    var rev0 = state.rev || 0;
    try{
      await ensureCloud();
      var col = cbDb.collection(state.settings.cbCollection);
      var rows = await fetchAllDocs();
      if((state.rev || 0) !== rev0){
        console.warn("[云同步] 拉取期间本地发生改动（rev " + rev0 + " → " + state.rev +
                     "），本次快照已过期，已放弃合并以免覆盖本地改动；稍后自动重试");
        scheduleRealtimePull();          // 用新快照重来一次（至多一次，不会打转）
        return false;
      }
      /* ⚠️⚠️ 一致性校验 —— 这是本应用最危险的一条路径，务必理解：
       * 合并模式会「剪枝」：云端没有、而本地 synced 标记为 true 的记录会被删掉
       * （用于实现「别的设备删掉一条，本端也跟着删」）。
       * 但如果这次读取【不可信】—— 网关返回空响应、SDK 把解析失败吞成空数组、
       * 分页中途断掉 —— rows 就是空的，剪枝会把【本地全部记录删光】，
       * 用户重新打开页面看到的就是「数据全没了」。
       * 实测（2026-09-17）：集合里存在畸形文档时，浏览器这一侧确实出现过
       * 「一个请求都没报错、但 rows 为空」的情况，所以这个校验不是假想。
       * 判据用 count() 交叉验证：count 说有数据、分页却读回空 → 判定本次读取不可信。 */
      var total = null;
      try{
        var c = unwrap(await col.count(), "统计云端条数失败");
        total = (c && (c.total != null ? c.total : (c.data && c.data[0] && c.data[0].total))) || 0;
      }catch(e){ total = null; }
      var readSuspect = (rows.length === 0 && state.data.length > 0 && Object.keys(state.synced).length > 0);
      if(readSuspect){
        var rm = "云端读到 0 条，但本机此前已确认过 " + Object.keys(state.synced).length +
                 " 条记录" + (total != null ? "（云端统计为 " + total + " 条）" : "") +
                 "，本次读取结果不可信，已跳过合并以免误删本地数据";
        console.warn("[云同步] " + rm);
        showSyncWarn(rm);
        return false;
      }
      var keyed = {};
      rows.forEach(function(d){ if(d && d.key && !keyed[d.key]) keyed[d.key] = d; });
      // 闸门二的第二道：count() 也是一次 await，合并前再确认一次修订号没变
      if((state.rev || 0) !== rev0){
        console.warn("[云同步] 统计期间本地发生改动（rev " + rev0 + " → " + state.rev +
                     "），本次快照已过期，已放弃合并");
        scheduleRealtimePull();
        return false;
      }
      if(opts.merge === true){
        // 合并模式：以 synced 标记为据，区分“本地新增”与“别处已删除”。
        // 剪枝的安全条件：①云端有记录，或②本设备此前已确认过云端记录(synced 非空)。
        // 两者都不满足时（读权限被拒导致读到空、或首次运行）【绝不剪枝】，
        // 否则会把本地已有数据全部误删（刷新即空）。
        // 必须允许“云端被删空”的情况剪枝，否则其它设备删掉最后一条时本端不会跟着删。
        if(rows.length > 0 || Object.keys(state.synced).length > 0){
          state.data = state.data.filter(function(r){
            var k = cloudKey(r);
            return !state.synced[k] || keyed[k];
          });
        }
        var byKey = {};
        state.data.forEach(function(r){ byKey[cloudKey(r)] = r; });
        rows.forEach(function(d){
          if(!d || !d.key) return;
          var base = byKey[d.key];
          if(base){
            /* ⚠️ 本地改过但【没成功上传】的记录（state.dirty），绝不能被云端旧值覆盖。
             * 否则「手机上改了一条、提示保存失败、重新打开」时，改动会无声消失，
             * 而用户看到的是「同步成功」。等下次上传成功，dirty 标记才清除。 */
            if(!(state.dirty && state.dirty[d.key])){
              base.id = d.id; base.name = d.name; base.address = d.address;
              base.validFrom = d.valid_from; base.validTo = d.valid_to;
              // 仅当云端确实有该字段（值非 null）时才覆盖本地，
              // 否则云端缺字段会把本地已有的备注/设备类型/联系人清空
              if(d.license != null) base.license = d.license;
              if(d.street != null) base.street = d.street;
              if(d.remark != null) base.remark = d.remark;
              if(d.device_type != null) base.deviceType = d.device_type;
              if(d.contact != null) base.contact = d.contact;
              if(d.lng != null) base.lng = d.lng;
              if(d.lat != null) base.lat = d.lat;
            }
          } else {
            state.data.push(fromDoc(d));
          }
          state.synced[d.key] = true;
        });
        saveSynced();
      } else {
        // 全量覆盖分支：云端即为真相，每条云端记录都标记为已同步
        state.data = rows.filter(function(d){ return d && d.key; }).map(fromDoc);
        state.synced = {};
        state.dirty = {};               // 本地已被云端整体替换，未上传的改动不再存在
        rows.forEach(function(d){ if(d && d.key) state.synced[d.key] = true; });
        saveSynced(); saveDirty();
      }
      // 这次落盘的数据来源是【云端快照】，不是本地改动 → 不涨修订号
      saveDataLocal(false);
      renderCurrentView();
      clearSyncWarn();                 // 拉取成功 = 通道正常，撤掉异常提示条
      if(rows.length && !opts.silent) toast("已从云端同步 "+rows.length+" 条"+(opts.merge?"（已与本地合并）":""), "ok");
      return true;                     // 供调用方判断「这次拉取到底成没成」
    }catch(e){
      var pm = errText(e);
      // 「集合不存在 / 无权限 / 域名没放行」属于确定性配置错误，静默掉只会让用户
      // 一头雾水地看到「同步没反应」。这类错误即使 quietError 也要提示一次。
      if(e && e.code && !opts.silent) warnSyncError(pm);
      else if(!opts.silent) showSyncWarn(pm);
      if(!opts.quietError && !opts.silent && !(e && e.code)) toast("拉取失败：" + pm + cloudHint(pm), "err");
      return false;
    }
  }

  /* ---------------- 云端运维：测试连接 / 清空云端 ---------------- */
  function setSetStatus(msg, isErr){
    var el = $("set-status");
    if(!el) return;
    el.textContent = msg || "";
    el.style.color = isErr ? "var(--red)" : "";
  }
  async function testCloud(){
    if(!cbConfigured()){ toast("请先填写环境 ID 与集合名", "warn"); return; }
    try{
      await ensureCloud();
      var n;
      try{
        var c = unwrap(await cbDb.collection(state.settings.cbCollection).count(), "连接测试失败");
        n = (c && (c.total != null ? c.total : (c.data && c.data[0] && c.data[0].total))) || 0;
      }catch(e){
        if(e && e.code) throw e;
        n = (await fetchAllDocs()).length;
      }
      toast("连接正常：云端「" + state.settings.cbCollection + "」集合共 " + n + " 条", "ok");
      setSetStatus("连接正常：云端共 " + n + " 条");
      clearSyncWarn();
    }catch(e){
      var tm = errText(e);
      toast("连接失败：" + tm + cloudHint(tm), "err");
      setSetStatus("连接失败：" + tm + cloudHint(tm), true);
      showSyncWarn(tm);
    }
  }
  async function clearCloud(){
    if(!cbConfigured()){ toast("请先填写环境 ID 与集合名", "warn"); return; }
    if(!confirm("确定清空云端集合中的【全部】单位数据？此操作不可撤销。")) return;
    if(!confirm("再次确认：云端数据将被全部删除，其它设备拉取后也会变空。")) return;
    try{
      await ensureCloud();
      var col = cbDb.collection(state.settings.cbCollection);
      var all = await fetchAllDocs();
      /* ⚠️ 这里原来把 remove() 的失败用空 catch 吞掉，然后无条件提示
       * 「已清空云端 N 条数据」—— 而 remove() 在被拒时返回 {"deleted":0} 且不抛错，
       * 于是「一条都没删掉」也会被报成清空成功。必须逐条核对 deleted。 */
      var done = 0, blocked = 0;
      await runPool(all, 5, async function(d){
        try{ mustAffect(await col.doc(d._id).remove(), "deleted", 1, "删除失败"); done++; }
        catch(e){ blocked++; }
      });
      if(blocked){
        var bm = "云端有 " + blocked + " 条数据删不掉（不是当前身份创建的）";
        showSyncWarn(bm);
        toast("清空不完整：已删除 " + done + " 条，" + blocked + " 条被云端拒绝" +
              cloudHint("WRITE_NOT_APPLIED"), "err");
      }else{
        state.synced = {}; saveSynced();
        state.dirty = {}; saveDirty();
        toast("已清空云端 " + done + " 条数据", "ok");
      }
    }catch(e){
      toast("清空失败：" + errText(e) + cloudHint(errText(e)), "err");
    }
  }

  /* ---------------- 高德地图 ---------------- */
  function loadAmapScript(key, security){
    return new Promise(function(resolve, reject){
      if(window.AMap){ resolve(); return; }
      window._AMapSecurityConfig = { securityJsCode: security || "" };
      var s = document.createElement("script");
      s.src = "https://webapi.amap.com/maps?v=2.0&key=" + encodeURIComponent(key) +
              "&plugin=AMap.Geocoder,AMap.ToolBar,AMap.Scale";
      s.onload = function(){ resolve(); };
      s.onerror = function(){ reject(new Error("脚本加载失败（检查网络或密钥）")); };
      document.head.appendChild(s);
    });
  }
  async function ensureAmap(){
    if(state.amapReady) return true;
    if(!state.settings.amapKey){
      return false;
    }
    try{
      await loadAmapScript(state.settings.amapKey, state.settings.amapSecurity);
      state.geocoder = new window.AMap.Geocoder({ city:"北京", citylimit:false });
      state.amapReady = true;
      return true;
    }catch(e){
      toast("高德地图加载失败：" + e.message, "err");
      return false;
    }
  }
  function initMap(){
    var el = $("amap-container");
    if(!state.amap){
      // doubleClickZoom:false —— 双击留给“打开单位详情”，避免高德双击缩放抢占事件
      state.amap = new window.AMap.Map(el, { zoom:12, center:[116.41,39.95], doubleClickZoom:false });
      state.amap.addControl(new window.AMap.ToolBar());
      state.amap.addControl(new window.AMap.Scale());
      state.amap.on("click", onMapClick);   // 仅在地图创建时绑定一次，避免重复监听
      // 兜底①：DOM 级双击监听。不依赖高德 SDK 是否代理 marker 的 dblclick 事件，
      // 只要双击落在标记圆点（.mk-dot）上就打开详情，稳定性最高。
      el.addEventListener("dblclick", function(e){
        if(state.pickMode) return;
        var dot = e.target && e.target.closest ? e.target.closest(".mk-dot") : null;
        var uid = dot ? dot.getAttribute("data-uid") : null;
        // 兜底：两次点击之间标记可能被重建（DOM 已替换，e.target 落到容器上），
        // 此时用最近一次点击的标记作为双击对象
        if(!uid && state._lastClickUid && (Date.now() - state._lastClickTs) < 800){
          uid = state._lastClickUid;
        }
        if(!uid) return;
        e.stopPropagation();
        e.preventDefault();
        openDetailFromMap(uid);
      }, true);
    }
    placeMarkers();
  }
  // 取消“待执行的单击设目标”，供双击时调用
  // 注意：_lastClickUid / _lastClickTs 保留，作为“最近点击的标记”供双击兜底使用
  function cancelPendingTargetClick(){
    if(state._clickTimer){ clearTimeout(state._clickTimer); state._clickTimer = null; }
  }
  // 统一入口：从地图标记打开单位详情（双击 / SDK dblclick 两条路径共用，500ms 内去重）
  function openDetailFromMap(uid){
    var now = Date.now();
    if(state._detailOpenTs && now - state._detailOpenTs < 500) return;
    state._detailOpenTs = now;
    cancelPendingTargetClick();     // 双击不切换目标，只弹详情
    openDetail(uid);
  }
  function placeMarkers(){
    if(!state.amap) return;
    Object.keys(state.markers).forEach(function(k){ state.markers[k].setMap(null); });
    state.markers = {};
    state.data.forEach(function(rec){
      if(rec.lng==null || rec.lat==null) return;
      // 圆形标记；搜索高亮/跳动直接写入内容 class，保证稳定生效
      var cls = "mk-dot";
      if(rec._uid === state.targetUid) cls += " target";
      if(state.searchActive){
        if(state.searchMatches[rec._uid]){
          cls += " hl";
          if(state.searchJustRan) cls += " bounce";
        } else if(rec._uid !== state.targetUid) cls += " dim";
      }
      var marker = new window.AMap.Marker({
        position:[rec.lng, rec.lat],
        anchor:"center",
        title:rec.name,
        zIndex:10,
        content:'<div class="'+cls+'" title="'+esc(rec.name)+'" data-uid="'+rec._uid+'"></div>',
        extData:{ uid:rec._uid }
      });
      marker.on("click", function(){
        if(state.pickMode){ pickMarkerChosen(rec._uid); return; }
        state._markerClickTs = Date.now();            // 立即记录，供空白地图点击防抖
        var now = Date.now();
        if(state._lastClickUid === rec._uid && (now - state._lastClickTs) < 350){
          state._lastClickUid = rec._uid; state._lastClickTs = now;
          openDetailFromMap(rec._uid);   // 双击同一标记：弹详情，且不改变当前目标
          return;
        }
        state._lastClickUid = rec._uid; state._lastClickTs = now;
        if(state._clickTimer) clearTimeout(state._clickTimer);
        state._clickTimer = setTimeout(function(){
          state._clickTimer = null;
          selectTarget(rec._uid);        // 单击：设为目标（红色+闪烁+面板+距离圆）
        }, 260);
      });
      // 兜底②：高德 SDK 原生 dblclick（部分版本会代理该事件）
      marker.on("dblclick", function(){
        if(state.pickMode) return;
        openDetailFromMap(rec._uid);
      });
      marker.setMap(state.amap);
      state.markers[rec._uid] = marker;
    });
    state.searchJustRan = false;   // 本次搜索的跳动只播放一次
    updateMapCount();
  }
  function updateMapCount(){
    var cnt = Object.keys(state.markers).length;
    var el = $("map-count");
    if(el) el.textContent = state.searchActive ? ("命中 "+Object.keys(state.searchMatches).length+" 个") : ("共 "+cnt+" 个点位");
  }
  // 选中目标单位：地图飞至、标记变红、闪烁 3 秒、右侧面板显示周边
  function selectTarget(uid){
    var rec = state.data.find(function(r){ return r._uid === uid; });
    if(!rec) return;
    state.targetUid = uid;
    state.searchActive = false; state.searchMatches = {}; state.searchJustRan = false;
    var box = $("map-suggest"); if(box){ box.style.display = "none"; box.innerHTML = ""; }
    var s = $("map-search"); if(s) s.value = rec.name;
    state.mapQuery = rec.name;
    placeMarkers();                 // 重建标记：目标标红，其余保持原样
    if(rec.lng != null && state.amap){
      try { state.amap.setZoomAndCenter(16, [rec.lng, rec.lat]); }
      catch(e){ state.amap.setCenter([rec.lng, rec.lat]); }
    }
    blinkTarget();
    updateSidePanel();
  }
  // 目标标记闪烁约 3 秒（动画类自动移除；红色高亮 .target 持续保留）
  function blinkTarget(){
    var uid = state.targetUid; if(!uid) return;
    var el = document.querySelector('.mk-dot[data-uid="'+uid+'"]');
    if(!el) return;
    el.classList.remove("blink");
    void el.offsetWidth;            // 强制重排以重置动画
    el.classList.add("blink");
    setTimeout(function(){ if(el) el.classList.remove("blink"); }, 3000);
  }
  // 周围单位列表单击：地图上对应标记变橙 + 跳动 2 秒，之后自动恢复原样（不改变目标）
  function flashNearbyMarker(uid){
    var rec = state.data.find(function(r){ return r._uid === uid; });
    if(!rec) return;
    if(rec.lng == null || rec.lat == null){
      toast("「"+(rec.name||"该单位")+"」暂无坐标，无法在地图上定位", "warn");
      return;
    }
    var el = document.querySelector('.mk-dot[data-uid="'+uid+'"]');
    if(!el){
      toast("该单位未在地图上显示，可先点「🔄 地理编码全部」", "warn");
      return;
    }
    // 若标记不在当前视野内，先把地图移到它身上，保证能看到跳动
    try{
      var b = state.amap && state.amap.getBounds ? state.amap.getBounds() : null;
      if(b && b.contains && !b.contains([rec.lng, rec.lat])) state.amap.setCenter([rec.lng, rec.lat]);
    }catch(e){}
    el.classList.remove("orange","bounce2");
    void el.offsetWidth;                       // 强制重排，重置动画
    el.classList.add("orange","bounce2");
    var item = document.querySelector('.nearby-item[data-uid="'+uid+'"]');
    if(item) item.classList.add("flash");
    if(state._flashTimer) clearTimeout(state._flashTimer);
    state._flashTimer = setTimeout(function(){  // 2 秒后恢复（0.5s × 4）
      var e2 = document.querySelector('.mk-dot[data-uid="'+uid+'"]');
      if(e2) e2.classList.remove("orange","bounce2");
      var it2 = document.querySelector('.nearby-item[data-uid="'+uid+'"]');
      if(it2) it2.classList.remove("flash");
      state._flashTimer = null;
    }, 2000);
  }
  // 周围单位列表双击：把该单位切换为目标单位（同心圆随之移动到它身上）
  function nearbyItemDouble(uid){
    var now = Date.now();
    if(now - state._nbDblTs < 500) return;     // click 路径与 dblclick 路径去重
    state._nbDblTs = now;
    if(state._nbTimer){ clearTimeout(state._nbTimer); state._nbTimer = null; }
    state._nbUid = null; state._nbTs = 0;
    selectTarget(uid);
  }
  // 球面距离（米），用于“周围单位”
  function haversine(lng1, lat1, lng2, lat2){
    var R = 6371000, toR = Math.PI/180;
    var dLat = (lat2-lat1)*toR, dLng = (lng2-lng1)*toR;
    var a = Math.sin(dLat/2)*Math.sin(dLat/2) +
            Math.cos(lat1*toR)*Math.cos(lat2*toR)*Math.sin(dLng/2)*Math.sin(dLng/2);
    return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
  }
  // 以目标为中心，只画【当前选定/自定义】的那一个距离圆（不再叠加显示全部半径）
  function drawTargetCircles(activeRadius){
    if(state.targetCircles && state.targetCircles.length){
      state.targetCircles.forEach(function(c){ try{ c.setMap(null); }catch(e){} });
    }
    state.targetCircles = [];
    var target = state.data.find(function(r){ return r._uid === state.targetUid; });
    if(!target || target.lng == null || target.lat == null || !state.amap) return;
    var rd = parseFloat(activeRadius);
    if(!rd || rd <= 0) rd = 200;                  // 兜底：半径非法时按 200m
    var circle = new window.AMap.Circle({
      center:[target.lng, target.lat],
      radius: rd,
      strokeColor:"#e5484d",
      strokeOpacity:0.8,
      strokeWeight:1.5,          // 描边细一些（原为 3）
      fillColor:"#e5484d",
      fillOpacity:0.08,
      zIndex:6
    });
    circle.setMap(state.amap);
    // 点击距离圈（目标单位以外的区域）→ 取消目标选中，清除距离圆
    circle.on("click", function(e){
      if(e && e.originEvent && e.originEvent.stopPropagation) e.originEvent.stopPropagation();
      clearTarget();
    });
    state.targetCircles.push(circle);
  }
  // 按半径渲染目标周围单位清单（点击半径 tab / 自定义距离触发），并在地图上画出对应半径的圆
  function showNearby(radius){
    state.targetRadius = radius;
    drawTargetCircles(radius);     // 先画/更新距离圆（含清理旧圆；无坐标则清空）
    var tabs = $("radius-tabs");   // 同步快捷选择高亮：自定义半径时无 tab 高亮
    if(tabs) Array.prototype.forEach.call(tabs.children, function(b){
      b.classList.toggle("active", parseInt(b.getAttribute("data-r"), 10) === radius);
    });
    var rl = $("nearby-radius-label"); if(rl) rl.textContent = radius + "m";
    var list = $("nearby-list"); if(!list) return;
    var target = state.data.find(function(r){ return r._uid === state.targetUid; });
    if(!target || target.lng == null || target.lat == null){
      list.innerHTML = '<div class="nearby-empty">目标单位暂无坐标，无法计算周边（可先点「🔄 地理编码全部」或「📍 手动选点」）。</div>';
      return;
    }
    var items = [];
    state.data.forEach(function(r){
      if(r._uid === target._uid) return;
      if(r.lng == null || r.lat == null) return;
      var d = haversine(target.lng, target.lat, r.lng, r.lat);
      if(d <= radius) items.push({ rec:r, dist:d });
    });
    items.sort(function(a,b){ return a.dist - b.dist; });
    if(!items.length){
      list.innerHTML = '<div class="nearby-empty">'+radius+'m 范围内没有其他已编码单位。</div>';
      return;
    }
    list.innerHTML = items.map(function(it){
      var r = it.rec;
      return '<div class="nearby-item" data-uid="'+r._uid+'">'+
        '<span class="ni-dist">'+it.dist+'m</span>'+
        '<div class="ni-name">'+esc(r.name)+'</div>'+
        '<div class="ni-sub">'+(r.license ? esc(r.license)+' ｜ ' : '')+esc(r.address||'')+'</div>'+
      '</div>';
    }).join("");
  }
  // 右侧目标卡片 + 显示周边面板
  function updateSidePanel(){
    var card = $("target-card"); if(!card) return;
    var rec = state.data.find(function(r){ return r._uid === state.targetUid; });
    if(!rec){
      card.innerHTML = '<div class="target-empty">在上方搜索框输入关键词，点击候选单位即可将其设为<strong>目标单位</strong>：地图标记变红并闪烁 3 秒，右侧显示其周边单位。<br><br>提示：单击地图上的圆点 = 设为目标；<strong>双击圆点 = 查看单位详情</strong>；点击地图空白处或距离圈 = 取消。</div>';
      var nb0 = $("nearby-block"); if(nb0) nb0.style.display = "none";
      return;
    }
    function row(label, val){
      return '<div class="tc-row"><b>'+label+'：</b>'+(val ? esc(val) : '<span style="color:#9aa1ae">未填写</span>')+'</div>';
    }
    card.innerHTML =
      '<div class="tc-name">'+esc(rec.name)+'</div>'+
      row("许可证号", rec.license)+
      row("街道", rec.street)+
      row("经营地址", rec.address)+
      row("设备类型", rec.deviceType)+
      row("联系人", rec.contact)+
      ((rec.validFrom || rec.validTo) ? '<div class="tc-row"><b>有效期：</b>'+esc(rec.validFrom||'')+' 至 '+esc(rec.validTo||'')+'</div>' : '')+
      (rec.remark ? '<div class="tc-row tc-remark"><b>备注：</b>'+esc(rec.remark)+'</div>'
                  : '<div class="tc-row"><b>备注：</b><span style="color:#9aa1ae">未填写</span></div>')+
      (rec.lng != null ? '<div class="tc-row"><b>坐标：</b>'+rec.lng.toFixed(6)+', '+rec.lat.toFixed(6)+'</div>'
                       : '<div class="tc-row">坐标：暂无（未编码）</div>')+
      '<div class="tc-actions">'+
        '<button id="tc-edit" class="btn sm primary">✏️ 编辑</button>'+
        (rec.lng == null ? '<button id="tc-locate" class="btn sm">📍 手动定位</button>' : '')+
        '<button id="tc-detail" class="btn sm">单位详情</button>'+
        '<button id="tc-clear" class="btn sm">清除目标</button>'+
      '</div>';
    var editBtn = $("tc-edit");   if(editBtn)   editBtn.addEventListener("click", function(){ openDetail(rec._uid); });
    var locBtn  = $("tc-locate"); if(locBtn)    locBtn.addEventListener("click", function(){ startManualLocate(rec._uid); });
    var detBtn  = $("tc-detail"); if(detBtn)    detBtn.addEventListener("click", function(){ openDetail(rec._uid); });
    var clrBtn  = $("tc-clear");  if(clrBtn)    clrBtn.addEventListener("click", function(){ clearTarget(); });
    var nb = $("nearby-block"); if(nb) nb.style.display = "flex";
    var r = state.targetRadius || 200;
    var cus = $("nearby-custom");
    if(cus) cus.value = ([200,300,500,800].indexOf(r) === -1) ? String(r) : "";
    showNearby(r);
  }
  /* ---------------- 未编码单位面板（地图右侧） ----------------
   * 未编码单位没有坐标，所以**不会出现在地图上**（placeMarkers 会跳过它们）。
   * 之前的问题：既然不上地图，就没有任何入口给它们补坐标 —— 只能靠「🔄 地理编码全部」
   * 按地址批量编码，地址写得不准就永远补不上。
   * 现在在这里列出它们：点一条 → 进入选点模式 → 在地图上点实际位置
   * → 反查地址并写入坐标 → 它立刻变成地图上的一个点，并从本列表消失。
   */
  function unlocatedList(){
    return state.data.filter(function(r){ return r.lng == null || r.lat == null; });
  }
  function renderUnlocated(){
    var box = $("unloc-list");
    var all = unlocatedList();
    var cnt = $("unloc-count");
    if(cnt) cnt.textContent = String(all.length);
    if(!box) return;
    var q = (state.unlocQuery || "").trim().toLowerCase();
    var list = all;
    if(q){
      list = all.filter(function(r){
        return (r.id+" "+r.name+" "+(r.street||"")+" "+r.address+" "+(r.license||"")).toLowerCase().indexOf(q) >= 0;
      });
    }
    if(!list.length){
      box.innerHTML = '<div class="unloc-empty">' +
        (all.length ? ("没有匹配「"+esc(state.unlocQuery)+"」的未编码单位") : "全部单位都已有坐标 🎉") + '</div>';
      return;
    }
    box.innerHTML = list.map(function(r){
      return '<div class="unloc-item'+(state.pickTarget === r._uid ? " active" : "")+'" data-uid="'+r._uid+'">' +
        '<div class="ul-name">'+esc(r.name)+'</div>' +
        '<div class="ul-sub">'+esc(r.street||"—")+' ｜ '+esc(r.address||"（无地址）")+' ｜ '+esc(r.license)+'</div>' +
      '</div>';
    }).join("");
  }
  // 给某个未编码单位手动定位：进入选点模式，等用户在地图上点位置
  function startManualLocate(uid){
    var rec = state.data.find(function(r){ return r._uid === uid; });
    if(!rec) return;
    if(!state.amapReady){ toast("请先配置高德地图密钥", "warn"); return; }
    state.pickMode = true;
    state.pickTarget = uid;
    var el = $("amap-container"); if(el) el.classList.add("pick-on");
    showMapHint("正在为「"+rec.name+"」手动定位：请在地图上点击它的实际位置（Esc 取消）");
    renderUnlocated();
  }
  // 从台账/其它视图跳过来：先切到地图视图，等地图就绪再进入选点模式
  function goManualLocate(uid){
    var rec = state.data.find(function(r){ return r._uid === uid; });
    if(!rec){ return; }
    if(state.view !== "map") switchView("map");
    var tries = 0;
    (function wait(){
      if(state.amapReady && state.amap){ startManualLocate(uid); return; }
      if(++tries > 40){
        toast("地图尚未就绪，请到地图界面右侧的「未编码单位」里点选", "warn");
        return;
      }
      setTimeout(wait, 150);
    })();
  }

  /* ---------------- 地图手动选点（在主地图操作，不嵌套弹窗） ---------------- */
  function enterPickMode(){
    if(!state.amapReady){ toast("请先配置高德地图密钥", "warn"); return; }
    state.pickMode = true;
    state.pickTarget = null;
    var el = $("amap-container"); if(el) el.classList.add("pick-on");
    showMapHint("手动选点模式：点右侧「未编码单位」里的某一条，或点地图上的蓝色圆点选中单位，然后在地图上点击它的实际位置（Esc 取消）");
    renderUnlocated();
  }
  function exitPickMode(){
    state.pickMode = false;
    state.pickTarget = null;
    var el = $("amap-container"); if(el) el.classList.remove("pick-on");
    hideMapHint();
    renderUnlocated();     // 清掉列表里的选中高亮
  }
  function pickMarkerChosen(uid){
    var rec = state.data.find(function(r){ return r._uid === uid; });
    if(!rec) return;
    state.pickTarget = uid;
    showMapHint("已选择「"+rec.name+"」：请在地图上点击任意位置以更新其地址与坐标（Esc 取消）");
  }
  // 点击空白地图区域 / 距离圈：取消目标选中（清空红色高亮、距离圆与右侧面板）
  function clearTarget(){
    cancelPendingTargetClick();
    state._markerClickTs = 0;
    if(!state.targetUid){
      // 目标已为空，但保险起见再清一次残留圆
      if(state.targetCircles && state.targetCircles.length){
        state.targetCircles.forEach(function(c){ try{ c.setMap(null); }catch(e){} });
        state.targetCircles = [];
      }
      return;
    }
    state.targetUid = null;
    if(state.targetCircles && state.targetCircles.length){
      state.targetCircles.forEach(function(c){ try{ c.setMap(null); }catch(e){} });
    }
    state.targetCircles = [];
    placeMarkers();
    updateSidePanel();
  }
  // 周围单位：自定义距离（米）应用
  function applyCustomRadius(){
    var el = $("nearby-custom"); if(!el) return;
    var v = parseFloat(el.value);
    if(!v || v <= 0){ toast("请输入有效的距离（米），如 350", "warn"); el.focus(); return; }
    if(v > 5000){ v = 5000; el.value = "5000"; toast("自定义距离上限 5000m，已按 5000m 计算", "warn"); }
    v = Math.round(v);
    el.value = String(v);
    showNearby(v);
    toast("周围单位范围已设为 "+v+"m", "ok");
  }
  function onMapClick(e){
    if(state.pickMode){
      if(!state.pickTarget) return;   // 需先点选单位标记
      var lng = e.lnglat.getLng(), lat = e.lnglat.getLat();
      var rec = state.data.find(function(r){ return r._uid === state.pickTarget; });
      exitPickMode();
      if(rec){ reverseGeocode(lng, lat, rec); }
      return;
    }
    // 非选点模式：
    // ① 若事件来自覆盖物（标记 / 距离圆，带 setMap 方法），交给覆盖物自己的处理器，不在此清空
    if(e && e.target && e.target !== state.amap && typeof e.target.setMap === "function") return;
    // ② 刚点过标记（同一次点击冒泡到地图）时忽略，避免“刚选中就被清空”
    if(state._markerClickTs && Date.now() - state._markerClickTs < 300) return;
    // ③ 其余情况（点击目标单位以外的任意区域）→ 取消目标选中并清除距离圆
    clearTarget();
  }
  function showMapHint(msg){
    var h = $("map-hint");
    if(h){ h.textContent = msg; h.style.display = "block"; }
  }
  function hideMapHint(){
    var h = $("map-hint");
    if(h){ h.style.display = "none"; }
  }
  var searchTimer = null;
  function onSearchInput(){
    var q = $("map-search").value.trim();
    if(searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function(){ renderSuggest(q); }, 200);
  }
  // 边输入边弹出候选项
  function renderSuggest(q){
    var box = $("map-suggest");
    if(!box) return;
    q = q.trim().toLowerCase();
    if(!q){ box.style.display = "none"; box.innerHTML = ""; return; }
    var matches = state.data.filter(function(r){
      return (r.name + r.address + r.license).toLowerCase().indexOf(q) >= 0;
    }).slice(0, 12);
    if(!matches.length){ box.style.display = "none"; box.innerHTML = ""; return; }
    box.innerHTML = matches.map(function(r){
      return '<div class="suggest-item" data-uid="'+r._uid+'">'+
        '<div class="si-name">'+esc(r.name)+'</div>'+
        (r.license ? '<div class="si-lic">许可证号：'+esc(r.license)+'</div>' : '')+
        (r.address ? '<div class="si-addr">地址：'+esc(r.address)+'</div>' : '')+
      '</div>';
    }).join("");
    box.style.display = "block";
  }
  function geocodeOne(rec){
    return new Promise(function(resolve){
      if(!state.geocoder || !rec.address){ resolve(null); return; }
      var done = false;
      // 超时保护：若高德回调未触发（限流/网络抖动），避免整批卡死
      var timer = setTimeout(function(){ if(!done){ done = true; resolve(null); } }, 5000);
      state.geocoder.getLocation(rec.address, function(status, result){
        if(done) return;
        done = true; clearTimeout(timer);
        if(status === "complete" && result.geocodes && result.geocodes.length){
          var loc = result.geocodes[0].location;
          resolve({ lng:loc.lng, lat:loc.lat });
        } else {
          resolve(null);
        }
      });
    });
  }
  // 批量地理编码：放慢节奏避免限流，失败重试退避；逐条成功即落盘；可回调进度
  async function geocodeMany(list, onProgress){
    if(!state.amapReady){ return; }
    var stepDelay = 350;   // ~3 QPS，远低于免费密钥限流阈值
    var done = 0, okCount = 0;
    for(var i=0;i<list.length;i++){
      var rec = list[i];
      if(!rec.address) continue;
      if(rec.lng!=null && rec.lat!=null) continue;
      var ok = false;
      for(var attempt=0; attempt<3 && !ok; attempt++){
        var g = await geocodeOne(rec);
        if(g){ rec.lng = g.lng; rec.lat = g.lat; ok = true; }
        else { await sleep(600 * (attempt + 1)); } // 退避重试
      }
      done++; if(ok) okCount++;
      saveDataLocal();                 // 每成功一条立即持久化，绝不丢失已编码结果
      if(onProgress) onProgress(done, list.length, ok);
      await sleep(stepDelay);
    }
    saveDataLocal();
    return okCount;
  }
  var geoRunning = false;
  function geocodeMissing(){
    if(!state.amapReady){ toast("请先配置高德地图密钥", "warn"); return; }
    if(geoRunning) return;
    var missing = state.data.filter(function(r){ return (r.lng==null || r.lat==null) && r.address; });
    if(!missing.length){ toast("全部记录已有坐标", "ok"); return; }
    geoRunning = true;
    toast("正在地理编码 " + missing.length + " 条地址…", "ok");
    geocodeMany(missing, function(done, total, ok){
      if(state.view === "map"){ placeMarkers(); renderUnlocated(); }   // 边编码边在地图上打点
    }).then(function(okCount){
      geoRunning = false;
      if(state.view === "map"){ placeMarkers(); renderUnlocated(); }
      toast("地理编码完成：成功 " + okCount + " / " + missing.length + " 条", "ok");
    });
  }
  function reverseGeocode(lng, lat, rec){
    function done(){
      commit({silent:true});
      refreshIfMap();
      renderUnlocated();        // 已编码 → 从「未编码单位」面板消失
      updateSidePanel();        // 目标卡片里的坐标/周边随之刷新
    }
    if(!state.geocoder){ rec.lng=lng; rec.lat=lat; done(); return; }
    state.geocoder.getAddress([lng, lat], function(status, result){
      var addr = "";
      if(status === "complete" && result.regeocode){
        addr = result.regeocode.formattedAddress;
      }
      rec.address = addr;
      rec.lng = lng; rec.lat = lat;
      var dAddr = $("detail-address");
      if(dAddr) dAddr.textContent = addr || (lng.toFixed(6)+", "+lat.toFixed(6));
      done();
      toast("已更新地址与坐标：" + (addr || (lng.toFixed(6)+", "+lat.toFixed(6))), "ok");
    });
  }

  /* ---------------- Toast ---------------- */
  function toast(msg, type){
    var wrap = $("toast-wrap");
    var t = document.createElement("div");
    t.className = "toast" + (type ? " "+type : "");
    t.textContent = msg;
    wrap.appendChild(t);
    requestAnimationFrame(function(){ t.classList.add("show"); });
    setTimeout(function(){ t.classList.remove("show"); setTimeout(function(){ t.remove(); }, 300); }, 2600);
  }

  /* ---------------- 弹窗 ---------------- */
  function closeModal(){
    var o = $("modal-overlay");
    if(o) o.remove();
  }
  function showModal(html){
    closeModal();
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "modal-overlay";
    overlay.innerHTML = '<div class="modal">' + html + '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function(e){
      if(e.target === overlay) closeModal();
    });
    return overlay;
  }

  /* ---------------- 单位详情弹窗（全局统一） ---------------- */
  function openDetail(u){
    var rec = state.data.find(function(r){ return r._uid === u; });
    if(!rec) return;
    var du = daysUntil(rec.validTo);
    var duHtml = du==null ? '<span class="pill gray">无日期</span>'
      : (du < 0 ? '<span class="pill red">已逾期 '+Math.abs(du)+' 天</span>'
      : (du <= 30 ? '<span class="pill amber">剩 '+du+' 天</span>' : '<span class="pill green">剩 '+du+' 天</span>'));
    var html =
      '<div class="modal-head"><h3>单位详情</h3><button class="x" onclick="window.__wb.closeModal()">×</button></div>' +
      '<div class="modal-body">' +
        '<div class="kv"><span>编号</span><b>'+esc(rec.id)+'</b></div>' +
        '<div class="kv"><span>单位名称</span><b>'+esc(rec.name)+'</b></div>' +
        '<div class="kv"><span>街道</span><b>'+esc(rec.street||"")+'</b></div>' +
        '<div class="kv"><span>经营地址</span><b id="detail-address">'+esc(rec.address)+'</b></div>' +
        '<div class="kv"><span>卫生许可证号</span><b>'+esc(rec.license)+'</b></div>' +
        '<div class="kv"><span>有效期始</span><b>'+esc(rec.validFrom)+'</b></div>' +
        '<div class="kv"><span>有效期止</span><b>'+esc(rec.validTo)+' '+duHtml+'</b></div>' +
        '<div class="kv"><span>设备类型</span><b>'+esc(rec.deviceType||"")+'</b></div>' +
        '<div class="kv"><span>联系人</span><b>'+esc(rec.contact||"")+'</b></div>' +
        '<div class="kv"><span>坐标</span><b>'+esc(coordText(rec))+'</b></div>' +
        '<div class="kv"><span>备注</span><b class="remark-text">'+esc(rec.remark||"")+'</b></div>' +
        '<div class="actions">' +
          '<button class="btn primary" id="detail-edit">编辑</button>' +
        '</div>' +
      '</div>';
    showModal(html);
    $("detail-edit").onclick = function(){ openEdit(rec._uid); };
  }

  /* ---------------- 编辑弹窗（可修改全部字段） ---------------- */
  function openEdit(u){
    var rec = state.data.find(function(r){ return r._uid === u; });
    if(!rec) return;
    var html =
      '<div class="modal-head"><h3>编辑单位</h3><button class="x" onclick="window.__wb.closeModal()">×</button></div>' +
      '<div class="modal-body">' +
        '<div class="editgrid">' +
          '<label class="fld">编号<input type="text" id="e-id" value="'+esc(rec.id)+'"></label>' +
          '<label class="fld">单位名称<input type="text" id="e-name" value="'+esc(rec.name)+'"></label>' +
          '<label class="fld">街道<input type="text" id="e-street" value="'+esc(rec.street||"")+'" placeholder="如 和平里街道"></label>' +
          '<label class="fld">经营地址<input type="text" id="e-address" value="'+esc(rec.address)+'"></label>' +
          '<label class="fld">卫生许可证号<input type="text" id="e-license" value="'+esc(rec.license)+'"></label>' +
          '<label class="fld">有效期始<input type="date" id="e-from" value="'+esc(rec.validFrom)+'"></label>' +
          '<label class="fld">有效期止<input type="date" id="e-to" value="'+esc(rec.validTo)+'"></label>' +
          '<label class="fld">设备类型<input type="text" id="e-device-type" value="'+esc(rec.deviceType||"")+'" placeholder="如 二次供水 / 直饮水"></label>' +
          '<label class="fld">联系人<input type="text" id="e-contact" value="'+esc(rec.contact||"")+'" placeholder="如 张三 13800138000"></label>' +
        '</div>' +
        '<label class="fld" style="margin-top:12px"><span>备注</span>' +
          '<textarea id="e-remark" rows="3" style="width:100%;resize:vertical;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:9px">'+esc(rec.remark||"")+'</textarea>' +
        '</label>' +
        '<div class="actions">' +
          '<button class="btn" onclick="window.__wb.closeModal()">取消</button>' +
          '<button class="btn primary" id="e-save">保存</button>' +
        '</div>' +
      '</div>';
    showModal(html);
    $("e-save").onclick = function(){
      var newAddr = $("e-address").value.trim();
      rec.id = $("e-id").value.trim();
      rec.name = $("e-name").value.trim();
      rec.street = $("e-street").value.trim();
      rec.address = newAddr;
      rec.license = $("e-license").value.trim();
      rec.validFrom = $("e-from").value;
      rec.validTo = $("e-to").value;
      rec.remark = $("e-remark").value;
      rec.deviceType = $("e-device-type") ? $("e-device-type").value.trim() : (rec.deviceType||"");
      rec.contact = $("e-contact") ? $("e-contact").value.trim() : (rec.contact||"");
      commit();          // 立即落盘 + 立即与云端对齐
      refreshIfMap();
      renderCurrentView();
      closeModal();
      toast("已保存修改", "ok");
    };
  }

  /* ---------------- 首页：到期提醒 + 办结 ---------------- */
  function renderHome(){
    var win = state.homeWindow;
    var list = state.data.map(function(r){ return { r:r, days:daysUntil(r.validTo) }; })
      .filter(function(x){ return x.days !== null; });
    var overdue = list.filter(function(x){ return x.days < 0; }).sort(function(a,b){ return a.days - b.days; });
    var upcoming = list.filter(function(x){
      if(win === "all") return x.days >= 0;
      return x.days >= 0 && x.days <= Number(win);
    }).sort(function(a,b){ return a.days - b.days; });

    function card(x){
      var r = x.r;
      var pill = x.days < 0 ? '<span class="pill red">已逾期 '+Math.abs(x.days)+' 天</span>'
        : (x.days <= 30 ? '<span class="pill amber">剩 '+x.days+' 天</span>' : '<span class="pill green">剩 '+x.days+' 天</span>');
      return '<div class="reminder" data-action="detail" data-uid="'+r._uid+'">' +
        '<div class="main">' +
          '<div class="nm">'+esc(r.name)+'</div>' +
          '<div class="sub">'+esc(r.address)+' ｜ '+esc(r.license)+' ｜ 有效期止 '+esc(r.validTo)+'</div>' +
        '</div>' +
        '<div class="right">'+pill+
          '<button class="btn primary sm" data-action="banjie" data-uid="'+r._uid+'">办结</button>' +
        '</div>' +
      '</div>';
    }
    var html = "";
    if(overdue.length){
      html += '<div class="grp-title">⚠️ 已过期（'+overdue.length+'）</div>';
      html += overdue.map(card).join("");
    }
    html += '<div class="grp-title">'+(win==="all"?"即将到期":"未来 "+win+" 天内即将到期")+'（'+upcoming.length+'）</div>';
    if(upcoming.length){
      html += upcoming.map(card).join("");
    } else {
      html += '<div class="empty">该时间范围内没有即将到期的单位 🎉</div>';
    }
    $("home-list").innerHTML = html;
    renderOverdue();
  }

  /* ---------------- 首页：已过期单位（独立区块） ----------------
   * 与上方「到期提醒」里的已过期分组是同一批数据（按需求两处都保留）。
   * 区别：这里不做时间窗筛选，**列出全部已过期单位**，按逾期天数从多到少排，
   * 并支持搜索与单独导出，便于集中清理。
   */
  function overdueList(){
    return state.data.map(function(r){ return { r:r, days:daysUntil(r.validTo) }; })
      .filter(function(x){ return x.days !== null && x.days < 0; })
      .sort(function(a,b){ return a.days - b.days; });   // 逾期最久的排最前
  }
  function renderOverdue(){
    var box = $("overdue-list");
    var all = overdueList();
    var cnt = $("overdue-count");
    if(cnt) cnt.textContent = String(all.length);
    var q = (state.overdueQuery || "").trim().toLowerCase();
    var list = all;
    if(q){
      list = all.filter(function(x){
        var r = x.r;
        return (r.id+" "+r.name+" "+(r.street||"")+" "+r.address+" "+(r.license||"")).toLowerCase().indexOf(q) >= 0;
      });
    }
    var hint = $("overdue-hint");
    if(hint){
      hint.textContent = all.length
        ? ("共 " + all.length + " 家单位卫生许可证已过期" + (q ? "，当前筛选出 " + list.length + " 家" : "") + "；按逾期天数从多到少排列。")
        : "没有已过期的单位 🎉";
    }
    if(!box) return;
    if(!list.length){
      box.innerHTML = '<div class="empty">' +
        (all.length ? ("没有匹配「"+esc(state.overdueQuery)+"」的已过期单位") : "没有已过期的单位 🎉") + '</div>';
      return;
    }
    box.innerHTML = list.map(function(x){
      var r = x.r, od = Math.abs(x.days);
      return '<div class="overdue-row" data-action="detail" data-uid="'+r._uid+'">' +
        '<div class="main">' +
          '<div class="nm">'+esc(r.name)+'</div>' +
          '<div class="sub">'+esc(r.street||"—")+' ｜ '+esc(r.address)+' ｜ '+esc(r.license)+' ｜ 有效期止 '+esc(r.validTo)+'</div>' +
        '</div>' +
        '<div class="right">' +
          '<span class="od-days">已逾期 '+od+' 天</span>' +
          '<button class="btn primary sm" data-action="banjie" data-uid="'+r._uid+'">办结</button>' +
        '</div>' +
      '</div>';
    }).join("");
  }

  function doBanjie(u){
    var rec = state.data.find(function(r){ return r._uid === u; });
    if(!rec) return;
    var today = iso(new Date());
    var html =
      '<div class="modal-head"><h3>办结 — '+esc(rec.name)+'</h3><button class="x" onclick="window.__wb.closeModal()">×</button></div>' +
      '<div class="modal-body">' +
        '<label class="fld">选择新的「有效期始」日期<input type="date" id="bj-date" value="'+today+'"></label>' +
        '<p class="hint" style="margin-top:12px">系统将自动计算：<b>有效期止 = 所选日期 + 4 年 - 1 天</b></p>' +
        '<div class="kv" style="margin-top:8px"><span>将更新为</span><b id="bj-preview">—</b></div>' +
        '<div class="actions">' +
          '<button class="btn" onclick="window.__wb.closeModal()">取消</button>' +
          '<button class="btn primary" id="bj-save">确认办结</button>' +
        '</div>' +
      '</div>';
    showModal(html);
    function preview(){
      var d = $("bj-date").value;
      $("bj-preview").textContent = d ? (d + "  ~  " + calcValidTo(d)) : "—";
    }
    $("bj-date").addEventListener("change", preview);
    preview();
    $("bj-save").onclick = function(){
      var d = $("bj-date").value;
      if(!d){ toast("请选择日期", "warn"); return; }
      rec.validFrom = d;
      rec.validTo = calcValidTo(d);
      commit();          // 立即落盘 + 立即与云端对齐
      renderCurrentView();
      closeModal();
      toast("已办结：" + rec.name + " 有效期更新至 " + rec.validTo, "ok");
    };
  }

  /* ---------------- 台账 ---------------- */
  function renderLedger(){
    var body = $("ledger-body");
    var q = (state.ledgerQuery||"").trim().toLowerCase();
    var rows = state.data;
    if(q){
      rows = rows.filter(function(r){
        return (r.id+" "+r.name+" "+(r.street||"")+" "+r.address+" "+(r.deviceType||"")+" "+(r.contact||"")+" "+r.license).toLowerCase().indexOf(q) >= 0;
      });
    }
    if(!rows.length){
      body.innerHTML = '<tr><td colspan="12" class="empty">'+(q?"没有匹配「"+esc(state.ledgerQuery)+"」的单位":"暂无数据，请在上方手动新增或导入。")+'</td></tr>';
    } else {
      body.innerHTML = rows.map(function(r){
        return '<tr data-action="detail" data-uid="'+r._uid+'">' +
          '<td><input type="checkbox" class="rowsel row-select" data-uid="'+r._uid+'" '+(state.selected[r._uid]?"checked":"")+'></td>' +
          '<td class="id-cell">'+esc(r.id)+'</td>' +
          '<td class="name-cell" title="'+esc(r.name)+'">'+esc(r.name)+'</td>' +
          '<td class="street-cell" title="'+esc(r.street||"")+'">'+esc(r.street||"")+'</td>' +
          '<td class="addr" title="'+esc(r.address)+'">'+esc(r.address)+'</td>' +
          '<td class="dev-cell" title="'+esc(r.deviceType||"")+'">'+esc(r.deviceType||"")+'</td>' +
          '<td class="dev-cell" title="'+esc(r.contact||"")+'">'+esc(r.contact||"")+'</td>' +
          '<td class="remark-cell" title="'+esc(r.remark||"")+'">'+esc(r.remark||"")+'</td>' +
          '<td class="lic-cell" title="'+esc(r.license)+'">'+esc(r.license)+'</td>' +
          '<td class="date-cell">'+esc(r.validFrom)+'</td>' +
          '<td class="date-cell">'+esc(r.validTo)+'</td>' +
          '<td class="coord-cell">' +
            ((r.lng == null || r.lat == null)
              ? '<span class="coord-none">未编码</span><button class="locate-btn" data-action="locate" data-uid="'+r._uid+'" title="切到地图并手动点选位置">📍定位</button>'
              : esc(coordText(r))) +
          '</td>' +
        '</tr>';
      }).join("");
    }
    updateStat();
    updateLedgerHint();
  }
  function updateLedgerHint(){
    var n = Object.keys(state.selected).filter(function(k){ return state.selected[k]; }).length;
    $("ledger-hint").textContent = n ? ("已选中 "+n+" 条，可批量删除") : "";
  }

  function addManual(){
    var name = $("add-name").value.trim();
    var license = $("add-license").value.trim();
    if(!name){ toast("请填写单位名称", "warn"); return; }
    var exist = state.data.find(function(r){ return r.license === license; });
    if(exist){ toast("该卫生许可证号已存在，请使用导入以覆盖更新", "warn"); return; }
    var rec = {
      _uid: uid(),
      id: $("add-id").value.trim() || nextId(),
      name: name,
      street: $("add-street") ? $("add-street").value.trim() : "",
      address: $("add-address").value.trim(),
      license: license,
      validFrom: $("add-from").value,
      validTo: $("add-to").value,
      remark: $("add-remark") ? $("add-remark").value.trim() : "",
      deviceType: $("add-device-type") ? $("add-device-type").value.trim() : "",
      contact: $("add-contact") ? $("add-contact").value.trim() : "",
      lng: null, lat: null
    };
    state.data.push(rec);
    saveData(false);
    syncNow({silent:true});   // 立即与云端对齐，不再依赖地理编码结果
    ensureAmap()
      .then(function(){ return geocodeMany([rec]); })
      .catch(function(){ /* 编码失败不影响已新增的数据 */ })
      .then(function(){
        saveData(); renderLedger(); if(state.view==="map") placeMarkers();
      });
    clearAddForm();
    renderLedger();
    toast("已添加单位：" + name, "ok");
  }
  function clearAddForm(){
    ["add-id","add-name","add-street","add-address","add-license","add-from","add-to","add-device-type","add-contact"]
      .forEach(function(id){ if($(id)) $(id).value=""; });
    if($("add-remark")) $("add-remark").value="";
  }

  function importExcel(file){
    if(!window.XLSX){ toast("表格解析库未加载，请检查网络后重试", "err"); return; }
    var reader = new FileReader();
    reader.onload = function(e){
      try{
        var wb = window.XLSX.read(e.target.result, { type:"array" });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = window.XLSX.utils.sheet_to_json(ws, { defval:"" });
        var added = 0, updated = 0, toGeocode = [];
        rows.forEach(function(row){
          var lic = String(row["卫生许可证号"]||"").trim();
          if(!lic) return;
          var name = String(row["单位名称"]||row["单位"]||"").trim();
          var street = String(row["街道"]||row["所属街道"]||"").trim();
          var address = String(row["经营地址"]||"").trim();
          var vf = normExcelDate(row["有效期始"]);
          var vt = normExcelDate(row["有效期止"]);
          var id = String(row["编号"]||"").trim();
          var remark = String(row["备注"]||"").trim();
          var deviceType = String(row["设备类型"]||row["设备类别"]||"").trim();
          var contact = String(row["联系人"]||"").trim();
          var exist = state.data.find(function(r){ return r.license === lic; });
          if(exist){
            // 存在相同许可证号 → 仅覆盖更新有效期始/止与补充信息
            if(vf) exist.validFrom = vf;
            if(vt) exist.validTo = vt;
            if(street) exist.street = street;
            if(remark) exist.remark = remark;
            if(deviceType) exist.deviceType = deviceType;
            if(contact) exist.contact = contact;
            updated++;
            if(exist.address && (exist.lng==null || exist.lat==null)) toGeocode.push(exist);
          } else {
            var rec = {
              _uid: uid(),
              id: id || nextId(),
              name: name,
              street: street,
              address: address,
              license: lic,
              validFrom: vf,
              validTo: vt,
              remark: remark,
              deviceType: deviceType,
              contact: contact,
              lng: null, lat: null
            };
            state.data.push(rec);
            added++;
            if(address) toGeocode.push(rec);
          }
        });
        // 先本地落盘；再【立刻】排一次云端上传。
        // 关键：不能把“保存”押在地理编码这条链上——编码耗时长、失败（高德密钥/域名白名单）、
        // 或编码途中刷新页面，都会导致 .then 里的 saveData() 永远不执行，
        // 新导入的数据就从未推上云端（表现为“导入后没保存，刷新就没了”）。
        saveData(false);
        syncNow({silent:true});   // 导入后立即与云端对齐，不等地理编码
        ensureAmap()
          .then(function(){ return geocodeMany(toGeocode); })
          .catch(function(){ /* 地理编码失败不影响已导入的数据 */ })
          .then(function(){
            // 无论编码成功与否，都要再落盘并同步一次（把坐标写回）
            saveData(); renderLedger(); if(state.view==="map") placeMarkers();
          });
        renderLedger();
        toast("导入完成：新增 "+added+" 条，覆盖更新 "+updated+" 条（已保存并同步）", "ok");
      }catch(err){
        toast("导入失败：" + (err.message||err), "err");
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function batchDelete(){
    var keys = Object.keys(state.selected).filter(function(k){ return state.selected[k]; });
    if(!keys.length){ toast("请先勾选要删除的记录", "warn"); return; }
    if(!confirm("确定删除选中的 "+keys.length+" 条记录？此操作不可撤销。")) return;
    state.data = state.data.filter(function(r){ return !state.selected[r._uid]; });
    keys.forEach(function(k){ delete state.selected[k]; });
    // 立即与云端对齐：syncNow 会依据 synced 标记把刚删掉的记录从云端删掉，
    // 否则云端残留会在刷新时被自动拉取“复活”
    commit();
    renderLedger();
    if(state.view==="map") placeMarkers();
    toast("已删除 "+keys.length+" 条", "ok");
  }

  function exportJson(){
    var blob = new Blob([JSON.stringify(state.data, null, 2)], { type:"application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "卫生许可台账_导出.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  // 把给定记录导出为 Excel（含设备类型/联系人）
  function exportRowsToXlsx(list, fileName){
    if(!window.XLSX){ toast("表格组件未加载，请检查网络后重试", "err"); return; }
    var rows = list.map(function(r){
      return {
        "编号": r.id || "",
        "单位名称": r.name || "",
        "街道": r.street || "",
        "经营地址": r.address || "",
        "设备类型": r.deviceType || "",
        "联系人": r.contact || "",
        "卫生许可证号": r.license || "",
        "有效期始": r.validFrom || "",
        "有效期止": r.validTo || "",
        "经度": (r.lng == null ? "" : r.lng),
        "纬度": (r.lat == null ? "" : r.lat),
        "备注": r.remark || ""
      };
    });
    var ws = window.XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{wch:8},{wch:28},{wch:14},{wch:30},{wch:14},{wch:16},{wch:22},{wch:12},{wch:12},{wch:12},{wch:12},{wch:24}];
    var wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "单位台账");
    var d = new Date();
    var stamp = d.getFullYear() + String(d.getMonth()+1).padStart(2,"0") + String(d.getDate()).padStart(2,"0");
    window.XLSX.writeFile(wb, fileName || ("单位台账_" + stamp + ".xlsx"));
    toast("已导出 " + rows.length + " 条到 Excel", "ok");
  }
  // 导出“所选”单位：勾了就导勾中的，没勾则询问是否导出全部
  function exportSelected(){
    var keys = Object.keys(state.selected).filter(function(k){ return state.selected[k]; });
    var list;
    if(keys.length){
      list = state.data.filter(function(r){ return state.selected[r._uid]; });
    } else {
      if(!confirm("未勾选任何单位。是否导出全部 " + state.data.length + " 条？")) return;
      list = state.data;
    }
    if(!list.length){ toast("没有可导出的单位", "warn"); return; }
    if(!window.XLSX){ toast("表格组件未加载，请检查网络后重试", "err"); return; }
    exportRowsToXlsx(list);
  }

  /* ---------------- 地图渲染 ---------------- */
  // 地图提示做成悬浮气泡（贴在地图左下角，不抢地图纵向空间），点击展开详情
  function setMapNote(head, full){
    var box = $("map-note-box");
    if(!head){
      box.innerHTML = "";
      return;
    }
    box.innerHTML =
      '<div class="map-note" onclick="this.classList.toggle(\'expanded\')">' +
        '<span class="note-head">' + head + '</span>' +
        (full ? '<div class="note-full">' + full + '</div>' : '') +
        '<span class="note-toggle">▾</span>' +
      '</div>';
  }

  function renderMapView(){
    renderUnlocated();     // 右侧「未编码单位」面板（不依赖地图是否加载成功）
    if(!state.settings.amapKey){
      setMapNote('⚠️ 未配置高德地图 Key',
        '尚未配置高德地图密钥。请前往「设置界面」填写 Key 与安全密钥后，地图与自动地理编码即可生效。');
      return;
    }
    setMapNote("", null);  // 清空，等地图加载回调再决定显示什么
    ensureAmap().then(function(ok){
      if(ok){
        initMap();
        // 回到地图视图时同步右侧面板（目标卡片 / 周围单位 / 距离圈高亮）
        if(state.targetUid) updateSidePanel();
        renderUnlocated();
        // 容器尺寸可能随布局变化（如从 block 改为 flex 子项），主动重算地图尺寸，避免空白
        try { if(state.amap && state.amap.resize) state.amap.resize(); } catch(e){}
        // 坐标已持久化（localStorage + 云集合），打开地图不再重新编码；
        // 仅提示尚未编码的地址：可点「🔄 地理编码全部」按地址批量编码，
        // 或在右侧「未编码单位」里逐条手动点选位置。
        var missing = state.data.filter(function(r){ return (r.lng==null || r.lat==null) && r.address; });
        if(missing.length){
          setMapNote('💡 ' + missing.length + ' 条地址待编码',
            '这些单位还没有坐标，不会出现在地图上。可点「🔄 地理编码全部」按地址批量编码，或在右侧「未编码单位」里点一条、再点地图上的实际位置来手动定位。');
        } else {
          setMapNote("", null);
        }
      } else {
        setMapNote('⚠️ 地图加载失败', '高德地图加载失败，请检查密钥与网络。');
      }
    });
  }

  function refreshIfMap(){ if(state.view === "map" && state.amap) placeMarkers(); }

  /* ---------------- 设置 ---------------- */
  function fillSettings(){
    $("set-amap-key").value = state.settings.amapKey || "";
    $("set-amap-sec").value = state.settings.amapSecurity || "";
    $("set-cb-env").value = state.settings.cbEnv || "";
    var rg = $("set-cb-region"); if(rg) rg.value = state.settings.cbRegion || "ap-shanghai";
    $("set-cb-key").value = state.settings.cbAccessKey || "";
    $("set-cb-collection").value = state.settings.cbCollection || "units";
    var rt = $("set-cb-realtime");
    if(rt) rt.value = (state.settings.realtime === false) ? "0" : "1";
    setSetStatus(cbConfigured() ? "当前环境：" + state.settings.cbEnv : "尚未配置环境 ID，云同步不可用。");
  }
  function saveSettings(){
    var prevAmap = state.settings.amapKey + "|" + state.settings.amapSecurity;
    var prevCb = state.settings.cbEnv + "|" + state.settings.cbRegion + "|" + state.settings.cbCollection;
    state.settings.amapKey = $("set-amap-key").value.trim();
    state.settings.amapSecurity = $("set-amap-sec").value.trim();
    state.settings.cbEnv = $("set-cb-env").value.trim();
    var rgEl = $("set-cb-region");
    state.settings.cbRegion = rgEl ? (rgEl.value || "ap-shanghai") : "ap-shanghai";
    state.settings.cbAccessKey = $("set-cb-key").value.trim();
    state.settings.cbCollection = $("set-cb-collection").value.trim() || "units";
    var rtEl = $("set-cb-realtime");
    var rtOn = rtEl ? (rtEl.value !== "0") : true;
    state.settings.realtime = rtOn;
    saveSettingsLocal();
    // 连接参数变化 → 断开旧连接并重建订阅
    var nowCb = state.settings.cbEnv + "|" + state.settings.cbRegion + "|" + state.settings.cbCollection;
    stopRealtime(); resetCloud();
    if(nowCb !== prevCb && cbConfigured()){
      pullCloud({ confirm:false, merge:true, quietError:true })
        .then(function(){ if(rtOn) startRealtime(); else updateRtBadge(); });
    } else if(rtOn){ startRealtime(); } else { updateRtBadge(); }
    var nowAmap = state.settings.amapKey + "|" + state.settings.amapSecurity;
    setSetStatus("设置已保存。");
    toast("设置已保存", "ok");
    if(nowAmap !== prevAmap){
      toast("地图密钥已变更，即将重新加载以生效…");
      setTimeout(function(){ location.reload(); }, 900);
    }
  }

  /* ---------------- 视图切换 ---------------- */
  function switchView(v){
    if(v !== "map" && state.pickMode) exitPickMode();   // 离开地图视图时退出选点模式
    state.view = v;
    document.querySelectorAll(".view").forEach(function(s){ s.classList.remove("active"); });
    $("view-"+v).classList.add("active");
    document.querySelectorAll("#tabs button").forEach(function(b){
      b.classList.toggle("active", b.getAttribute("data-view") === v);
    });
    if(v === "home") renderHome();
    else if(v === "ledger") renderLedger();
    else if(v === "map") renderMapView();
    else if(v === "settings") fillSettings();
  }
  // 数据变化后重渲染当前视图；顺带刷新顶栏统计，避免在「首页」时条数不更新
  function renderCurrentView(){ switchView(state.view); updateStat(); }

  function updateStat(){
    var cnt = $("stat");
    if(cnt) cnt.textContent = "共 " + state.data.length + " 条";
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind(){
    $("tabs").addEventListener("click", function(e){
      var b = e.target.closest("button[data-view]");
      if(b) switchView(b.getAttribute("data-view"));
    });
    // 关掉异常提示条：只关本次会话，下次同步失败还会再亮
    if($("sync-warn-close")) $("sync-warn-close").addEventListener("click", function(){
      _syncWarnClosed = true;
      var box = $("sync-warn"); if(box) box.classList.remove("show");
    });

    // 首页列表（事件委托）
    $("home-list").addEventListener("click", function(e){
      var el = e.target.closest("[data-action]");
      if(!el) return;
      var u = el.getAttribute("data-uid");
      var act = el.getAttribute("data-action");
      if(act === "banjie") doBanjie(u);
      else if(act === "detail") openDetail(u);
    });
    $("home-filter").addEventListener("change", function(){
      state.homeWindow = this.value === "all" ? "all" : Number(this.value);
      renderHome();
    });

    // 首页「已过期单位」独立区块：搜索 / 点击行看详情 / 办结 / 单独导出
    $("overdue-list").addEventListener("click", function(e){
      var el = e.target.closest("[data-action]");
      if(!el) return;
      var u = el.getAttribute("data-uid");
      if(el.getAttribute("data-action") === "banjie") doBanjie(u);
      else openDetail(u);
    });
    var overdueTimer = null;
    $("overdue-search").addEventListener("input", function(){
      var v = this.value;
      if(overdueTimer) clearTimeout(overdueTimer);
      overdueTimer = setTimeout(function(){ overdueTimer = null; state.overdueQuery = v; renderOverdue(); }, 150);
    });
    $("overdue-export").addEventListener("click", function(){
      var list = overdueList();
      if(!list.length){ toast("没有已过期单位可导出", "warn"); return; }
      var d = new Date();
      var stamp = d.getFullYear() + String(d.getMonth()+1).padStart(2,"0") + String(d.getDate()).padStart(2,"0");
      exportRowsToXlsx(list.map(function(x){ return x.r; }), "已过期单位_" + stamp + ".xlsx");
    });

    // 地图右侧「未编码单位」面板：筛选 / 点一条进入手动定位
    var unlocTimer = null;
    $("unloc-search").addEventListener("input", function(){
      var v = this.value;
      if(unlocTimer) clearTimeout(unlocTimer);
      unlocTimer = setTimeout(function(){ unlocTimer = null; state.unlocQuery = v; renderUnlocated(); }, 150);
    });
    $("unloc-list").addEventListener("click", function(e){
      var it = e.target.closest(".unloc-item");
      if(it) startManualLocate(it.getAttribute("data-uid"));
    });

    // 台账
    $("ledger-body").addEventListener("click", function(e){
      if(e.target.classList.contains("row-select")) return; // 复选框单独处理
      var el = e.target.closest("[data-action]");
      if(!el) return;
      var act = el.getAttribute("data-action");
      if(act === "locate"){ e.stopPropagation(); goManualLocate(el.getAttribute("data-uid")); return; }
      if(act === "detail") openDetail(el.getAttribute("data-uid"));
    });
    $("ledger-body").addEventListener("change", function(e){
      if(e.target.classList.contains("row-select")){
        var u = e.target.getAttribute("data-uid");
        state.selected[u] = e.target.checked;
        updateLedgerHint();
      }
    });
    $("select-all").addEventListener("change", function(){
      var checked = this.checked;
      state.data.forEach(function(r){ state.selected[r._uid] = checked; });
      document.querySelectorAll(".row-select").forEach(function(c){ c.checked = checked; });
      updateLedgerHint();
    });
    $("add-submit").addEventListener("click", addManual);
    $("add-clear").addEventListener("click", clearAddForm);
    $("import-btn").addEventListener("click", function(){ $("import-file").click(); });
    $("import-file").addEventListener("change", function(){
      if(this.files && this.files[0]) importExcel(this.files[0]);
      this.value = "";
    });
    $("batch-delete").addEventListener("click", batchDelete);
    $("export-btn").addEventListener("click", exportJson);
    if($("export-sel-btn")) $("export-sel-btn").addEventListener("click", exportSelected);
    // 台账搜索
    $("ledger-search").addEventListener("input", function(){
      state.ledgerQuery = this.value;
      renderLedger();
    });

    // 地图搜索：边输入边出候选项；回车执行高亮跳动
    $("map-search").addEventListener("input", onSearchInput);
    $("map-search").addEventListener("keydown", function(e){
      if(e.key === "Enter"){
        var first = $("map-suggest").querySelector(".suggest-item");
        if(first) selectTarget(first.getAttribute("data-uid"));
        else state.mapQuery = this.value;
      }
    });
    $("map-suggest").addEventListener("click", function(e){
      var it = e.target.closest(".suggest-item"); if(!it) return;
      selectTarget(it.getAttribute("data-uid"));
    });
    // 点击空白处收起候选项
    document.addEventListener("click", function(e){
      var s = $("map-suggest"); if(!s) return;
      if(!e.target.closest(".search-wrap")){ s.style.display = "none"; s.innerHTML = ""; }
    });
    $("geo-all").addEventListener("click", geocodeMissing);
    $("map-pick").addEventListener("click", function(){
      // 若已在选点模式则再次点击退出，否则进入
      if(state.pickMode) exitPickMode();
      else enterPickMode();
    });
    // 周围单位：快捷半径（200/300/500/800m）；点击 item 可把该单位设为新目标
    $("radius-tabs").addEventListener("click", function(e){
      var b = e.target.closest("button"); if(!b) return;
      var cus = $("nearby-custom"); if(cus) cus.value = "";   // 选快捷值时清空自定义输入
      showNearby(parseInt(b.getAttribute("data-r"), 10));
    });
    // 周围单位：自定义距离窗口（应用按钮 / 回车均可触发）
    $("nearby-custom-apply").addEventListener("click", applyCustomRadius);
    $("nearby-custom").addEventListener("keydown", function(e){
      if(e.key === "Enter") applyCustomRadius();
    });
    // 周围单位列表：单击 = 地图上该单位橙色跳动 2 秒；双击 = 切换为目标单位
    $("nearby-list").addEventListener("click", function(e){
      var it = e.target.closest(".nearby-item"); if(!it) return;
      var uid = it.getAttribute("data-uid");
      var now = Date.now();
      if(state._nbUid === uid && (now - state._nbTs) < 350){
        nearbyItemDouble(uid);       // 连点两次 → 切换目标
        return;
      }
      state._nbUid = uid; state._nbTs = now;
      if(state._nbTimer) clearTimeout(state._nbTimer);
      state._nbTimer = setTimeout(function(){
        state._nbTimer = null;
        flashNearbyMarker(uid);      // 单击 → 橙色跳动 2 秒后恢复
      }, 260);
    });
    // 兜底：原生 dblclick（与上面的时间戳检测共用去重，不会重复切换）
    $("nearby-list").addEventListener("dblclick", function(e){
      var it = e.target.closest(".nearby-item"); if(!it) return;
      nearbyItemDouble(it.getAttribute("data-uid"));
    });

    // 设置
    $("set-save").addEventListener("click", saveSettings);
    if($("cb-test")) $("cb-test").addEventListener("click", testCloud);
    if($("cb-push")) $("cb-push").addEventListener("click", function(){ syncNow({}); });
    if($("cb-pull")) $("cb-pull").addEventListener("click", function(){
      if(!confirm("从云端拉取将用云端数据覆盖本地全部记录，确定继续？")) return;
      pullCloud();
    });
    if($("cb-clear")) $("cb-clear").addEventListener("click", clearCloud);

    // SheetJS 库加载（CDN）；CloudBase SDK 走按需动态 import，不在此处加载
    var xls = document.createElement("script");
    xls.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    document.head.appendChild(xls);
  }

  /* ---------------- 启动 ---------------- */
  window.__wb = { closeModal: closeModal, openDetail: openDetail, enterPickMode: enterPickMode, exitPickMode: exitPickMode };

  // Esc：取消地图手动选点 / 取消目标选中（清除距离圆与右侧面板）
  document.addEventListener("keydown", function(e){
    if(e.key !== "Escape") return;
    if(state.pickMode){ exitPickMode(); return; }
    if($("modal-overlay")) return;          // 弹窗打开时交给弹窗处理
    if(state.targetUid) clearTarget();
  });
  function init(){
    purgeLegacy();
    loadSettings();
    loadData();
    bind();
    updateStat();
    switchView("home");
    startFallbackPoll();
    document.addEventListener("visibilitychange", onPageVisible);
    // 打开页面即与云端合并一次；成功后再开实时通道
    if(cbConfigured()){
      // 徽标先进「等待首次同步完成」：下面这条链要跑十几秒（拉 791 条 + 对齐），
      // 不先置位的话这段时间徽标会显示初始空态，看起来像故障。
      rtState = "syncing"; updateRtBadge();
      pullCloud({ confirm:false, merge:true, quietError:true })
        .then(function(pullOk){
          if(!pullOk) return;          // 拉取都失败了，别再补推，否则只会再刷一遍错误
          // 合并之后本地 ⊇ 云端，此时做一次全量对齐只会「补齐云端缺的」、不会删云端任何东西。
          // 判据是「本地这条记录的内容还没被云端确认过」——涵盖三种情况：
          //   ① 首次安装刚载入的种子数据；
          //   ② 上次同步失败（域名没放行 / 集合没建 / 断网）留下的、只在本地存在的记录；
          //   ③ 上次上传被云端拒绝（state.dirty）而本地已改过的记录。
          // 没有这一步，第 ②③ 种记录会永远只活在这一台浏览器里，其它设备看不到。
          var unsynced = state.data.filter(function(r){
            var k = cloudKey(r);
            return !state.synced[k] || (state.dirty && state.dirty[k]);
          });
          if(unsynced.length) return syncNow({silent:true});
        })
        .then(function(){ startRealtime(); });
    } else {
      updateRtBadge();
      console.warn("[云同步] 未配置腾讯云开发环境 ID，数据仅保存在本机浏览器。");
    }
  }
  // 门禁（gate.js）先加载：解锁后才启动应用，避免未授权就拉数据/建地图。
  // 未启用门禁（例如无头测试直接注入 app.js）时立即启动。
  if(window.__GATE_ENABLED__ && typeof window.__wbRegisterStart === "function"){
    window.__wbRegisterStart(init);
  } else if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
