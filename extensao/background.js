// Service worker: marca a aba que está transcrevendo, liga a chamada ao
// Transcritor do PC (a ponte) e baixa o arquivo quando a chamada acaba — seja
// pelo botão de sair, seja fechando a aba.
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
  // Com o Transcritor do PC ligado, o arquivo fica com ele (Downloads/Transcricoes).
  const noPc = (await chrome.storage.session.get('ponte:' + id))['ponte:' + id]
  if (noPc) ponte.enviar({ tipo: 'meet-fim', reuniao_id: id })
  if (config.baixarAoSair && !noPc && reuniao.falas.length && !reuniao.baixado) {
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
    chrome.action.setBadgeBackgroundColor({ tabId: aba, color: '#52525b' })
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

// ---------- a ponte com o Transcritor do PC ----------

// Com o programa do PC aberto, a chamada do Meet vai para ele pelas legendas:
// o nome real de cada pessoa, o copiloto e o arquivo na mesma pasta das outras
// calls. O meet.js manda as falas; aqui só se leva e traz pelo WebSocket. Se a
// conexão cair (o programa reiniciou), ao voltar o meet.js manda tudo de novo
// e o programa ignora o que já tinha.
const PONTE_URL = 'ws://127.0.0.1:8766'
const VERSAO = chrome.runtime.getManifest().version

const ponte = {
  ws: null,
  aberta: false,
  pedidos: new Map(),
  n: 0,
  ping: null,
  tentativa: null,
  ultimaTentativa: 0,
  reunioes: new Set(), // chamadas do Meet em andamento, que mantêm a ponte aberta

  conectar() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return
    clearTimeout(this.tentativa)
    this.ultimaTentativa = Date.now()
    let ws
    try {
      ws = new WebSocket(PONTE_URL)
    } catch {
      return this.depois()
    }
    this.ws = ws
    ws.onopen = () => {
      this.aberta = true
      ws.send(JSON.stringify({ tipo: 'ponte-ola', versao: VERSAO }))
      clearInterval(this.ping)
      // Mensagem a cada 20 s mantém o service worker vivo (Chrome 116+) e diz ao
      // programa que a chamada continua.
      // Sem chamada (o popup só perguntou se o programa está aberto), fecha.
      this.ping = setInterval(() => {
        if (this.reunioes.size) this.enviar({ tipo: 'ponte-ping' })
        else if (this.ws) this.ws.close()
      }, 20000)
      chrome.storage.session.set({ ponte: { conectado: true, desde: Date.now() } })
      avisarAbasDoMeet({ tipo: 'ponte-conectada' })
    }
    ws.onmessage = (evento) => {
      let dados
      try {
        dados = JSON.parse(evento.data)
      } catch {
        return
      }
      if (dados.tipo === 'ponte-ok') chrome.storage.session.set({ ponte: { conectado: true, desde: Date.now(), versao: dados.versao } })
      if (dados.tipo === 'meet-sessao') {
        chrome.storage.session.set({ ['ponte:' + dados.reuniao_id]: { sessao: dados.sessao, arquivo: dados.arquivo } })
        avisarAbasDoMeet({ tipo: 'ponte-sessao', reuniao_id: dados.reuniao_id, sessao: dados.sessao })
      }
      const pedido = dados.n != null && this.pedidos.get(dados.n)
      if (pedido) {
        this.pedidos.delete(dados.n)
        pedido(dados)
      }
    }
    ws.onclose = () => {
      const eraAberta = this.aberta
      this.aberta = false
      this.ws = null
      clearInterval(this.ping)
      for (const pedido of this.pedidos.values()) pedido({ erro: 'O Transcritor do PC fechou a conexão.' })
      this.pedidos.clear()
      if (eraAberta) {
        chrome.storage.session.set({ ponte: { conectado: false } })
        avisarAbasDoMeet({ tipo: 'ponte-caiu' })
      }
      this.depois()
    }
  },

  // Sem o programa aberto, tenta de novo a cada 15 s enquanto houver chamada.
  depois() {
    clearTimeout(this.tentativa)
    if (this.reunioes.size) this.tentativa = setTimeout(() => this.conectar(), 15000)
  },

  enviar(dados) {
    if (!this.aberta) {
      // Programa fechado: uma tentativa a cada 15 s, não uma por fala.
      if (Date.now() - this.ultimaTentativa > 15000) this.conectar()
      return false
    }
    this.ws.send(JSON.stringify(dados))
    return true
  },

  // Pergunta e espera a resposta (para o popup).
  pedir(dados, espera = 3000) {
    return new Promise((resolve) => {
      const enviar = () => {
        const n = ++this.n
        const fim = setTimeout(() => {
          this.pedidos.delete(n)
          resolve({ erro: 'O Transcritor do PC não respondeu.' })
        }, espera)
        this.pedidos.set(n, (r) => {
          clearTimeout(fim)
          resolve(r)
        })
        this.ws.send(JSON.stringify({ ...dados, n }))
      }
      if (this.aberta) return enviar()
      this.conectar()
      const ws = this.ws
      if (!ws) return resolve({ erro: 'Transcritor do PC fechado.' })
      const fim = setTimeout(() => resolve({ erro: 'Transcritor do PC fechado.' }), 1500)
      ws.addEventListener('open', () => {
        clearTimeout(fim)
        setTimeout(enviar, 50)
      })
      ws.addEventListener('close', () => {
        clearTimeout(fim)
        resolve({ erro: 'Transcritor do PC fechado.' })
      })
    })
  }
}

async function avisarAbasDoMeet(mensagem) {
  const abas = await chrome.tabs.query({ url: 'https://meet.google.com/*' })
  for (const aba of abas) chrome.tabs.sendMessage(aba.id, mensagem).catch(() => {})
}

function mensagemDaPonte(dados) {
  if (dados.tipo === 'meet-inicio') ponte.reunioes.add(dados.reuniao.id)
  if (dados.tipo === 'meet-fim') {
    ponte.reunioes.delete(dados.reuniao_id)
    // Sem chamada, a ponte fecha: o service worker pode dormir.
    if (!ponte.reunioes.size) setTimeout(() => !ponte.reunioes.size && ponte.ws && ponte.ws.close(), 5000)
  }
  return ponte.enviar(dados)
}

chrome.runtime.onMessage.addListener((mensagem, remetente, responder) => {
  if (mensagem.alvo === 'offscreen') return

  if (mensagem.tipo === 'ponte') {
    responder({ enviado: mensagemDaPonte(mensagem.dados) })
    return
  }
  if (mensagem.tipo === 'ponte-pedir') {
    ponte.pedir(mensagem.dados).then(responder)
    return true
  }
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
    chrome.action.setBadgeBackgroundColor({ tabId: aba, color: '#d30404' })
    chrome.action.setBadgeText({ tabId: aba, text: 'REC' })
  }
  if (mensagem.tipo === 'reuniao-encerrada') {
    ponte.reunioes.delete(mensagem.id)
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
  ponte.reunioes.delete(id)
  aoEncerrar(id)
})
