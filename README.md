# Site Olimpíadas

Votações (formulários com notas de 1 a 5 estrelas) em **tempo real**, rodando 100% na Cloudflare
(Worker + Durable Object com SQLite + arquivos estáticos).

- **Organizador** (link principal `/`, protegido por senha; `/admin` redireciona para cá): cria formulários em 3 passos (rodada, categoria, turno, seções com imagem, perguntas),
  gera o **QR Code** de cada votação, vê **quem está online** e o progresso de cada pessoa, acompanha as médias
  ao vivo, **expulsa** quem não foi convidado (e readmite), encerra/reabre/exclui e baixa CSV.
- **PDF nas seções:** em cada seção dá para anexar **imagem ou PDF** (até 20 MB). O painel gera a prévia da 1ª página no navegador (pdf.js) e o participante vê essa prévia e pode tocar em “Abrir PDF completo”.
- **Votante** (`/v/<id>`, o link do QR Code — só consegue responder, sem acesso ao painel): precisa **digitar o nome** antes de começar; vota seção por seção;
  se for expulso, é desconectado na hora e não consegue voltar (nem com o mesmo nome).

## Rodar localmente
```bash
npm install
echo "ADMIN_PASSWORD=sua-senha" > .dev.vars   # só local, não vai pro Git
npm run dev                                   # http://localhost:8787  (painel em /)
npm test                                      # testes ponta a ponta (com o dev rodando)
```

## Publicar na Cloudflare
**Opção A – conectar o GitHub (recomendado, publica a cada push)**
1. Cloudflare → *Workers & Pages* → *Create* → *Import a repository* → escolha `Site-Olimpiadas`.
2. Build command: *(vazio)* · Deploy command: `npx wrangler deploy` · Branch: `main`.
3. Depois do 1º deploy: *Settings → Variables and Secrets → Add* → tipo **Secret**, nome `ADMIN_PASSWORD`, valor = a senha do admin.
4. Abra `https://site-olimpiadas.<seu-subdominio>.workers.dev/` (o painel).

**Opção B – pelo terminal**
```bash
npx wrangler login
npx wrangler deploy
npx wrangler secret put ADMIN_PASSWORD
```
Os QR Codes usam o endereço em que o painel foi aberto; gere/baixe os QR **depois** de acessar o painel pelo domínio final.
Domínio próprio: *Settings → Domains & Routes* no Worker.

## Contas de organizador

Qualquer pessoa que abrir o link principal pode **criar uma conta** (usuário + senha) e montar os próprios formulários; cada organizador só vê e controla os formulários que criou. Quem vota (QR Code) não precisa de conta.

- O usuário `admin` + a senha `ADMIN_PASSWORD` entra como **administrador**: vê e gerencia os formulários de todos (inclusive os criados antes das contas).
- Opcional: crie um Secret `SIGNUP_CODE` para exigir um código de convite no cadastro (sem ele, o cadastro é aberto).
- Senhas são guardadas com PBKDF2-SHA256 (100 mil iterações). Trocar `ADMIN_PASSWORD` desconecta todos (precisam entrar de novo).

## Votação, estilos e respostas

- **Enviar trava a seção:** o participante responde a seção e toca em "Enviar e continuar"; depois disso não dá para voltar nem alterar (o servidor também recusa). Se recarregar a página, volta na primeira seção não enviada.
- **Respostas por pessoa:** no painel, clique no nome (ou em "Ver respostas") para ver as notas da pessoa e a soma por seção, ao vivo.
- **Estilos:** em Configurar → "Estilo do formulário": Azul, Preto e dourado ou Personalizado (cor de destaque, fundo, cartões claros/escuros). O banner pode ser trocado por uma imagem (sua própria arte).

## Estrutura
```
src/worker.js   entrada: login admin (HMAC), roteia API/WebSocket para o Durable Object, serve /public
src/hub.js      Durable Object: SQLite (votações, participantes, votos, imagens) + WebSockets em tempo real
public/         index.html (painel), v/ (votação), css/, js/, vendor/ (qrcode.js MIT, pdf.js Apache-2.0)
test/e2e.mjs    teste de API + WebSocket
```

## Observações
- Tempo real = WebSocket (hibernação do Durable Object: sem custo enquanto ninguém está conectado).
- Expulsão remove o acesso daquele aparelho/nome. Quem quiser burlar pode abrir com outro nome; para eventos fechados,
  encerre a votação depois da entrada dos convidados (novas entradas são bloqueadas quando está “Encerrada”).
- Votos de participantes expulsos não entram nas médias.
