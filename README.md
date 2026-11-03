# ZG Construções — site e sistema

Arquivos já montados, publicados no Vercel (sem etapa de build), e o pacote do servidor.

- `index.html` + `assets/`: site da loja; em `/#admin`, o app **ZG Loja** (vender com NFC-e, pedidos, caixa e site).
- `sistema.html` (`/sistema`): sistema completo pela internet (as telas do sistema de caixa e estoque).
- `manifest.webmanifest`, `sistema.webmanifest`, `sw.js`, `icones/`: apps instaláveis "ZG Loja" e "ZG Sistema".
- `servidor/sistema.enc`: servidor do sistema **criptografado** (AES-256-GCM). Só a função `loja` do Supabase tem a
  chave para abrir e carregar; o código do sistema não fica legível aqui.
- `servidor/funcao.js`: servidor antigo (espelho), mantido só como histórico.

Não edite estes arquivos à mão: eles são gerados a partir do projeto da loja.
