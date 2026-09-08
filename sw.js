
const CACHE = 'gacha-pwa-mtsu8uon';
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
      fetch(req, { cache: 'reload' }).catch(() => caches.match('index.html').then(r => r || caches.match('codex.html')))
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
