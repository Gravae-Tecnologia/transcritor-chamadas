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

1. Baixe este repositório (**Code › Download ZIP**) e descompacte.
2. Abra `chrome://extensions` e ligue o **Modo do desenvolvedor**, no canto de cima à direita.
3. Clique em **Carregar sem compactação** e escolha a pasta `extensao/`.
4. Fixe o ícone (o **G.** da Gravaê) na barra do Chrome.

Já está numa chamada? Não precisa recarregar: ao ser instalada ou atualizada, a
extensão entra sozinha nas abas do Meet que já estavam abertas. Se o aviso
"Transcrevendo" não aparecer, abra o popup e clique em **Transcrever esta chamada**.

Para atualizar: baixe de novo, troque a pasta e clique em ↻ na extensão, em
`chrome://extensions`.

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

## Com o Transcritor do PC (opcional)

A extensão conversa com o **Transcritor de Chamadas do PC**, um programa à parte
(não incluso neste repositório) que transcreve qualquer programa com o Whisper
local e tem um copiloto de vendas. Com ele aberto:

- a chamada do Meet vai para o programa pelas legendas, com o nome de cada pessoa,
  e o arquivo, o histórico e o copiloto ficam com ele (o `.md` da extensão não é
  baixado, mas continua no popup);
- o popup mostra **PC conectado**, o interruptor do copiloto, **Abrir no
  Transcritor** e **Diagnóstico**;
- dá para transcrever o áudio de qualquer aba (**Áudio desta aba**).

Sem o programa, nada disso aparece além do selo **PC fechado**, e a extensão
funciona sozinha.

A conversa é por um WebSocket local (`ws://127.0.0.1:8766`), descrito no começo
de `extensao/background.js` (cliente) e no programa do PC (servidor):
`ponte-ola`, `ponte-ping`, `meet-inicio`, `meet-fala` (a mesma `i` de novo é
correção), `meet-fim`, `meet-diagnostico`, `ponte-sessao`, `ponte-copiloto` e
`ponte-abrir`. Se a conexão cai, ao voltar a extensão manda todas as falas de
novo e o programa ignora as que já tinha.

## Estrutura

```
extensao/
  manifest.json
  background.js        selo REC, download ao sair ou ao fechar a aba, entrada nas abas já abertas,
                       ponte com o Transcritor do PC
  lib/falas.js         blocos de legenda → falas (sem DOM, testado no Node)
  lib/formato.js       Markdown, texto e nome do arquivo
  meet/seletores.js    tudo que depende do HTML do Meet
  meet/meet.js         content script: legendas, envio ao PC, diagnóstico, aviso de idioma
  popup/               lista, opções e controles do Transcritor do PC
  aba/                 áudio de uma aba para o Transcritor do PC
  fontes/              Space Grotesk e Open Sans (SIL OFL, licenças junto)
  icones/              o G. da Gravaê
testes/
  falas.test.js        node --test testes/falas.test.js
  meet-falso.html      página que imita o Meet para testar sem chamada
```

## Quando parar de funcionar

O Meet muda o HTML de vez em quando, e o ajuste é em `extensao/meet/seletores.js`.
A extensão se apoia no texto dos ícones (`call_end`, `closed_caption_off`) e na
região `div[role="region"][tabindex="0"]`, onde cada bloco tem o nome e, logo
depois, o texto. O [TranscripTonic](https://github.com/vivek-nexus/transcriptonic)
acompanha essas mudanças e é uma boa referência.

Com o Transcritor do PC aberto, o botão **Diagnóstico** do popup (e um envio
automático 20 s depois da primeira legenda) manda ao programa a estrutura da área
das legendas, para ver o que o Google mudou. Nada sai do computador.

Para testar sem uma chamada: sirva a pasta do projeto
(`python -m http.server 8765`), abra `http://127.0.0.1:8765/testes/meet-falso.html`
e rode `simular()` no console. O resultado fica em `guardado.local`, e o que iria
para o Transcritor do PC, em `mensagens`.
