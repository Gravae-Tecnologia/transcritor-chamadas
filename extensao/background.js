// Service worker: marca a aba que está transcrevendo e baixa o arquivo quando
// a chamada acaba — seja pelo botão de sair, seja fechando a aba.
importScripts('lib/formato.js')

const CONFIG_PADRAO = { automatico: true, baixarAoSair: true, esconderLegendas: false, meuNome: '' }

async function baixar(reuniao, extensao = 'md') {
  const conteudo = extensao === 'txt' ? Formato.paraTexto(reuniao) : Formato.paraMarkdown(reuniao)
  const tipo = extensao === 'txt' ? 'text/plain' : 'text/markdown'
  await chrome.downloads.download({
    url: `data:${tipo};charset=utf-8,` + encodeURIComponent(conteudo),
    filename: Formato.nomeArquivo(reuniao, extensao),
    conflictAction: 'uniquify',
    saveAs: false
  })
}

async function aoEncerrar(id) {
  const chave = 'reuniao:' + id
  const reuniao = (await chrome.storage.local.get(chave))[chave]
  if (!reuniao) return
  if (!reuniao.fim) {
    const ultima = reuniao.falas[reuniao.falas.length - 1]
    reuniao.fim = ultima ? ultima.hora : new Date().toISOString()
    await chrome.storage.local.set({ [chave]: reuniao })
  }
  const config = await chrome.storage.sync.get(CONFIG_PADRAO)
  if (config.baixarAoSair && reuniao.falas.length && !reuniao.baixado) {
    await baixar(reuniao)
    reuniao.baixado = true
    await chrome.storage.local.set({ [chave]: reuniao })
  }
}

// ---------- pegar a chamada em andamento, sem F5 ----------

// O Chrome só põe o content script nas páginas abertas depois de instalar ou
// atualizar a extensão. Para as que já estavam abertas, injeta na mão — a não
// ser que já tenha um rodando e respondendo.
async function garantirNaAba(abaId) {
  try {
    const resposta = await chrome.tabs.sendMessage(abaId, { tipo: 'ping' })
    if (resposta && resposta.ok) return { ja: true, ...resposta }
  } catch {}
  await chrome.scripting.executeScript({
    target: { tabId: abaId },
    files: ['lib/falas.js', 'meet/seletores.js', 'meet/meet.js']
  })
  return { ja: false, injetado: true }
}

async function garantirEmTodas() {
  const abas = await chrome.tabs.query({ url: 'https://meet.google.com/*' })
  for (const aba of abas) garantirNaAba(aba.id).catch(() => {})
}

chrome.runtime.onInstalled.addListener(garantirEmTodas)

// ---------- áudio de qualquer aba, transcrito pelo programa do PC ----------

// O popup pede, o service worker pega o id do stream da aba, e o documento
// offscreen (aba/offscreen.js) captura e manda ao Transcritor do PC. O estado
// de cada aba fica em storage.session "captura:<aba>" para o popup mostrar.
async function garantirOffscreen() {
  const existentes = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
  if (existentes.length) return
  await chrome.offscreen.createDocument({
    url: 'aba/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capturar o áudio da aba para o Transcritor de Chamadas do PC'
  })
}

async function transcreverAba({ aba, titulo, url, microfone }) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: aba })
  await garantirOffscreen()
  const r = await chrome.runtime.sendMessage({ alvo: 'offscreen', tipo: 'capturar', aba, streamId, titulo, url, microfone })
  if (r && r.ok) {
    await chrome.storage.session.set({ ['captura:' + aba]: { titulo, desde: Date.now(), linhas: [], arquivo: null } })
    chrome.action.setBadgeBackgroundColor({ tabId: aba, color: '#1a73e8' })
    chrome.action.setBadgeText({ tabId: aba, text: 'TXT' })
  }
  return r
}

async function eventoDaAba(aba, dado) {
  const chave = 'captura:' + aba
  const atual = (await chrome.storage.session.get(chave))[chave]
  if (!atual) return
  if (dado.tipo === 'ok') atual.arquivo = dado.arquivo
  if (dado.tipo === 'linha') atual.linhas = [...atual.linhas, `${dado.t.slice(0, 8)} ${dado.texto}`].slice(-4)
  if (dado.tipo === 'salvo' || dado.tipo === 'fechado') {
    await chrome.storage.session.remove(chave)
    await chrome.storage.session.set({ ultimaCaptura: { titulo: atual.titulo, arquivo: dado.arquivo || atual.arquivo } })
    chrome.action.setBadgeText({ tabId: aba, text: '' }).catch(() => {})
    return
  }
  await chrome.storage.session.set({ [chave]: atual })
}

chrome.runtime.onMessage.addListener((mensagem, remetente, responder) => {
  if (mensagem.alvo === 'offscreen') return
  if (mensagem.tipo === 'aba-transcrever') {
    transcreverAba(mensagem)
      .then(responder)
      .catch((erro) => responder({ erro: String(erro.message || erro) }))
    return true
  }
  if (mensagem.tipo === 'aba-parar') {
    chrome.runtime.sendMessage({ alvo: 'offscreen', tipo: 'parar', aba: mensagem.aba }).then(responder, () => responder({}))
    return true
  }
  if (mensagem.tipo === 'aba-evento') {
    eventoDaAba(mensagem.aba, mensagem.dado)
    return
  }

  if (mensagem.tipo === 'garantir') {
    garantirNaAba(mensagem.aba)
      .then(responder)
      .catch((erro) => responder({ erro: String(erro.message || erro) }))
    return true
  }

  const aba = remetente.tab && remetente.tab.id
  if (mensagem.tipo === 'reuniao-iniciada' && aba != null) {
    chrome.storage.session.set({ ['aba:' + aba]: mensagem.id })
    chrome.action.setBadgeBackgroundColor({ tabId: aba, color: '#ea4335' })
    chrome.action.setBadgeText({ tabId: aba, text: 'REC' })
  }
  if (mensagem.tipo === 'reuniao-encerrada') {
    if (aba != null) {
      chrome.storage.session.remove('aba:' + aba)
      chrome.action.setBadgeText({ tabId: aba, text: '' })
    }
    aoEncerrar(mensagem.id)
  }
})

// Fechou a aba no meio da chamada: o content script não tem tempo de avisar,
// mas a transcrição já está salva até os últimos segundos.
chrome.tabs.onRemoved.addListener(async (aba) => {
  const captura = (await chrome.storage.session.get('captura:' + aba))['captura:' + aba]
  if (captura) chrome.runtime.sendMessage({ alvo: 'offscreen', tipo: 'parar', aba }).catch(() => {})

  const chave = 'aba:' + aba
  const id = (await chrome.storage.session.get(chave))[chave]
  if (!id) return
  await chrome.storage.session.remove(chave)
  aoEncerrar(id)
})
