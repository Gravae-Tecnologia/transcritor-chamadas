// Painel lateral: abre o painel do copiloto do servidor e diz a ele qual call
// está na aba ativa (o service worker marca em storage.session "copiloto-aba:<aba>").
const casca = abrirCasca('painel.html')

async function acharReuniao() {
  const [aba] = await chrome.tabs.query({ active: true, currentWindow: true })
  const chave = 'copiloto-aba:' + (aba ? aba.id : '')
  const reuniao = aba ? (await chrome.storage.session.get(chave))[chave] || null : null
  casca.definir({ reuniao })
}

chrome.tabs.onActivated.addListener(acharReuniao)
chrome.tabs.onUpdated.addListener((_id, mudou) => mudou.status === 'complete' && acharReuniao())
chrome.storage.onChanged.addListener((mudancas, area) => {
  if (area === 'session' && Object.keys(mudancas).some((k) => k.startsWith('copiloto-aba:'))) acharReuniao()
})
acharReuniao()
