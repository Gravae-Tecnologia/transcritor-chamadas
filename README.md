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
4. Fixe o ícone (balão azul) na barra do Chrome.

Já está numa chamada? Não precisa recarregar: ao ser instalada, a extensão entra
sozinha nas abas do Meet que já estavam abertas. Se o aviso "Transcrevendo" não
aparecer, abra o popup e clique em **Transcrever esta chamada**.

## Como funciona

- Ao entrar na chamada, a extensão liga as legendas e mostra no canto de cima
  "Transcrevendo · N falas". O ícone ganha o selo **REC**.
- Cada bloco de legenda vira uma fala. Quando o Meet corrige uma palavra já
  escrita, a fala é atualizada no lugar, sem repetir.
- Se você entrou no meio, ela pega também o que ainda está no histórico das
  legendas na tela.
- A transcrição fica salva no navegador a cada 2 s. Ao sair da chamada (pelo
  botão, quando ela acaba ou fechando a aba), baixa um `.md` em
  `Downloads/Transcricoes/AAAA-MM-DD HHhMM - título.md`.
- Se a aba recarregar no meio, a transcrição continua a mesma.
- No popup: a lista das chamadas, baixar `.md` ou `.txt`, copiar e apagar. Nas
  opções: transcrever sozinho, baixar ao sair, esconder as legendas da tela e o
  seu nome no lugar de "Você".

O idioma da transcrição é o das legendas do Meet (**Configurações › Legendas**).

**Avise quem está na chamada** que ela está sendo transcrita.

## Estrutura

```
extensao/
  manifest.json
  background.js        selo REC, download ao sair ou ao fechar a aba, entrada nas abas já abertas
  lib/falas.js         blocos de legenda → falas (sem DOM, testado no Node)
  lib/formato.js       Markdown, texto e nome do arquivo
  meet/seletores.js    tudo que depende do HTML do Meet
  meet/meet.js         content script
  popup/               lista e opções
  aba/                 integração opcional com um transcritor de áudio local (não incluso);
                       sem ele, nada disso aparece
testes/
  falas.test.js        node --test testes/falas.test.js
  meet-falso.html      página que imita o Meet para testar sem chamada
  gerar-icones.js      node testes/gerar-icones.js
```

## Quando parar de funcionar

O Meet muda o HTML de vez em quando, e o ajuste é em `extensao/meet/seletores.js`.
A extensão se apoia no texto dos ícones (`call_end`, `closed_caption_off`) e na
região `div[role="region"][tabindex="0"]`, onde cada bloco tem o nome e, logo
depois, o texto. O [TranscripTonic](https://github.com/vivek-nexus/transcriptonic)
acompanha essas mudanças e é uma boa referência.

Para testar sem uma chamada: sirva a pasta do projeto
(`python -m http.server 8765`), abra `http://127.0.0.1:8765/testes/meet-falso.html`
e rode `simular()` no console. O resultado fica em `guardado.local`.
