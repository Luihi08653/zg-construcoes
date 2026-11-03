// App "ZG Loja" (área da loja instalada no tablet ou celular). Não guarda nada offline:
// vendas, pedidos e caixa precisam do servidor e do computador da loja, então tudo vai direto para a internet.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
