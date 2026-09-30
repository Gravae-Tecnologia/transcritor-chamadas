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
const botaoComecar = document.getElementById('aba-comecar')

async function olharAba() {
  const [aba] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!aba || !/^https:\/\/meet\.google\.com\/[a-z]{3,}-[a-z]{3,}-[a-z]{3,}/.test(aba.url || '')) return
  secaoAba.hidden = false
  let resposta = null
  try {
    resposta = await chrome.tabs.sendMessage(aba.id, { tipo: 'ping' })
  } catch {}
  botaoComecar.hidden = Boolean(resposta && resposta.ok)
  if (!resposta || !resposta.ok) estadoAba.textContent = 'Esta chamada não está sendo transcrita.'
  else if (resposta.encerrada) estadoAba.textContent = 'Chamada encerrada e salva.'
  else if (!resposta.naChamada) estadoAba.textContent = 'Esperando você entrar na chamada.'
  else estadoAba.textContent = `● Transcrevendo esta chamada · ${resposta.falas} ${resposta.falas === 1 ? 'fala' : 'falas'}`

  botaoComecar.onclick = async () => {
    botaoComecar.disabled = true
    const r = await chrome.runtime.sendMessage({ tipo: 'garantir', aba: aba.id })
    if (r && r.erro) {
      estadoAba.textContent = 'Não consegui entrar na aba: ' + r.erro
      botaoComecar.disabled = false
    } else setTimeout(olharAba, 1500)
  }
}

// ---------- áudio desta aba (pelo Transcritor do PC) ----------

const secaoAudio = document.getElementById('audio-aba')
const estadoAudio = document.getElementById('audio-estado')
const audioParado = document.getElementById('audio-parado')
const audioGravando = document.getElementById('audio-gravando')
const audioLinhas = document.getElementById('audio-linhas')
const audioUltima = document.getElementById('audio-ultima')
const botaoAudio = document.getElementById('audio-comecar')
let abaAtual = null
let programaAberto = null

// A captura de áudio da aba depende de um programa local, que transcreve com
// Whisper (não vem com a extensão). Sem ele respondendo, a seção nem aparece.
function programaDoPcAberto() {
  return new Promise((resolve) => {
    let ws
    const fim = (sim) => {
      try { ws && ws.close() } catch {}
      resolve(sim)
    }
    try {
      ws = new WebSocket('ws://127.0.0.1:8766')
    } catch {
      return resolve(false)
    }
    ws.onopen = () => fim(true)
    ws.onerror = () => fim(false)
    setTimeout(() => fim(false), 800)
  })
}

async function olharAudio() {
  if (!abaAtual) {
    ;[abaAtual] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!abaAtual || !/^https?:/.test(abaAtual.url || '')) return
  }
  const chave = 'captura:' + abaAtual.id
  const { [chave]: captura, ultimaCaptura } = await chrome.storage.session.get([chave, 'ultimaCaptura'])
  if (!captura) {
    if (programaAberto === null) programaAberto = await programaDoPcAberto()
    if (!programaAberto) return
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
olharAba()
olharAudio()
