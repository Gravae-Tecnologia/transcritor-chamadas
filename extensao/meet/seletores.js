// Tudo o que depende do HTML do Meet fica aqui. Quando o Google mudar a
// página e a transcrição parar, é este arquivo que se ajusta.
//
// Os ícones do Meet são texto numa fonte de símbolos: o botão de sair tem o
// texto "call_end" e o de legendas "closed_caption_off" (desligadas) ou
// "closed_caption" (ligadas). Isso muda bem menos que as classes da página.
// Referência: TranscripTonic (github.com/vivek-nexus/transcriptonic), 2026.
// `var`, e não `const`, porque a extensão pode ser injetada de novo na mesma
// aba (ao ser atualizada no meio de uma chamada) e `const` repetido dá erro.
var SELETORES_MEET = {
  ICONE: '.google-symbols',
  ICONE_SAIR: 'call_end',
  ICONE_LEGENDA_DESLIGADA: 'closed_caption_off',
  ICONE_LEGENDA_LIGADA: 'closed_caption',
  // Área das legendas. Existe mesmo com elas desligadas.
  REGIAO_LEGENDAS: 'div[role="region"][tabindex="0"]',
  // Nome de quem está logado, na tela de entrada da chamada.
  NOME_USUARIO: '.awLEm',
  // Nome da reunião, no canto de baixo à esquerda.
  TITULO: '.u6vdEc',
  // Como o Meet chama você nas legendas.
  VOCE: ['Você', 'You', 'Vous', 'Tú', 'Tu']
}
