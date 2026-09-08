
const CACHE = 'gacha-pwa-mtszmbvj';
const SHELL = [
  './', 'index.html', 'codex.html', 'shared.js', 'roster.js',
  'roster.json', 'rates.json',
  'voice.js', 'voice.json',
  'signature.js', 'signature.json',
  'author-note.js', '纸人.png', 'CNAME',
  'manifest.webmanifest',
  'icon-192.png', 'icon-512.png'
];

self.addEventListener('install', e => {
  // 逐条 add：缺哪个文件都不至于让整个 install 失败（voice.js 没生成就是没有）
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 离线兜底页：网络连不上、且本地缓存也被清掉时，至少返回一个能看的提示页，
   而不是让 respondWith 拿到 undefined —— 那会让浏览器直接报「无法访问此网站」，
   看起来就像站点挂了（「清了缓存之后就打不开」就是这么来的）。 */
const OFFLINE_HTML = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>暂时打不开</title></head>'
  + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
  + 'background:#12060c;color:#e8cf9a;font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:24px">'
  + '<div><div style="font-size:18px;margin-bottom:10px">暂时连不上站点</div>'
  + '<div style="font-size:13px;opacity:.75;line-height:1.8">本地缓存已被清除，当前网络又打不开页面。<br>'
  + '请检查网络连接后重试。</div>'
  + '<button onclick="location.reload()" style="margin-top:18px;padding:10px 24px;border:0;'
  + 'border-radius:999px;background:#c8161d;color:#fff;font-size:14px">重试</button></div></body></html>';
function offlineRes(){
  return new Response(OFFLINE_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.origin !== self.location.origin) return;

  // 导航请求：网络优先，失败回退到已缓存的页面。
  // cache:'reload' 用来绕过浏览器自身的 HTTP 缓存（站点是 max-age=600），
  // 否则刷新时可能直接从本地 HTTP 缓存拿到 10 分钟前的旧 HTML。
  if(req.mode === 'navigate'){
    e.respondWith(
      fetch(req, { cache: 'reload' })
        .catch(() => fetch(req))        // 个别浏览器不支持 navigate + cache:'reload'，退回普通请求
        .then(res => {
          if(res && res.ok){
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
            return res;
          }
          throw new Error('bad response');
        })
        .catch(() => caches.match(req)                       // 依次回退：当前页 → 首页 → 根 → 图鉴 → 离线提示页
          .then(r => r || caches.match('index.html'))
          .then(r => r || caches.match('./'))
          .then(r => r || caches.match('codex.html'))
          .then(r => r || offlineRes()))
    );
    return;
  }

  // 数据/代码文件（会随编辑变化）：网络优先，始终拿到最新；仅离线时回退缓存。
  // 注意：shared.js 也放这里——它经常加新 API/模块，缓存优先会让旧 shared.js
  // 配上新 HTML，导致运行时 ReferenceError（比如 Gacha.Tenth 缺失）。
  const DATA = ['signature.js','signature.json','roster.json','rates.json','roster.js','voice.js','voice.json','author-note.js'];
  const path = url.pathname.split('/').pop();
  if(DATA.includes(path)){
    e.respondWith(
      fetch(req).then(res => {
        if(res && res.status === 200) caches.open(CACHE).then(c => c.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // 其它同源 GET（主要是图片）：缓存优先，同时后台更新（离线也能看图）
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if(res && res.status === 200) caches.open(CACHE).then(c => c.put(req, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
