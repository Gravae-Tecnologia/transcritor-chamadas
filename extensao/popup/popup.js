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

// ---------- copiloto (opções, em storage.local: a chave não vai para a conta do Google) ----------

const COPILOTO_PADRAO = { copilotoAutomatico: true }
chrome.storage.local.get([...Object.keys(COPILOTO_PADRAO), 'roteiroImportado', 'roteiroGravae']).then((salvo) => {
  const config = { ...COPILOTO_PADRAO, ...salvo }
  const auto = document.getElementById('copilotoAutomatico')
  auto.checked = config.copilotoAutomatico
  auto.addEventListener('change', () => chrome.storage.local.set({ copilotoAutomatico: auto.checked }))
  const roteiro = salvo.roteiroImportado || (salvo.roteiroGravae && salvo.roteiroGravae.roteiro)
  document.getElementById('roteiro-nome').textContent = roteiro ? roteiro.nome : 'vem com o login'
})

// A conta: entrar abre a janela do Google; o popup pode fechar, o login continua no fundo.
const textoConta = document.getElementById('conta-texto')
const botaoEntrar = document.getElementById('entrar')
const botaoSair = document.getElementById('sair')
async function olharConta() {
  const s = (await chrome.runtime.sendMessage({ tipo: 'copiloto-sessao' }).catch(() => null)) || {}
  botaoEntrar.hidden = Boolean(s.email)
  botaoSair.hidden = !s.email
  textoConta.textContent = s.email ? `Conectado como ${s.email}` : 'Entre com a sua conta da Gravaê para usar o copiloto.'
}
botaoEntrar.addEventListener('click', async () => {
  botaoEntrar.disabled = true
  textoConta.textContent = 'Abrindo o Google…'
  const r = await chrome.runtime.sendMessage({ tipo: 'copiloto-entrar' }).catch((e) => ({ erro: String(e.message || e) }))
  botaoEntrar.disabled = false
  if (r && r.erro) textoConta.textContent = 'Não entrou: ' + r.erro
  olharConta()
  olharAba()
})
botaoSair.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ tipo: 'copiloto-sair' })
  olharConta()
  olharAba()
})
olharConta()

document.getElementById('roteiro-arquivo').addEventListener('change', async (e) => {
  const arquivo = e.target.files[0]
  if (!arquivo) return
  try {
    const roteiro = JSON.parse(await arquivo.text())
    if (!Array.isArray(roteiro.etapas) || !Array.isArray(roteiro.objecoes) || !Array.isArray(roteiro.alertas)) throw new Error('faltam etapas, objeções ou alertas')
    await chrome.storage.local.set({ roteiroImportado: roteiro })
    document.getElementById('roteiro-nome').textContent = roteiro.nome || arquivo.name
  } catch (erro) {
    document.getElementById('roteiro-nome').textContent = 'arquivo inválido: ' + erro.message
  }
})

function abrirAgenda(id) {
  chrome.tabs.create({ url: chrome.runtime.getURL('agenda/agenda.html') + (id ? '#reuniao=' + encodeURIComponent(id) : '') })
  window.close()
}
document.getElementById('abrir-agenda').addEventListener('click', () => abrirAgenda())

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
    no.querySelector('.titulo').addEventListener('click', () => abrirAgenda(r.id))
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
const botaoAbrirCopiloto = document.getElementById('abrir-copiloto')
const botaoDiagnostico = document.getElementById('diagnostico')
let reuniaoDaAba = null
let copilotoPronto = false // com chave e roteiro

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
  else estadoAba.textContent = `● ${resposta.falas} ${resposta.falas === 1 ? 'fala' : 'falas'}`
  avisoAba.hidden = !(resposta && resposta.avisoIdioma)
  if (resposta && resposta.avisoIdioma) avisoAba.textContent = resposta.avisoIdioma
  reuniaoDaAba = resposta && resposta.reuniao
  const { disponivel } = (await chrome.runtime.sendMessage({ tipo: 'copiloto-disponivel' }).catch(() => null)) || {}
  copilotoPronto = Boolean(disponivel)
  pareado.hidden = !reuniaoDaAba
  document.getElementById('copiloto-falta').hidden = copilotoPronto
  document.getElementById('interruptor-copiloto').hidden = !copilotoPronto
  botaoAbrirCopiloto.textContent = resposta && resposta.encerrada ? 'Ver o resumo' : 'Abrir o copiloto'
  if (copilotoPronto && reuniaoDaAba) {
    const { ['copiloto:' + reuniaoDaAba]: salvo } = await chrome.storage.local.get('copiloto:' + reuniaoDaAba)
    const { copilotoAutomatico } = await chrome.storage.local.get({ copilotoAutomatico: true })
    chaveCopiloto.checked = salvo ? Boolean(salvo.guardado.ativo) : copilotoAutomatico
    chaveCopiloto.disabled = Boolean(resposta && resposta.encerrada)
  }
  botaoAbrirCopiloto.onclick = async () => {
    await chrome.sidePanel.open({ tabId: aba.id }).catch(() => {})
    window.close()
  }
  botaoDiagnostico.onclick = async () => {
    const r = await chrome.tabs.sendMessage(aba.id, { tipo: 'diagnostico' }).catch(() => null)
    if (!r || !r.ok) return avisar(botaoDiagnostico, 'Sem chamada')
    // Vai para a área de transferência, para mandar a quem cuida da extensão.
    await navigator.clipboard.writeText(JSON.stringify(r.dados, null, 1))
    avisar(botaoDiagnostico, 'Copiado: mande ao suporte')
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

chaveCopiloto.addEventListener('change', async () => {
  chaveCopiloto.disabled = true
  await chrome.runtime.sendMessage({ tipo: 'copiloto-ligar', reuniao: reuniaoDaAba, ativo: chaveCopiloto.checked })
  chaveCopiloto.disabled = false
})

chrome.storage.onChanged.addListener((_, area) => {
  if (area !== 'local') return
  desenhar()
  olharAba()
})
desenhar()
olharAba()
