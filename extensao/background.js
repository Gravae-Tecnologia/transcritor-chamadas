// Service worker: marca a aba que está transcrevendo, manda cada call ao
// servidor da Gravaê (que guarda as calls por pessoa e roda o copiloto) e baixa
// o arquivo quando a chamada acaba — seja pelo botão de sair, seja fechando a aba.
//
// Desde a 0.8 o copiloto não roda mais aqui: o cérebro (intermediario/copiloto.py)
// e as telas do painel e da agenda (intermediario/app/) moram no servidor, que se
// atualiza sozinho a cada push na main. A extensão só lê as legendas, manda as
// falas e abre as telas do servidor.
importScripts('lib/config.js', 'lib/formato.js')

const CONFIG_PADRAO = { automatico: true, baixarAoSair: true, esconderLegendas: false, meuNome: '' }
const COPILOTO_PADRAO = { copilotoAutomatico: true }
const VERSAO = chrome.runtime.getManifest().version

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
  // O fim vai ao servidor: ele fecha a call e escreve o resumo do copiloto.
  sincronizar(id, true).catch(() => {})
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

chrome.runtime.onInstalled.addListener(() => {
  garantirEmTodas()
  buscarSeletores(true)
  importarHistorico()
})
chrome.runtime.onStartup.addListener(() => {
  buscarSeletores()
  importarHistorico()
})

// ---------- o login (código no e-mail da Gravaê) ----------

// O login fica no storage.local da extensão, que atualizar (git pull ou trocar os
// arquivos da pasta e clicar em ↻) não apaga: só remover a extensão apaga. E quem
// usa nunca precisa entrar de novo: faltando menos de 10 dias para vencer, a
// sessão é trocada por uma nova (mais 30 dias), sem a pessoa ver.
const RENOVAR_ANTES_MS = 10 * 86400000
let renovando = null

async function sessaoAtual() {
  const { sessaoCopiloto: s } = await chrome.storage.local.get('sessaoCopiloto')
  if (!(s && s.token && s.exp * 1000 > Date.now())) return null
  if (s.exp * 1000 - Date.now() < RENOVAR_ANTES_MS && !renovando) renovando = renovar(s).finally(() => (renovando = null))
  return s
}

async function renovar(s) {
  try {
    const r = await fetch(SERVIDOR + '/v1/renovar', { method: 'POST', headers: { Authorization: 'Bearer ' + s.token } })
    if (!r.ok) return
    const nova = lerSessao((await r.json()).token)
    if (nova) await chrome.storage.local.set({ sessaoCopiloto: nova })
  } catch {}
}

function lerSessao(token) {
  try {
    const dados = JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')))
    return { token, email: dados.email, exp: dados.exp }
  } catch {
    return null
  }
}

async function postarLogin(caminho, corpo) {
  const r = await fetch(SERVIDOR + caminho, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo)
  })
  const dados = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(dados.erro || `HTTP ${r.status}`)
  return dados
}

// 1) o servidor manda o código ao e-mail; 2) a pessoa digita e ganha a sessão (30 dias).
async function pedirCodigo(email) {
  return postarLogin('/codigo', { email })
}

async function verificarCodigo(email, codigo) {
  const dados = await postarLogin('/verificar', { email, codigo })
  const sessao = lerSessao(dados.token)
  if (!sessao) throw new Error('a sessão veio estranha')
  await chrome.storage.local.set({ sessaoCopiloto: sessao })
  importarHistorico()
  return sessao
}

// O servidor, com o login. Login recusado (vencido de verdade) volta a pedir o código.
async function api(caminho, { metodo = 'GET', corpo } = {}) {
  const sessao = await sessaoAtual()
  if (!sessao) throw new Error('sem login')
  const r = await fetch(SERVIDOR + caminho, {
    method: metodo,
    headers: { Authorization: 'Bearer ' + sessao.token, ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined
  })
  const dados = await r.json().catch(() => ({}))
  if (r.status === 401) await chrome.storage.local.remove('sessaoCopiloto')
  if (!r.ok) {
    const erro = new Error(dados.erro || `HTTP ${r.status}`)
    erro.status = r.status
    throw erro
  }
  return dados
}

// ---------- as calls no servidor ----------

// O meet.js manda o começo da call e cada fala que mudou; aqui elas vão ao
// servidor em lotes (só o que mudou desde o último envio). Se o service worker
// dormir, na volta manda tudo de novo, e o servidor só atualiza.
const metaDaAba = new Map() // reunião -> {id, codigo, titulo, url, inicio}
const falasDaAba = new Map() // reunião -> Map(i -> fala), as mais novas
const enviadas = new Map() // reunião -> Map(i -> marca do que o servidor já tem)
const agendadas = new Set()
let relogioEnvio = null

function agendarEnvio(id) {
  agendadas.add(id)
  clearTimeout(relogioEnvio)
  relogioEnvio = setTimeout(async () => {
    for (const id of [...agendadas]) {
      agendadas.delete(id)
      await sincronizar(id).catch(() => {})
    }
  }, 700)
}

const marca = (f) => `${f.nome}\u0001${f.texto}\u0001${f.eu ? 1 : 0}`

async function sincronizar(id, final = false) {
  if (!(await sessaoAtual())) return
  const { ['reuniao:' + id]: r } = await chrome.storage.local.get('reuniao:' + id)
  const meta = r || metaDaAba.get(id)
  if (!meta) return
  const todas = new Map()
  ;((r && r.falas) || []).forEach((f, i) => f && f.texto && todas.set(i, f))
  for (const [i, f] of falasDaAba.get(id) || []) todas.set(i, f)
  const ja = enviadas.get(id) || new Map()
  enviadas.set(id, ja)
  const mudadas = [...todas].filter(([i, f]) => ja.get(i) !== marca(f))
  if (!mudadas.length && !final && ja.size) return
  const { copilotoAutomatico } = await chrome.storage.local.get(COPILOTO_PADRAO)
  const fim = final ? (r && r.fim) || new Date().toISOString() : (r && r.fim) || null
  const base = { codigo: meta.codigo, titulo: meta.titulo, url: meta.url, inicio: meta.inicio, versao: VERSAO, copiloto_auto: copilotoAutomatico }
  // Em lotes de 300 (a primeira vez de uma call longa); o fim vai no último.
  for (let k = 0; ; k += 300) {
    const lote = mudadas.slice(k, k + 300)
    const ultimo = k + 300 >= mudadas.length
    await api(`/v1/calls/${encodeURIComponent(id)}/sincronizar`, {
      metodo: 'POST',
      corpo: { meta: { ...base, fim: ultimo ? fim : null }, falas: lote.map(([i, f]) => ({ i, nome: f.nome, eu: Boolean(f.eu), texto: f.texto, hora: f.hora })) }
    })
    for (const [i, f] of lote) ja.set(i, marca(f))
    if (ultimo) break
  }
}

function mensagemDoMeet(dados) {
  if (dados.tipo === 'meet-inicio') {
    metaDaAba.set(dados.reuniao.id, dados.reuniao)
    buscarSeletores()
    agendarEnvio(dados.reuniao.id)
  }
  if (dados.tipo === 'meet-fala') {
    if (!falasDaAba.has(dados.reuniao_id)) falasDaAba.set(dados.reuniao_id, new Map())
    falasDaAba.get(dados.reuniao_id).set(dados.i, { nome: dados.nome, eu: dados.eu, texto: dados.texto, hora: dados.hora })
    agendarEnvio(dados.reuniao_id)
  }
}

// O histórico que estava só no navegador (até a 0.7) vai para o servidor, uma
// vez por pessoa. O que fica no navegador continua lá (o popup lista e baixa).
let importando = null
function importarHistorico() {
  if (!importando) importando = importar().finally(() => (importando = null))
  return importando
}

async function importar() {
  const sessao = await sessaoAtual()
  if (!sessao) return
  const tudo = await chrome.storage.local.get(null)
  const feitos = (tudo.historicoNoServidor && tudo.historicoNoServidor[sessao.email]) || []
  const pendentes = Object.entries(tudo).filter(([k, r]) => k.startsWith('reuniao:') && r && r.id && !feitos.includes(r.id))
  for (const [, r] of pendentes) {
    const cop = tudo['copiloto:' + r.id]
    try {
      await api('/v1/calls/importar', {
        metodo: 'POST',
        corpo: {
          reuniao: { id: r.id, codigo: r.codigo, titulo: r.titulo, url: r.url, inicio: r.inicio, fim: r.fim, falas: r.falas },
          copiloto: cop && cop.guardado ? { guardado: cop.guardado, estado: cop.estado } : null
        }
      })
      feitos.push(r.id)
    } catch {
      break // sem rede: tenta na próxima vez
    }
  }
  const { historicoNoServidor = {} } = await chrome.storage.local.get('historicoNoServidor')
  await chrome.storage.local.set({ historicoNoServidor: { ...historicoNoServidor, [sessao.email]: feitos } })
}

// Onde ler as legendas do Meet: o servidor publica, a extensão guarda (uma vez
// por dia). Quando o Google muda a página, na maioria dos casos o conserto sai
// por lá, sem atualizar a extensão.
async function buscarSeletores(agora = false) {
  const { seletoresMeet } = await chrome.storage.local.get('seletoresMeet')
  if (!agora && seletoresMeet && Date.now() - seletoresMeet.em < 86400000) return
  try {
    const r = await fetch(SERVIDOR + '/app/meet-seletores.json', { cache: 'no-store' })
    if (r.ok) await chrome.storage.local.set({ seletoresMeet: { dados: await r.json(), em: Date.now() } })
  } catch {}
}

// ---------- mensagens ----------

chrome.runtime.onMessage.addListener((mensagem, remetente, responder) => {
  if (mensagem.tipo === 'meet') {
    mensagemDoMeet(mensagem.dados)
    return
  }
  if (mensagem.tipo === 'copiloto-ligar' || mensagem.tipo === 'copiloto-sugerir') {
    const corpo = mensagem.tipo === 'copiloto-ligar' ? { ativo: Boolean(mensagem.ativo) } : { sugerir: true }
    sincronizar(mensagem.reuniao)
      .catch(() => {})
      .then(() => api(`/v1/calls/${encodeURIComponent(mensagem.reuniao)}/copiloto`, { metodo: 'POST', corpo }))
      .then(() => responder({ ok: true }), (e) => responder({ erro: String(e.message || e) }))
    return true
  }
  if (mensagem.tipo === 'copiloto-estado') {
    api(`/v1/calls/${encodeURIComponent(mensagem.reuniao)}/estado`)
      .then((r) => responder({ ativo: Boolean(r.copiloto && r.copiloto.ativo) }), () => responder({}))
    return true
  }
  if (mensagem.tipo === 'copiloto-disponivel') {
    sessaoAtual().then((s) => responder({ disponivel: Boolean(s) }))
    return true
  }
  if (mensagem.tipo === 'copiloto-codigo') {
    pedirCodigo(mensagem.email).then(
      (r) => responder({ ok: true, minutos: r.minutos }),
      (e) => responder({ erro: String(e.message || e) })
    )
    return true
  }
  if (mensagem.tipo === 'copiloto-verificar') {
    verificarCodigo(mensagem.email, mensagem.codigo).then(
      (s) => responder({ ok: true, email: s.email }),
      (e) => responder({ erro: String(e.message || e) })
    )
    return true
  }
  if (mensagem.tipo === 'copiloto-sair') {
    chrome.storage.local.remove(['sessaoCopiloto']).then(() => responder({ ok: true }))
    return true
  }
  if (mensagem.tipo === 'copiloto-sessao') {
    sessaoAtual().then((s) => responder(s ? { email: s.email, exp: s.exp } : {}))
    return true
  }
  if (mensagem.tipo === 'importar-historico') {
    importarHistorico().then(() => responder({ ok: true }), () => responder({}))
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
