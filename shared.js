/* ============================================================
   阴阳师抽卡 · 共享逻辑
   - 角色库：由 /api/roster 递归扫描 img/ 得到，加图即加角色
   - 稀有度与概率：来自 rates.json，改文件即生效
   - 收集进度：localStorage，图鉴与抽卡页共用
   ============================================================ */
(function(global){
  'use strict';

  const STORE_KEY = 'onmyoji_codex_v1';   // 收集册
  const SKIN_KEY  = 'onmyoji_skin_v1';    // 每个角色当前选中的皮肤序号（持久化）
  const SKIN_INST_KEY = 'onmyoji_skin_inst_v1'; // 展开模式下，每个「抽到的副本」各自的皮肤序号

  /* ---------- localStorage 收集册 ---------- */
  const Codex = {
    _read(){
      try{ return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
      catch(e){ return {}; }
    },
    _write(o){
      try{ localStorage.setItem(STORE_KEY, JSON.stringify(o)); }
      catch(e){ /* 隐私模式下可能写不了，忽略 */ }
    },
    counts(){ return this._read(); },
    count(id){ return this._read()[id] || 0; },
    has(id){ return this.count(id) > 0; },
    /** 记录抽到，返回该角色累计数量 */
    add(id){
      const o = this._read();
      o[id] = (o[id] || 0) + 1;
      this._write(o);
      return o[id];
    },
    obtainedTotal(){ return Object.values(this._read()).reduce((s,n)=>s+n,0); },
    /** 已解锁的不同角色数 */
    unlockedTotal(){ return Object.keys(this._read()).length; },
    reset(){ this._write({}); },
  };

  /* ---------- 皮肤（同一角色的多张图） ----------
     roster 里每个角色形如：
       { id, name, file, rarity, order, skins:[{n, file, iid}, ...] }
     · skins[0]（序号 1）= 默认皮肤，file 字段就是它，召唤页恒用皮肤 1
     · iid 是这张图在 crops 里的键（皮肤 1 的 iid 等于角色 id）

     规则：
       · 召唤结果、图鉴网格、图鉴详情一律默认第 1 套皮肤；
       · 只有点「替换皮肤」按钮才换成别的套；
       · 选择会写到 localStorage，召唤 ↔ 图鉴来回切、刷新页面都会保留上次看的那一套。
         注意：早期版本因扩展名大小写把同一角色拆成两条 id，老存档里可能有
         `sp/神启荒.PNG` 这类键，对不上新 id（现在是 `sp/神启荒.png`），
         那些孤立条目启动时清掉，避免混淆。 */
  const Skin = {
    _read(){
      try{ return JSON.parse(localStorage.getItem(SKIN_KEY)) || {}; }
      catch(e){ return {}; }
    },
    _write(o){
      try{ localStorage.setItem(SKIN_KEY, JSON.stringify(o)); }
      catch(e){ /* 隐私模式下可能写不了，忽略 */ }
    },
    /** 该角色当前选中的皮肤序号（缺省 1） */
    get(id){ return this._read()[id] || 1; },
    set(id, n){
      if(!id) return;
      const o = this._read();
      o[id] = n;
      this._write(o);
    },
    /** 清掉所有「对不上当前 roster id」的历史选择（如 sp/神启荒.PNG → sp/神启荒.png 的合并） */
    prune(validIds){
      if(!validIds) return;
      const set = new Set(validIds);
      const o = this._read();
      let dirty = false;
      for(const k of Object.keys(o)){
        if(!set.has(k)){ delete o[k]; dirty = true; }
      }
      if(dirty) this._write(o);
    },
    /** 展开模式：取第 k 个副本（1 起）当前展示的皮肤序号（缺省 1） */
    getInst(id, k){
      if(!id || !k) return 1;
      try{ const o = JSON.parse(localStorage.getItem(SKIN_INST_KEY)) || {}; return o[id + '#' + k] || 1; }
      catch(e){ return 1; }
    },
    /** 展开模式：设置第 k 个副本的皮肤序号 */
    setInst(id, k, n){
      if(!id || !k) return;
      let o;
      try{ o = JSON.parse(localStorage.getItem(SKIN_INST_KEY)) || {}; }
      catch(e){ o = {}; }
      o[id + '#' + k] = n;
      try{ localStorage.setItem(SKIN_INST_KEY, JSON.stringify(o)); }catch(e){}
    },
    /** 清空所有副本皮肤选择（清空收集册时调用） */
    resetInst(){
      try{ localStorage.removeItem(SKIN_INST_KEY); }catch(e){}
    },
  };

  /** 皮肤列表；老数据没有 skins 字段时退化成「只有一张默认图」 */
  function skinList(c){
    if(!c) return [];
    if(Array.isArray(c.skins) && c.skins.length) return c.skins;
    return [{ n:1, file: c.file, iid: c.id }];
  }

  /** 取第 n 套皮肤（n 不存在时退回第一套），返回 {n, file, iid} */
  function getSkin(c, n){
    const list = skinList(c);
    if(!list.length) return null;
    const i = list.findIndex(s => s.n === n);
    return i < 0 ? list[0] : list[i];
  }

  /** 下一套皮肤的序号：1 → 2 → 3 → …→ 末 → 1 */
  function nextSkin(c, n){
    const list = skinList(c);
    if(list.length <= 1) return 1;
    const i = list.findIndex(s => s.n === n);
    return list[((i < 0 ? -1 : i) + 1) % list.length].n;
  }

  /* ---------- 加载远程数据 ----------
     策略：优先用后端接口（能自动扫描 img/），失败则回退到静态快照
     （roster.json / rates.json），这样纯静态服务器（如预览面板）也能跑。 */
  async function fetchJSON(url){
    const r = await fetch(url, {cache:'no-store'});
    if(!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return r.json();
  }

  // 依次尝试多个候选地址，返回第一个成功解析的 JSON
  async function tryCandidates(urls){
    let lastErr;
    for(const u of urls){
      try{
        const r = await fetch(u, {cache:'no-store'});
        if(!r.ok) continue;
        const j = await r.json();
        if(j && !('error' in j)) return j;
      }catch(e){ lastErr = e; }
    }
    if(lastErr) throw lastErr;
    throw new Error('所有数据源均不可用');
  }

  async function loadRoster(){
    let j = null;
    try{
      j = await tryCandidates([
        'api/roster', '/api/roster',   // 后端接口（本地 8910 服务器）
        'roster.json',                 // 静态快照（纯静态环境兜底）
      ]);
    }catch(e){ j = null; }
    if(j){
      const r = (j.roster) || j;       // 接口包一层 {roster}，静态文件直接是对象
      if(r && Object.keys(r).length) return r;
    }
    // 最终兜底：页面内联的 roster.js（构建时生成，任何静态环境都带得上）
    if(typeof window !== 'undefined' && window.__ROSTER__ && Object.keys(window.__ROSTER__).length){
      return window.__ROSTER__;
    }
    return {};
  }

  async function loadRates(){
    let j = null;
    try{
      j = await tryCandidates([
        'api/rates', '/api/rates',     // 后端接口
        'rates.json',                  // 静态兜底
      ]);
    }catch(e){ j = null; }
    if(j){
      const r = (j.rates) || j;
      if(r && r.rarities) return r;
    }
    // 最终兜底：页面内联的 roster.js
    if(typeof window !== 'undefined' && window.__RATES__ && window.__RATES__.rarities){
      return window.__RATES__;
    }
    return {};
  }

  /**
   * 语音清单：{ base:'music/', map:{ 角色id: 'n/一目连呱.mp3' } }
   * 由 gen-voice.js 扫描 music/ 生成；没有音频时返回空 map，抽卡照常进行。
   */
  async function loadVoice(){
    let j = null;
    try{
      const r = await fetch('api/voice', {cache:'no-store'});   // 后端接口（实时扫描）
      if(r.ok) j = await r.json();
    }catch(e){}
    if(!j){
      try{
        const r = await fetch('voice.json', {cache:'no-store'}); // 静态快照
        if(r.ok) j = await r.json();
      }catch(e){}
    }
    if(!j && typeof window !== 'undefined' && window.__VOICE__){
      j = window.__VOICE__;                                     // 页面内联（file:// 兜底）
    }
    if(!j) return { base:'music/', map:{} };
    return {
      base: (typeof j.base === 'string' ? j.base : 'music/') || 'music/',
      map:  (j.map && typeof j.map === 'object') ? j.map : {},
    };
  }

  /**
   * 署名表：{ map:{ 角色id: '署名文字' } }
   * 由 gen-signature.js 扫描 img/署名表格.xlsx 生成；
   * 没有表 / 没匹配上时返回空 map，图鉴里红框位置留空（不会报错）。
   */
  async function loadSignature(){
    let j = null;
    try{
      const r = await fetch('api/signature', {cache:'no-store'}); // 后端接口（实时读 xlsx）
      if(r.ok) j = await r.json();
    }catch(e){}
    if(!j){
      try{
        const r = await fetch('signature.json', {cache:'no-store'}); // 静态快照
        if(r.ok) j = await r.json();
      }catch(e){}
    }
    if(!j && typeof window !== 'undefined' && window.__SIG__){
      j = window.__SIG__;                                       // 页面内联（file:// 兜底）
    }
    if(!j) return { map:{} };
    return { map: (j.map && typeof j.map === 'object') ? j.map : {} };
  }

  /** 把 music/ 下的相对路径拼成可直接喂给 <audio> 的 URL（中文名要逐段编码） */
  function voiceUrl(base, rel){
    if(!rel) return null;
    const b = base || 'music/';
    if(!b.endsWith('/')) return b + rel;
    return b + String(rel).split('/').map(encodeURIComponent).join('/');
  }

  async function load(){
    const [roster, rates, crops] = await Promise.all([
      loadRoster().catch(()=>({})),
      loadRates().catch(()=>({})),
      loadCrops().catch(()=>({})),
    ]);
    // 加载完花名册后清一遍「对不上当前 id 的旧皮肤选择」
    // （早期版本因 .PNG / .png 大小写把同一角色拆成两条 id，老存档里的孤立条目直接丢）
    try{
      const ids = [];
      for(const list of Object.values(roster || {})) for(const c of list) ids.push(c.id);
      Skin.prune(ids);
    }catch(e){ /* 隐私模式或花名册为空时跳过 */ }
    return { roster, rates, crops };
  }

  // 每张 PNG 的「alpha 透明 bbox 裁切比例」：{ [角色id]: {t,r,b,l} }
  // 让剪影与正常图都按内容真实占位居中，而不是按 PNG 整体（含大量透明 padding）
  async function loadCrops(){
    let j = null;
    try{
      // 后端接口（可能在 roster.json 的 crops 字段里，也可能在独立 crops.json）
      const r = await fetch('api/roster', {cache:'no-store'});
      if(r.ok){ j = await r.json(); }
    }catch(e){}
    if(!j){
      try{
        const r = await fetch('roster.json', {cache:'no-store'});
        if(r.ok){ j = await r.json(); }
      }catch(e){}
    }
    if(j && j.crops) return j.crops;
    if(typeof window !== 'undefined' && window.__CROPS__){
      return window.__CROPS__;
    }
    return {};
  }

  // 接受 crops map 和角色 id，返回 {t,r,b,l} 或 null
  function getCrop(crops, id){
    if(!crops || !id) return null;
    const c = crops[id];
    if(!c) return null;
    if(typeof c.t !== 'number') return null;
    return c;
  }

  /**
   * 应用裁切到任意 img 元素。
   * 1) 如果有 crop 数据，按 alpha bbox 真实尺寸把图片放大到「bbox 充满卡片」，
   *    并把图片整体偏移，使 bbox 中心对齐卡片中心 → 让 silhouette 真正居中，而不是 PNG 整框居中。
   * 2) 同时叠加 clip-path 作为兜底裁切（防止 bbox 算错时溢出）。
   * 3) 没有 crop 数据时退化为「整图 contain + 居中」的旧逻辑。
   *
   * @param {HTMLImageElement} img
   * @param {{t:number,r:number,b:number,l:number}|null} crop
   * @param {HTMLElement} [card]  .card 容器，用于读取卡片像素尺寸；省略则退化为只设 clip-path
   */
  function applyCrop(img, crop, card){
    if(!crop) return;
    if(typeof crop.t !== 'number') return;

    if(!card){ // 没有容器时只做 clip-path 兜底
      const s = `${(crop.t*100).toFixed(3)}% ${(crop.r*100).toFixed(3)}% ${(crop.b*100).toFixed(3)}% ${(crop.l*100).toFixed(3)}%`;
      img.style.clipPath = `inset(${s})`;
      img.style.webkitClipPath = `inset(${s})`;
      return;
    }

    // 重试计数：容器尚未插入 DOM 或尚未完成布局时尺寸为 0，需等下一帧再算
    let tries = 0;

    const setup = () => {
      const W = img.naturalWidth, H = img.naturalHeight;
      if(!W || !H) return;

      // 关键防御：容器还没进 DOM / 还没布局出尺寸时 clientWidth|Height 为 0，
      // 此时算出的缩放比接近 0，图片会被缩到肉眼不可见。
      // 不能就此放弃（后续 ResizeObserver 未必会触发），下一帧重试。
      if(!card.clientWidth || !card.clientHeight){
        if(tries < 30){ tries++; requestAnimationFrame(setup); }
        return;
      }

      // --- 容器可用区域（clientWidth/Height = 内容+padding，再扣掉 padding 即为纯内容区）---
      const cs = getComputedStyle(card);
      const padL = parseFloat(cs.paddingLeft)  || 0;
      const padT = parseFloat(cs.paddingTop)   || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      const padB = parseFloat(cs.paddingBottom)|| 0;
      const boxW = Math.max(1, card.clientWidth  - padL - padR);
      const boxH = Math.max(1, card.clientHeight - padT - padB);

      // --- 内容 bbox 在原图中的像素尺寸 ---
      const bboxW = Math.max(1, (1 - crop.l - crop.r) * W);
      const bboxH = Math.max(1, (1 - crop.t - crop.b) * H);

      // --- contain：整块内容刚好放进可用区，取较小的缩放比（不裁掉任何内容）---
      const scale = Math.min(boxW / bboxW, boxH / bboxH);

      const imgW = W * scale;
      const imgH = H * scale;

      // bbox 中心（原图坐标）→ 缩放后坐标
      const bboxCx = (crop.l * W + bboxW / 2) * scale;
      const bboxCy = (crop.t * H + bboxH / 2) * scale;

      // 让 bbox 中心落在可用区中心 → 剪影真正居中（不再贴顶）
      const left = padL + (boxW / 2) - bboxCx;
      const top  = padT + (boxH / 2) - bboxCy;

      img.style.position  = 'absolute';
      img.style.width     = imgW + 'px';
      img.style.height    = imgH + 'px';
      img.style.left      = left + 'px';
      img.style.top       = top + 'px';
      img.style.right     = 'auto';
      img.style.bottom    = 'auto';
      img.style.margin    = '0';   // 覆盖 CSS 兜底的 margin:auto，否则会干扰上面的 left/top
      img.style.maxWidth  = 'none';
      img.style.maxHeight = 'none';
      // 显式 width/height 已按原图等比缩放，object-fit 用 contain 做最后兜底：
      // 即使因小数 rounding 导致 box 比例有微差，也绝不拉伸，而是留空边。
      img.style.objectFit = 'contain';

      // contain 后不会溢出，clip-path 反而可能误裁，这里清掉
      img.style.clipPath = 'none';
      img.style.webkitClipPath = 'none';

      if(getComputedStyle(card).overflow === 'visible') card.style.overflow = 'hidden';
    };

    if(img.complete && img.naturalWidth){
      setup();
    }else{
      img.addEventListener('load', setup, { once:true });
    }
  }

  /**
   * 给一个「容器」里的所有图片在每次容器尺寸变化时重新套用 applyCrop。
   * 用于图鉴网格：卡片尺寸随窗口变化时，确保剪影始终居中。
   * @param {HTMLElement} container 监听尺寸变化的根元素
   * @param {Map<HTMLImageElement, {crop:object, card:HTMLElement}>} items 元素→裁切信息
   */
  function observeCentering(container, items){
    if(!container || !items || !items.size) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if(raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        for(const [img, info] of items){
          applyCrop(img, info.crop, info.card);
        }
      });
    });
    ro.observe(container);
  }

  /* ---------- 稀有度元信息 ---------- */
  function rarityMeta(rates, key){
    const cfg = (rates.rarities && rates.rarities[key]) || {};
    return {
      key,
      label: cfg.label || String(key).toUpperCase(),
      weight: typeof cfg.weight === 'number' ? cfg.weight : 0,
      color: cfg.color || '#8a8a8a',
    };
  }

  /**
   * 有效稀有度列表：按 order 排序，只保留「有角色 且 权重>0」的。
   * 返回 [{key,label,color,weight,chars:[...], p(归一化概率)}]
   */
  function buildTiers(roster, rates){
    const order = Array.isArray(rates.order) && rates.order.length
      ? rates.order
      : Object.keys(roster);

    const keys = new Set([...order, ...Object.keys(roster)]);
    const tiers = [];

    for(const k of keys){
      const chars = roster[k] || [];
      const meta  = rarityMeta(rates, k);
      if(!chars.length) continue;        // 空文件夹跳过
      if(meta.weight <= 0) continue;     // 权重为 0 跳过
      tiers.push({ ...meta, chars });
    }

    // 保持 order 中的顺序，未列出的排后面
    const pos = k => { const i = order.indexOf(k); return i < 0 ? 999 : i; };
    tiers.sort((a,b)=> pos(a.key) - pos(b.key) || a.key.localeCompare(b.key));

    const total = tiers.reduce((s,t)=>s+t.weight, 0);
    tiers.forEach(t => t.p = total > 0 ? t.weight/total : 0);
    return tiers;
  }

  /* ---------- 按权重抽取 ---------- */
  function pickTier(tiers){
    const total = tiers.reduce((s,t)=>s+t.weight, 0);
    if(total <= 0) return null;
    let r = Math.random() * total;
    for(const t of tiers){
      r -= t.weight;
      if(r < 0) return t;
    }
    return tiers[tiers.length-1];
  }

  /** 抽 n 个，返回 [{id,name,file,rarity,label,color}] */
  function draw(tiers, n){
    const out = [];
    for(let i=0;i<n;i++){
      const t = pickTier(tiers);
      if(!t || !t.chars.length) continue;
      const c = t.chars[Math.floor(Math.random()*t.chars.length)];
      out.push({ ...c, label: t.label, color: t.color });
    }
    return out;
  }

  /* ---------- 十周年特别版：按固定分段规则抽 10 连 ----------
     规则写在 rates.json 的 tenth.sequence，每段形如 { ssr:[lo,hi], sp:[lo,hi] }，
     表示该抽在「SSR 的 order 区间」与「SP 的 order 区间」的并集里随机取一个角色；
     只写其中一个稀有度则该抽固定落在该稀有度区间。第 1 段写全量区间即「随机 SSR 或 SP」。
     改 rates.json 即可调整，无需动逻辑。 */
  function drawTenth(roster, rates){
    const seq = (rates && rates.tenth && Array.isArray(rates.tenth.sequence)) ? rates.tenth.sequence : [];
    const byOrder = key => (roster[key]||[]).slice().sort((a,b)=>(a.order||0)-(b.order||0));
    const ssr = byOrder('ssr'), sp = byOrder('sp');
    const meta = k => rarityMeta(rates, k);
    const inRange = (arr, lo, hi) => arr.filter(c => (c.order||0) >= lo && (c.order||0) <= hi);
    const out = [];
    for(const step of seq){
      const pool = [];
      if(step.ssr){ for(const c of inRange(ssr, step.ssr[0], step.ssr[1])) pool.push(c); }
      if(step.sp){  for(const c of inRange(sp,  step.sp[0],  step.sp[1]))  pool.push(c); }
      if(!pool.length) continue;                       // 区间为空则跳过该抽
      const c = pool[Math.floor(Math.random()*pool.length)];
      const m = meta(c.rarity);
      out.push({ ...c, label: m.label, color: m.color });
    }
    return out;
  }

  /* ---------- 扁平化全部角色（图鉴用） ----------
     每个稀有度内部按 order 倒序（新增优先）。order 来自 gen.js/server.js：
     文件 mtime 升序编号（1 最老），所以倒序=新的先出。 */
  function flatten(roster, rates){
    const order = Array.isArray(rates.order) ? rates.order : [];
    const keys = new Set([...order, ...Object.keys(roster)]);
    const list = [];
    for(const k of keys){
      if(!(roster[k]||[]).length) continue;
      const meta = rarityMeta(rates, k);
      // 把 chars 按 order 倒序复制一份
      const chars = (roster[k] || []).slice().sort((a,b)=>(b.order||0)-(a.order||0));
      list.push({ key:k, label:meta.label, color:meta.color, chars });
    }
    const pos = k => { const i = order.indexOf(k); return i<0 ? 999 : i; };
    list.sort((a,b)=> pos(a.key)-pos(b.key) || a.key.localeCompare(b.key));
    return list;
  }

  /* ---------- 召唤页的池子记录（图鉴「清空收集册」要一并重置） ----------
     这些键平时只在 summon.html 里读写，但「清空收集册 = 回到全新账号」，
     池子选择 / UP 保底进度 / 自选角色 / 常驻统计 都该一起归零。
     列举在共享层，免得两个页面各写一份 key 字符串、改了一处漏一处。 */
  const POOL_KEYS = {
    pool:      'onmyoji_pool_v1',        // 当前选中的池子（蓝票 / 破碎符咒 / 两个 UP 池）
    upState:   'onmyoji_up_state_v2',    // 限时UP / 自选UP 各自的累计抽数与保底计数
    upStateV1: 'onmyoji_up_state_v1',    // 旧版（迁移用，一并清掉免得复活老数据）
    pickChar:  'onmyoji_pick_char_v1',   // 自选UP 已选中的角色
    stats:     'onmyoji_draw_stats_v1',  // 常驻页签的全局抽卡统计
    tenth:     'onmyoji_10th_v1',        // 十周年特别版「已使用」标记
  };
  const Pools = {
    keys: POOL_KEYS,
    /** 清空所有池子相关的本地记录（不含收集册本身） */
    reset(){
      for(const k of Object.values(POOL_KEYS)){
        try{ localStorage.removeItem(k); }catch(e){ /* 隐私模式忽略 */ }
      }
    },
  };

  global.Gacha = {
    Codex, Skin, load, loadCrops, loadVoice, loadSignature, voiceUrl, getCrop, applyCrop, observeCentering,
    buildTiers, draw, drawTenth, flatten, rarityMeta, skinList, getSkin, nextSkin,
    STORE_KEY, SKIN_KEY, POOL_KEYS, Pools,
  };
})(window);
