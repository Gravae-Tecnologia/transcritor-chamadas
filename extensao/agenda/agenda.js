// Agenda de calls: abre a agenda do servidor (as calls de quem está logado) e,
// se veio do popup ou do painel ("#reuniao=<id>"), diz qual call abrir. Antes, o
// histórico que só estava no navegador vai para o servidor (uma vez).
const casca = abrirCasca('agenda.html')

function pedida() {
  const abrir = new URLSearchParams(location.hash.slice(1)).get('reuniao')
  casca.definir({ abrir: abrir || null })
}
addEventListener('hashchange', pedida)
chrome.runtime.sendMessage({ tipo: 'importar-historico' }).catch(() => {}).finally(pedida)
