// Service worker: marca a aba que está transcrevendo, roda o copiloto de vendas
// e baixa o arquivo quando a chamada acaba — seja pelo botão de sair, seja
// fechando a aba.
importScripts('lib/formato.js', 'lib/copiloto.js')

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
  encerrarCopiloto(id, reuniao).catch(() => {})
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

// ---------- o copiloto de vendas ----------

// As falas que o meet.js manda alimentam um Copiloto (lib/copiloto.js) por
// chamada, que lê com o Jev e sugere a próxima frase. O estado vai para
// storage.local "copiloto:<reunião>", que o painel lateral (copiloto/painel.html)
// e a agenda (agenda/agenda.html) desenham. Se o service worker dormir, volta
// de lá. Precisa da chave da OpenRouter (opções do popup) e do roteiro
// (copiloto/roteiro.json, ou um importado nas opções).
const COPILOTO_PADRAO = { chaveOpenrouter: '', copilotoAutomatico: true }
const copilotos = new Map() // reunião -> { cop, falas, titulo, inicio, encerrando }
let roteiroEmCache = null
let relogio = null

async function roteiroAtual() {
  const { roteiroImportado } = await chrome.storage.local.get('roteiroImportado')
  if (roteiroImportado) return roteiroImportado
  if (roteiroEmCache === null) {
    try {
      roteiroEmCache = await (await fetch(chrome.runtime.getURL('copiloto/roteiro.json'))).json()
    } catch {
      roteiroEmCache = false
    }
  }
  return roteiroEmCache || null
}

async function configCopiloto() {
  return chrome.storage.local.get(COPILOTO_PADRAO)
}

async function copilotoDisponivel() {
  const [roteiro, config] = await Promise.all([roteiroAtual(), configCopiloto()])
  return Boolean(roteiro && config.chaveOpenrouter)
}

async function copilotoDe(id, info = {}) {
  if (copilotos.has(id)) return copilotos.get(id)
  const roteiro = await roteiroAtual()
  if (!roteiro) return null
  const config = await configCopiloto()
  const { ['copiloto:' + id]: salvo, ['reuniao:' + id]: reuniao } = await chrome.storage.local.get(['copiloto:' + id, 'reuniao:' + id])
  if (copilotos.has(id)) return copilotos.get(id) // outra mensagem chegou enquanto lia o storage
  const guardado = salvo ? salvo.guardado : { ativo: config.copilotoAutomatico && Boolean(config.chaveOpenrouter) }
  const cop = new Copilotagem.Copiloto(roteiro, { chave: config.chaveOpenrouter }, guardado)
  const item = {
    cop,
    falas: reuniao ? reuniao.falas.map((f) => ({ ...f })) : [],
    titulo: info.titulo || (salvo && salvo.titulo) || (reuniao && reuniao.titulo) || 'Google Meet',
    inicio: info.inicio || (reuniao && reuniao.inicio) || new Date().toISOString(),
    encerrando: null
  }
  cop.atualizar(item.falas, item.inicio)
  copilotos.set(id, item)
  if (!relogio) relogio = setInterval(rodarCopilotos, 1000)
  return item
}

async function salvarCopiloto(id) {
  const item = copilotos.get(id)
  if (!item) return
  await chrome.storage.local.set({
    ['copiloto:' + id]: { guardado: item.cop.paraGuardar(), estado: item.cop.estado(), titulo: item.titulo, atualizado: new Date().toISOString() }
  })
}

async function rodarCopilotos() {
  for (const [id, item] of copilotos) {
    if (item.encerrando) continue
    if (await item.cop.passo()) salvarCopiloto(id)
  }
}

// O que o meet.js manda: o começo da chamada e cada fala que mudou.
async function mensagemDoMeet(dados) {
  if (dados.tipo === 'meet-inicio' && (await copilotoDisponivel())) {
    await copilotoDe(dados.reuniao.id, { titulo: dados.reuniao.titulo, inicio: dados.reuniao.inicio })
    salvarCopiloto(dados.reuniao.id)
  }
  if (dados.tipo === 'meet-fala') {
    const item = await copilotoDe(dados.reuniao_id)
    if (!item) return
    item.falas[dados.i] = { nome: dados.nome, eu: dados.eu, texto: dados.texto, hora: dados.hora }
    item.cop.atualizar(item.falas, item.inicio)
  }
}

// Fim da chamada: o resumo (se o copiloto estava ligado) e o fim do relógio.
async function encerrarCopiloto(id, reuniao) {
  const item = await copilotoDe(id)
  if (!item || item.encerrando) return item && item.encerrando
  item.encerrando = (async () => {
    if (reuniao) item.falas = reuniao.falas.map((f) => ({ ...f }))
    item.cop.atualizar(item.falas, item.inicio)
    if (item.cop.ativo && !item.cop.resumo && item.cop.falas.length) {
      // O resumo leva até 1 min; chamar uma API do Chrome a cada 20 s segura o service worker acordado.
      const acordado = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000)
      try {
        await item.cop.resumir(item.titulo)
      } catch (e) {
        item.cop.erro = 'Resumo: ' + String(e.message || e).slice(0, 160)
      } finally {
        clearInterval(acordado)
      }
    }
    await salvarCopiloto(id)
    copilotos.delete(id)
    if (!copilotos.size) relogio = clearInterval(relogio) || null
  })()
  return item.encerrando
}

// Resumo pedido depois (na agenda), de uma chamada que acabou sem resumo.
async function resumirDepois(id) {
  const { ['reuniao:' + id]: reuniao } = await chrome.storage.local.get('reuniao:' + id)
  if (!reuniao) return { erro: 'Chamada não encontrada.' }
  if (!(await copilotoDisponivel())) return { erro: 'O copiloto precisa da chave da OpenRouter e do roteiro (opções do popup).' }
  copilotos.delete(id)
  const item = await copilotoDe(id, { titulo: reuniao.titulo, inicio: reuniao.inicio })
  item.cop.ativo = true
  item.cop.resumo = null
  await encerrarCopiloto(id, reuniao)
  const { ['copiloto:' + id]: salvo } = await chrome.storage.local.get('copiloto:' + id)
  return salvo && salvo.estado.resumo ? { ok: true } : { erro: (salvo && salvo.estado.erro) || 'O resumo não saiu.' }
}

// ---------- mensagens ----------

chrome.runtime.onMessage.addListener((mensagem, remetente, responder) => {
  if (mensagem.tipo === 'meet') {
    mensagemDoMeet(mensagem.dados).catch(() => {})
    return
  }
  if (mensagem.tipo === 'copiloto-ligar') {
    copilotoDe(mensagem.reuniao).then(async (item) => {
      if (!item) return responder({ erro: 'Sem roteiro do copiloto.' })
      const { chaveOpenrouter } = await configCopiloto()
      item.cop.chave = chaveOpenrouter
      item.cop.ligar(Boolean(mensagem.ativo))
      await salvarCopiloto(mensagem.reuniao)
      responder({ ok: true })
    })
    return true
  }
  if (mensagem.tipo === 'copiloto-sugerir') {
    copilotoDe(mensagem.reuniao).then((item) => {
      if (item) item.cop.pedirSugestao()
      responder({ ok: Boolean(item) })
    })
    return true
  }
  if (mensagem.tipo === 'copiloto-resumir') {
    resumirDepois(mensagem.reuniao).then(responder, (e) => responder({ erro: String(e.message || e) }))
    return true
  }
  if (mensagem.tipo === 'copiloto-disponivel') {
    copilotoDisponivel().then((disponivel) => responder({ disponivel }))
    return true
  }
  if (mensagem.tipo === 'garantir') {
    garantirNaAba(mensagem.aba)
      .then(responder)
      .catch((erro) => responder({ erro: String(erro.message || erro) }))
    return true
  }

  const aba = remetente.tab && remetente.tab.id
  if (mensagem.tipo === 'reuniao-iniciada' && aba != null) {
    // "copiloto-aba" fica até a aba fechar: o painel lateral mostra o resumo depois da chamada.
    chrome.storage.session.set({ ['aba:' + aba]: mensagem.id, ['copiloto-aba:' + aba]: mensagem.id })
    chrome.action.setBadgeBackgroundColor({ tabId: aba, color: '#d30404' })
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

chrome.storage.onChanged.addListener((mudancas, area) => {
  if (area !== 'local') return
  if (mudancas.chaveOpenrouter) for (const item of copilotos.values()) item.cop.chave = mudancas.chaveOpenrouter.newValue || ''
  if (mudancas.roteiroImportado) roteiroEmCache = null
})

// Fechou a aba no meio da chamada: o content script não tem tempo de avisar,
// mas a transcrição já está salva até os últimos segundos.
chrome.tabs.onRemoved.addListener(async (aba) => {
  chrome.storage.session.remove('copiloto-aba:' + aba)
  const chave = 'aba:' + aba
  const id = (await chrome.storage.session.get(chave))[chave]
  if (!id) return
  await chrome.storage.session.remove(chave)
  aoEncerrar(id)
})
