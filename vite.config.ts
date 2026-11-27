import { defineConfig } from 'vite'

const base = '/ScheduleBot/'
export default defineConfig({
  base,
  server: { proxy: { '/api': 'http://localhost:8787' } },
  plugins: [{
    name: 'schedulebot-offline',
    apply: 'build',
    generateBundle(_, bundle) {
      const files = Object.keys(bundle).filter(name => /^(?:assets\/index[-.]|index\.html$)/.test(name)).sort()
      const fingerprint = files.join(':')
      this.emitFile({
        type: 'asset', fileName: 'offline.js',
        source: `
const prefix = 'schedulebot:';
const key = prefix + ${JSON.stringify(fingerprint)};
const home = ${JSON.stringify(base)};
const shell = ${JSON.stringify([base, ...files.filter(file => file !== 'index.html').map(file => base + file)])};
self.addEventListener('install', event => event.waitUntil(caches.open(key).then(cache => cache.addAll(shell))));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith(prefix) && name !== key) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(home) || event.request.method !== 'GET') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () => (await caches.open(key)).match(home)));
  } else if (url.pathname.startsWith(home + 'assets/')) {
    event.respondWith((async () => {
      const cache = await caches.open(key);
      const cached = await cache.match(event.request, { ignoreVary: true });
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    })());
  }
});
`,
      })
    },
  }],
})
