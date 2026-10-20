// 오프라인 지원용 서비스 워커
// - 페이지·측정 데이터: 네트워크 우선(최신 값 우선), 실패하면 마지막으로 받은 값을 보여준다.
// - 외부 라이브러리(CDN·글꼴): 캐시 우선, 백그라운드에서 갱신한다.
const CACHE = 'radiorate-v1';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/hero.jpg',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 측정 데이터는 캐시 무효화용 쿼리(?_=시각)를 붙여 요청하므로 쿼리를 뺀 주소로 저장한다.
function cacheKey(request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith('/data/radiation.json')) url.search = '';
  return url.toString();
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(cacheKey(request), response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(cacheKey(request));
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const page = await cache.match(new URL('./index.html', self.registration.scope).toString());
      if (page) return page;
    }
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const update = fetch(request)
    .then(response => {
      if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || update;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});
