# Transcritor de Chamadas

Extensão do Chrome que transcreve as chamadas do **Google Meet** usando as
legendas do próprio Meet: de graça, sem gravar áudio, sem mandar nada para
servidor nenhum, e com o nome de quem falou.

No fim da chamada, você tem um `.md` assim:

```
**Ana Souza** · 14:02
Bom dia, pessoal, vamos falar do contrato.

**Você** · 14:03
Pode começar.
```

## Instalar

**Passo a passo com fotos, para quem não é programador:**
https://intake.gravae.io/copiloto/instalar/ (o botão de lá baixa sempre a versão
mais nova, já como a pasta pronta para carregar).

Em resumo:

1. Baixe `transcritor-gravae.zip` na página acima (ou este repositório, **Code ›
   Download ZIP**, e use a pasta `extensao/`) e descompacte numa pasta fixa.
2. Abra `chrome://extensions` e ligue o **Modo do desenvolvedor**, no canto de cima à direita.
3. Clique em **Carregar sem compactação** e escolha a pasta.
4. Fixe o ícone (o **G.** da Gravaê) na barra do Chrome.

Já está numa chamada? Não precisa recarregar: ao ser instalada ou atualizada, a
extensão entra sozinha nas abas do Meet que já estavam abertas. Se o aviso
"Transcrevendo" não aparecer, abra o popup e clique em **Transcrever esta chamada**.

Para atualizar, **na mesma pasta** e sem remover a extensão:

- quem baixou com git: `git pull` na pasta do repositório;
- quem baixou o ZIP: descompacte e copie o conteúdo da pasta `extensao` nova por
  cima da antiga, no mesmo lugar;

e clique em ↻ na extensão, em `chrome://extensions`. Assim o login do copiloto e
o histórico das calls continuam. **Remover** a extensão ou carregar de outra pasta
apaga os dois (o Chrome trata como outra extensão). O login também não vence para
quem usa: ele se renova sozinho antes dos 30 dias.

## Como funciona

- Ao entrar na chamada, a extensão liga as legendas e mostra no canto de cima
  "Transcrevendo · N falas". O ícone ganha o selo **REC**.
- Cada bloco de legenda vira uma fala. Quando o Meet corrige uma palavra já
  escrita, a fala é atualizada no lugar, sem repetir.
- Quando uma pessoa fala muito tempo (uma aula, uma apresentação), o Meet vai
  apagando o começo da legenda. A extensão continua de onde parou, sem repetir
  nada, e corta a fala em partes de até ~1.000 caracteres, no fim de uma frase.
- Se as legendas estiverem em inglês numa chamada em português, o aviso no canto
  fica amarelo e diz onde trocar o idioma.
- A transcrição fica salva no navegador a cada 2 s. Ao sair da chamada (pelo
  botão, quando ela acaba ou fechando a aba), baixa um `.md` em
  `Downloads/Transcricoes/AAAA-MM-DD HHhMM - título.md`.
- Se a aba recarregar no meio, a transcrição continua a mesma.
- No popup: a lista das chamadas, baixar `.md` ou `.txt`, copiar e apagar. Nas
  opções: transcrever sozinho, baixar ao sair, esconder as legendas da tela e o
  seu nome no lugar de "Você".

O idioma da transcrição é o das legendas do Meet (**⋮ › Configurações › Legendas**).

**Avise quem está na chamada** que ela está sendo transcrita.

## Copiloto de vendas

Durante a chamada, um painel ao lado do Meet (o **painel lateral** do Chrome,
que o cliente não vê nem quando você compartilha a tela) acompanha a conversa
contra um roteiro de vendas:

- **Diga agora:** a próxima frase sugerida, uma por vez, com o porquê;
- **Objeção:** quando o cliente resiste (preço, sócio, concorrente…), a resposta
  que o roteiro manda dar e o que evitar;
- **Alertas** (sinal de compra, promessa arriscada…) e as **etapas do roteiro**,
  que vão ficando verdes conforme a conversa cobre cada uma;
- no fim da call, um **resumo**: dados do cliente, dor, objeções, promessas
  arriscadas, próximos passos e conselhos para a próxima.

Para abrir: popup › **Abrir o copiloto**. Para usar, uma vez a cada 30 dias:
popup › ⚙ › **Copiloto de vendas**, digite o seu e-mail `@gravae.io`, clique em
**Mandar código** e digite o código de 6 dígitos que chega no e-mail.
Ninguém precisa de chave: desde a 0.8, o copiloto **roda no servidor da
Gravaê** (`intermediario/`). A extensão só lê as legendas e manda as falas; o
servidor guarda a call, roda o copiloto (com a chave da OpenRouter e o roteiro de
vendas, que não está neste repositório) e serve as telas do painel e da agenda,
que a extensão abre por dentro. Mudar prompt, modelo, gatilho ou tela vale na
hora para todo mundo, sem atualizar a extensão.

Por baixo: o **Jev** (`typesafe/jev-1.13`) lê a conversa a cada poucas falas e
marca etapas, objeção e alertas; o Claude Haiku escreve a sugestão e o Claude
Sonnet, o resumo. Custa uns US$ 0,14 por meia hora de call, com teto de gasto
por pessoa por dia.

**As calls ficam guardadas no servidor, por pessoa:** dia, horário, duração,
título, pessoas que falaram, transcrição, quanto cada lado falou, etapas,
resumo e custo. Cada um só vê as suas (toda leitura filtra pelo e-mail do
login). O histórico que estava só no navegador (até a 0.7) é levado ao servidor
uma vez, no primeiro login.

## O intermediário (`intermediario/`)

Um serviço pequeno, só com a biblioteca padrão do Python, que roda na VM
`coaching-tools` atrás de `https://intake.gravae.io/copiloto/`:

- `POST /codigo` e `POST /verificar`: login por código de 6 dígitos mandado ao
  e-mail `@gravae.io` (SendGrid); vale 10 minutos, no máximo 3 códigos a cada
  10 minutos e 5 tentativas por código; devolve uma sessão assinada (30 dias);
- `GET /entrar` e `GET /callback`: login Google, desligado na extensão; passa a
  servir se `BASE_URL/callback` for cadastrado no cliente OAuth;
- `POST /v1/calls/<id>/sincronizar`: a extensão manda a call (metadados e as
  falas que mudaram); o servidor guarda (`calls.py`, SQLite) e roda o copiloto
  (`copiloto.py`), um fio por call ao vivo; no fim, escreve o resumo;
- `GET /v1/calls`, `/v1/calls/busca?q=`, `/v1/calls/<id>`, `/v1/calls/<id>/estado`,
  `POST /v1/calls/<id>/copiloto`, `/v1/calls/<id>/resumir`, `/v1/calls/importar`,
  `DELETE /v1/calls/<id>`: sempre só as calls de quem pede;
- `GET /app/painel.html` e `/app/agenda.html` (`app/`): as telas, que só abrem
  dentro da extensão (`frame-ancestors`); `/app/meet-seletores.json`: onde ler as
  legendas do Meet (a extensão busca uma vez por dia);
- `POST /v1/jev` e `POST /v1/chat`: o Jev e o LLM direto, para a extensão 0.7
  (que rodava o copiloto nela);
- `POST /v1/renovar`: troca a sessão por uma nova (a extensão renova sozinha
  quando faltam menos de 10 dias);
- `GET /v1/roteiro` e `GET /v1/eu`: o roteiro e o gasto do dia.

Configuração em `/etc/gravae-copiloto.env` (modelo em
`gravae-copiloto.env.exemplo`), serviço em `gravae-copiloto.service`. Testes sem
rede: `python intermediario/teste_local.py` (as rotas, inclusive "outra pessoa não
vê") e `python intermediario/teste_copiloto.py` (o cérebro).

## Agenda de calls

O ícone de calendário no popup abre a agenda (servida pelo servidor, com as
calls de quem está logado): as chamadas numa semana como a do
Google Agenda, cada uma do tamanho que durou, com a call em andamento marcada ao
vivo. Clicando numa call, aparecem o resumo do copiloto e a transcrição inteira,
com a cor de cada pessoa e busca. Dá para buscar em todas as transcrições,
baixar, copiar, apagar e gerar o resumo de uma call que acabou sem ele.

## Publicar uma versão nova

A `main` deste repositório é a única fonte. Para publicar:

1. Suba a versão em `extensao/manifest.json` (`"version"`) se mudou a extensão.
2. Commit e push na `main`.

Em até 2 minutos, a VM `coaching-tools` (`intermediario/sincronizar.sh`, pelo
timer `gravae-copiloto-sincronizar`) puxa a `main` e atualiza sozinha:

- o **intermediário**, só se o `servico.py` mudou; ele é conferido antes, e se o
  novo não subir, volta o anterior e o commit fica de fora até o próximo.
  Reiniciar não desloga ninguém;
- a **página de instalação** (`intermediario/pagina/`);
- o **`.zip` da extensão** em `/copiloto/baixar/transcritor-gravae.zip` e a
  versão em `/copiloto/versao`.

A extensão compara a versão dela com `/copiloto/versao` e avisa no popup quando
há uma nova, com o link do "como atualizar".

## Estrutura

```
extensao/
  manifest.json
  background.js        selo REC, download ao sair ou ao fechar a aba, entrada nas abas já abertas,
                       login, envio das calls ao servidor, importação do histórico
  lib/falas.js         blocos de legenda → falas (sem DOM, testado no Node)
  lib/formato.js       Markdown, texto e nome do arquivo
  meet/seletores.js    tudo que depende do HTML do Meet
  meet/meet.js         content script: legendas, falas para o servidor, diagnóstico, aviso de idioma
  popup/               lista, opções e controles do copiloto
  lib/config.js        o endereço do servidor
  lib/casca.js         abre as telas do servidor (painel e agenda) e entrega o login
  copiloto/            o painel lateral (casca do intermediario/app/painel.html)
  agenda/              a agenda (casca do intermediario/app/agenda.html)
  fontes/              Space Grotesk e Open Sans (SIL OFL, licenças junto)
  icones/              o G. da Gravaê
intermediario/         o servidor (ver acima): servico.py, copiloto.py (o cérebro), calls.py
                       (as calls por pessoa), app/ (as telas), pagina/ (instalação) e o
                       sincronizar.sh que publica a main na VM
testes/
  falas.test.js        node --test testes/falas.test.js
  meet-falso.html      página que imita o Meet para testar sem chamada
```

## Quando parar de funcionar

O Meet muda o HTML de vez em quando, e o ajuste é em `extensao/meet/seletores.js`.
A extensão se apoia no texto dos ícones (`call_end`, `closed_caption_off`) e na
área `div[role="region"]` com nome de legendas (`aria-label` "Legendas",
"Captions", "Subtítulos"…), onde cada bloco tem a foto e o nome e, depois, o
texto. O [TranscripTonic](https://github.com/vivek-nexus/transcriptonic)
acompanha essas mudanças e é uma boa referência.

Se a transcrição falhar com alguém, peça para abrir o popup durante a chamada e
clicar em **Diagnóstico**: ele copia a estrutura da área das legendas (com o
texto cortado em 40 caracteres) para colar numa mensagem. É o que mostra o que o
Google mudou.

Para testar sem uma chamada: sirva a pasta do projeto
(`python -m http.server 8765`), abra `http://127.0.0.1:8765/testes/meet-falso.html`
e rode `simular()` no console. O resultado fica em `guardado.local`, e o que vai
para o copiloto (no service worker), em `mensagens`.
