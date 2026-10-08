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
  // Área das legendas. Existe mesmo com elas desligadas. Não basta pegar a
  // primeira "região" da página: o chat, a lista de pessoas e a apresentação
  // também são regiões, e em 07/10 a extensão passou a observar uma delas no
  // meio da call (só as primeiras falas foram salvas). Vale a que tem o nome
  // de legendas; sem nome conhecido, a que tem blocos com foto.
  REGIOES: 'div[role="region"]',
  REGIAO_LEGENDAS: 'div[role="region"][tabindex="0"]',
  ROTULO_LEGENDAS: /legenda|caption|subt[ií]tulo|sous-titre|untertitel|sottotitol/i,
  // Nome de quem está logado, na tela de entrada da chamada.
  NOME_USUARIO: '.awLEm',
  // Nome da reunião, no canto de baixo à esquerda.
  TITULO: '.u6vdEc',
  // Como o Meet chama você nas legendas.
  VOCE: ['Você', 'You', 'Vous', 'Tú', 'Tu']
}
