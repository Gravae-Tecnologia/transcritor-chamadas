const CONFIG_PADRAO = { automatico: true, baixarAoSair: true, esconderLegendas: false, meuNome: '' }

const lista = document.getElementById('lista')
const vazio = document.getElementById('vazio')
const modelo = document.getElementById('modelo')

// ---------- opções ----------

const botaoOpcoes = document.getElementById('abrir-opcoes')
const painelOpcoes = document.getElementById('opcoes')
botaoOpcoes.addEventListener('click', () => {
  painelOpcoes.hidden = !painelOpcoes.hidden
  botaoOpcoes.setAttribute('aria-expanded', String(!painelOpcoes.hidden))
})

chrome.storage.sync.get(CONFIG_PADRAO).then((config) => {
  for (const [chave, valor] of Object.entries(config)) {
    const campo = document.getElementById(chave)
    if (!campo) continue
    if (campo.type === 'checkbox') campo.checked = valor
    else campo.value = valor
    campo.addEventListener('change', () => {
      chrome.storage.sync.set({ [chave]: campo.type === 'checkbox' ? campo.checked : campo.value.trim() })
    })
  }
})

// ---------- o Transcritor do PC (a ponte) ----------

const selo = document.getElementById('ponte')
let ponteLigada = null

function pedirAoPc(dados) {
  return chrome.runtime.sendMessage({ tipo: 'ponte-pedir', dados }).catch(() => ({ erro: 'sem resposta' }))
}

async function olharPonte() {
  const r = await pedirAoPc({ tipo: 'ponte-ola', versao: chrome.runtime.getManifest().version })
  ponteLigada = Boolean(r && r.tipo === 'ponte-ok')
  selo.hidden = false
  selo.classList.toggle('ligada', ponteLigada)
  selo.textContent = ponteLigada ? 'PC conectado' : 'PC fechado'
  selo.title = ponteLigada
    ? `Conectado ao Transcritor do PC${r.versao ? ' ' + r.versao : ''}: as chamadas do Meet vão para ele, com o copiloto.`
    : 'O Transcritor do PC não está aberto: a extensão transcreve sozinha e baixa o .md no fim.'
  return ponteLigada
}

// ---------- lista ----------

async function baixar(reuniao, extensao) {
  const conteudo = extensao === 'txt' ? Formato.paraTexto(reuniao) : Formato.paraMarkdown(reuniao)
  // Com text/plain o Chrome troca a extensão .md por .txt.
  const tipo = extensao === 'txt' ? 'text/plain' : 'text/markdown'
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo + ';charset=utf-8' }))
  await chrome.downloads.download({ url, filename: Formato.nomeArquivo(reuniao, extensao), conflictAction: 'uniquify' })
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

function avisar(botao, texto) {
  const original = botao.textContent
  botao.textContent = texto
  setTimeout(() => (botao.textContent = original), 1500)
}

async function desenhar() {
  const tudo = await chrome.storage.local.get(null)
  const reunioes = Object.entries(tudo)
    .filter(([chave]) => chave.startsWith('reuniao:'))
    .map(([, r]) => r)
    .sort((a, b) => b.inicio.localeCompare(a.inicio))

  lista.replaceChildren()
  vazio.hidden = reunioes.length > 0

  for (const r of reunioes) {
    const no = modelo.content.firstElementChild.cloneNode(true)
    no.querySelector('.titulo').textContent = r.titulo
    no.querySelector('.titulo').title = r.titulo
    const estado = no.querySelector('.estado')
    estado.textContent = r.fim ? Formato.duracao(r) : '● ao vivo'
    estado.classList.toggle('ao-vivo', !r.fim)
    const n = r.falas.length
    no.querySelector('.meta').textContent =
      `${Formato.data(r.inicio)} ${Formato.hora(r.inicio)} · ${n} ${n === 1 ? 'fala' : 'falas'}` +
      (r.participantes && r.participantes.length ? ' · ' + r.participantes.join(', ') : '')
    const ultima = r.falas[n - 1]
    no.querySelector('.previa').textContent = ultima ? `${ultima.nome}: ${ultima.texto}` : 'Nada transcrito ainda.'

    no.querySelector('.acoes').addEventListener('click', async (evento) => {
      const botao = evento.target.closest('button')
      if (!botao) return
      const acao = botao.dataset.acao
      if (acao === 'md' || acao === 'txt') await baixar(r, acao)
      if (acao === 'copiar') {
        await navigator.clipboard.writeText(Formato.paraMarkdown(r))
        avisar(botao, 'Copiado')
      }
      if (acao === 'apagar') {
        if (botao.dataset.confirmar) await chrome.storage.local.remove('reuniao:' + r.id)
        else {
          botao.dataset.confirmar = '1'
          botao.textContent = 'Confirmar?'
        }
      }
    })
    lista.appendChild(no)
  }
}

// ---------- a aba aberta agora ----------

const secaoAba = document.getElementById('aba-atual')
const estadoAba = document.getElementById('aba-estado')
const avisoAba = document.getElementById('aba-aviso')
const botaoComecar = document.getElementById('aba-comecar')
const pareado = document.getElementById('pareado')
const chaveCopiloto = document.getElementById('copiloto')
const botaoAbrirPc = document.getElementById('abrir-pc')
const botaoDiagnostico = document.getElementById('diagnostico')
let sessaoNoPc = null
let meetAtivo = false // chamada do Meet sendo transcrita pelas legendas: o áudio da aba sobra

async function olharAba() {
  const [aba] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!aba || !/^https:\/\/meet\.google\.com\/[a-z]{3,}-[a-z]{3,}-[a-z]{3,}/.test(aba.url || '')) return
  secaoAba.hidden = false
  let resposta = null
  try {
    resposta = await chrome.tabs.sendMessage(aba.id, { tipo: 'ping' })
  } catch {}
  botaoComecar.hidden = Boolean(resposta && resposta.ok)
  if (!resposta || !resposta.ok) estadoAba.textContent = 'não está sendo transcrita'
  else if (resposta.encerrada) estadoAba.textContent = 'encerrada e salva'
  else if (!resposta.naChamada) estadoAba.textContent = 'esperando você entrar'
  else estadoAba.textContent = `● ${resposta.falas} ${resposta.falas === 1 ? 'fala' : 'falas'}${resposta.noPc ? ' · no PC' : ''}`
  avisoAba.hidden = !(resposta && resposta.avisoIdioma)
  if (resposta && resposta.avisoIdioma) avisoAba.textContent = resposta.avisoIdioma
  meetAtivo = Boolean(resposta && resposta.naChamada && !resposta.encerrada)
  sessaoNoPc = resposta && !resposta.encerrada ? resposta.noPc : null
  pareado.hidden = !sessaoNoPc
  if (sessaoNoPc) olharSessaoNoPc()
  botaoDiagnostico.onclick = async () => {
    const r = await chrome.tabs.sendMessage(aba.id, { tipo: 'diagnostico' }).catch(() => null)
    avisar(botaoDiagnostico, r && r.ok ? 'Mandado ao PC' : 'Sem chamada')
  }

  botaoComecar.onclick = async () => {
    botaoComecar.disabled = true
    const r = await chrome.runtime.sendMessage({ tipo: 'garantir', aba: aba.id })
    if (r && r.erro) {
      estadoAba.textContent = 'Não consegui entrar na aba: ' + r.erro
      botaoComecar.disabled = false
    } else setTimeout(olharAba, 1500)
  }
}

async function olharSessaoNoPc() {
  const r = await pedirAoPc({ tipo: 'ponte-sessao', sessao: sessaoNoPc })
  if (!r || !r.existe) return
  chaveCopiloto.checked = r.copiloto
  if (r.idioma_errado && avisoAba.hidden) {
    avisoAba.hidden = false
    avisoAba.textContent = 'O programa do PC acha que as legendas estão em outro idioma: no Meet, ⋮ › Configurações › Legendas.'
  }
}

chaveCopiloto.addEventListener('change', async () => {
  chaveCopiloto.disabled = true
  const r = await pedirAoPc({ tipo: 'ponte-copiloto', sessao: sessaoNoPc, ativo: chaveCopiloto.checked })
  chaveCopiloto.disabled = false
  if (r && r.existe) chaveCopiloto.checked = r.copiloto
})

botaoAbrirPc.addEventListener('click', async () => {
  const r = await pedirAoPc({ tipo: 'ponte-abrir', sessao: sessaoNoPc })
  if (r && r.erro) avisar(botaoAbrirPc, 'PC fechado')
  else window.close()
})

// ---------- áudio desta aba (pelo Transcritor do PC) ----------

const secaoAudio = document.getElementById('audio-aba')
const estadoAudio = document.getElementById('audio-estado')
const audioParado = document.getElementById('audio-parado')
const audioGravando = document.getElementById('audio-gravando')
const audioLinhas = document.getElementById('audio-linhas')
const audioUltima = document.getElementById('audio-ultima')
const botaoAudio = document.getElementById('audio-comecar')
let abaAtual = null

// A captura de áudio da aba depende de um programa local, que transcreve com
// Whisper (não vem com a extensão). Sem ele respondendo, a seção nem aparece.
async function olharAudio() {
  if (!abaAtual) {
    ;[abaAtual] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!abaAtual || !/^https?:/.test(abaAtual.url || '')) return
  }
  const chave = 'captura:' + abaAtual.id
  const { [chave]: captura, ultimaCaptura } = await chrome.storage.session.get([chave, 'ultimaCaptura'])
  if (!captura) {
    if (meetAtivo) return
    if (ponteLigada === null) await olharPonte()
    if (!ponteLigada) return
  }
  secaoAudio.hidden = false
  audioParado.hidden = Boolean(captura)
  audioGravando.hidden = !captura
  if (captura) {
    const min = Math.floor((Date.now() - captura.desde) / 60000)
    estadoAudio.textContent = `● gravando · ${min} min`
    audioLinhas.textContent = captura.linhas.join('\n') || 'Esperando alguém falar…'
  } else if (!estadoAudio.dataset.erro) {
    estadoAudio.textContent = ''
  }
  audioUltima.hidden = !ultimaCaptura || Boolean(captura)
  if (ultimaCaptura) audioUltima.textContent = `Salvo: ${ultimaCaptura.arquivo || ultimaCaptura.titulo}`
}

botaoAudio.addEventListener('click', async () => {
  botaoAudio.disabled = true
  estadoAudio.dataset.erro = ''
  estadoAudio.textContent = 'Conectando ao programa do PC…'
  const r = await chrome.runtime.sendMessage({
    tipo: 'aba-transcrever',
    aba: abaAtual.id,
    titulo: abaAtual.title || abaAtual.url,
    url: abaAtual.url,
    microfone: document.getElementById('audio-microfone').checked
  })
  botaoAudio.disabled = false
  if (r && r.erro) {
    estadoAudio.dataset.erro = '1'
    estadoAudio.textContent = r.erro
  }
  olharAudio()
})

document.getElementById('audio-parar').addEventListener('click', async () => {
  estadoAudio.textContent = 'Salvando…'
  await chrome.runtime.sendMessage({ tipo: 'aba-parar', aba: abaAtual.id })
})

chrome.storage.onChanged.addListener((_, area) => {
  if (area === 'session') olharAudio()
  if (area !== 'local') return
  desenhar()
  olharAba()
})
desenhar()
olharPonte()
  .then(olharAba)
  .then(olharAudio)
