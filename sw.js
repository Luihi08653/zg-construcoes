// App "ZG Loja" (área da loja instalada no tablet ou celular). Não guarda nada offline:
// vendas, pedidos e caixa precisam do servidor e do computador da loja, então tudo vai direto para a internet.
// versão do app: 2026-11-04b (mudar este texto faz os aparelhos baixarem o service worker de novo)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
