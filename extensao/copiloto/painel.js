// Painel lateral do copiloto: desenha o estado que o service worker guarda em
// storage.local "copiloto:<reunião>" para a chamada do Meet desta aba.
const { esc, markdown } = Markdown
const $ = (id) => document.getElementById(id)

let reuniaoId = null
let abaId = null
let ultimaSugestao = null
const abertas = new Set() // etapas abertas pelo usuário

function abrirAgenda(id) {
  const url = chrome.runtime.getURL('agenda/agenda.html') + (id ? '#reuniao=' + encodeURIComponent(id) : '')
  chrome.tabs.create({ url })
}
$('agenda-1').addEventListener('click', () => abrirAgenda())
$('agenda-2').addEventListener('click', () => abrirAgenda(reuniaoId))

function minutos(desde, ate) {
  const min = Math.max(0, Math.round((new Date(ate || Date.now()) - new Date(desde)) / 60000))
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`
}

// ---------- qual chamada ----------

async function acharReuniao() {
  const [aba] = await chrome.tabs.query({ active: true, currentWindow: true })
  abaId = aba ? aba.id : null
  const chave = 'copiloto-aba:' + abaId
  const salvo = abaId != null ? (await chrome.storage.session.get(chave))[chave] : null
  reuniaoId = salvo || null
  desenhar()
}

chrome.tabs.onActivated.addListener(acharReuniao)
chrome.tabs.onUpdated.addListener((id, mudou) => id === abaId && mudou.status === 'complete' && acharReuniao())
chrome.storage.onChanged.addListener((mudancas, area) => {
  if (area === 'session' && Object.keys(mudancas).some((k) => k.startsWith('copiloto-aba:'))) return acharReuniao()
  if (area === 'local' && reuniaoId && (mudancas['copiloto:' + reuniaoId] || mudancas['reuniao:' + reuniaoId])) agendar()
  if (area === 'local' && (mudancas.sessaoCopiloto || mudancas.roteiroImportado || mudancas.roteiroGravae)) {
    disponivelGuardado = null
    agendar()
  }
})

let pendente = false
function agendar() {
  if (pendente) return
  pendente = true
  requestAnimationFrame(() => {
    pendente = false
    desenhar()
  })
}

// ---------- desenho ----------

// Até 10/10 o painel escondia tudo, esperava o storage e uma pergunta ao service
// worker e só então mostrava de novo: como o Meet salva a transcrição a cada 2 s,
// a tela piscava. Agora lê tudo primeiro e troca a tela de uma vez, sem nenhuma
// espera no meio, e só reescreve o que mudou.
const SECOES = ['sem-call', 'sem-copiloto', 'controle', 'desligado', 'fala', 'sugestao', 'objecao', 'esperando', 'erro', 'resumo', 'roteiro', 'conversa-caixa', 'situacao']
const htmlAtual = {}
let disponivelGuardado = null // "tem login e roteiro": só muda com o login ou o roteiro

function html(id, conteudo) {
  if (htmlAtual[id] === conteudo) return false
  htmlAtual[id] = conteudo
  $(id).innerHTML = conteudo
  return true
}

function texto(id, conteudo) {
  const el = $(id)
  if (el.textContent !== conteudo) el.textContent = conteudo
}

async function copilotoDisponivel() {
  if (disponivelGuardado === null) {
    const r = await chrome.runtime.sendMessage({ tipo: 'copiloto-disponivel' }).catch(() => null)
    disponivelGuardado = Boolean(r && r.disponivel)
  }
  return disponivelGuardado
}

// Um desenho por vez; o que chegar no meio vira mais uma volta no fim.
let desenhando = false
let deNovo = false
async function desenhar() {
  if (desenhando) {
    deNovo = true
    return
  }
  desenhando = true
  try {
    do {
      deNovo = false
      await desenharUmaVez()
    } while (deNovo)
  } finally {
    desenhando = false
  }
}

async function desenharUmaVez() {
  // 1) Lê tudo antes de encostar na tela.
  const id = reuniaoId
  let reuniao = null
  let salvo = null
  if (id) {
    const lido = await chrome.storage.local.get(['reuniao:' + id, 'copiloto:' + id])
    reuniao = lido['reuniao:' + id] || null
    salvo = lido['copiloto:' + id] || null
  }
  const disponivel = id ? await copilotoDisponivel() : false
  if (id !== reuniaoId) return void (deNovo = true) // trocou de aba enquanto lia

  // 2) Daqui para baixo não há espera: o navegador só pinta o resultado final.
  const ver = new Set()
  aplicar(ver, reuniao, salvo, disponivel)
  for (const secao of SECOES) {
    const esconder = !ver.has(secao)
    if ($(secao).hidden !== esconder) $(secao).hidden = esconder
  }
}

function aplicar(ver, reuniao, salvo, disponivel) {
  if (!reuniaoId) {
    texto('titulo', 'Gravaê')
    html('alertas', '')
    return ver.add('sem-call')
  }
  const c = salvo && salvo.estado
  const encerrada = Boolean(reuniao && reuniao.fim)
  texto('titulo', (reuniao && reuniao.titulo) || (salvo && salvo.titulo) || 'Google Meet')
  if (reuniao) {
    ver.add('situacao')
    const classe = 'chip' + (encerrada ? '' : ' vivo')
    if ($('situacao').className !== classe) $('situacao').className = classe
    texto('situacao', encerrada ? `encerrada · ${minutos(reuniao.inicio, reuniao.fim)}` : `ao vivo · ${minutos(reuniao.inicio)}`)
  }

  if (!disponivel && !(c && c.resumo)) {
    ver.add('sem-copiloto')
    texto('sem-copiloto-texto', 'Para usar o copiloto, entre com o seu e-mail da Gravaê: abra o popup da extensão (o G. na barra do Chrome), clique em ⚙ e peça o código.')
    html('alertas', '')
    return
  }

  const ativo = Boolean(c && c.ativo)
  if (!encerrada) {
    ver.add('controle')
    if ($('ligado').checked !== ativo) $('ligado').checked = ativo
  }
  if (c) texto('custo', `${c.leituras} leituras · IA US$ ${Number(c.custo || 0).toFixed(3)}`)
  if (!ativo && !encerrada) ver.add('desligado')
  if (!c) return html('alertas', '')

  // Quanto cada lado falou.
  if (c.falas.length) {
    ver.add('fala')
    $('fala-vendedor').style.width = c.fala.vendedor + '%'
    texto('pct-vendedor', c.fala.vendedor + '%')
    texto('pct-cliente', c.fala.cliente + '%')
    $('fala').classList.toggle('demais', c.fala.vendedor > 65 && c.falas.length > 6)
  }

  let alertas = ''
  if (ativo && !encerrada) {
    const sug = c.sugestao
    if (sug && sug.frase) {
      ver.add('sugestao')
      if (sug.frase !== ultimaSugestao) {
        $('sugestao').classList.remove('nova')
        void $('sugestao').offsetWidth
        $('sugestao').classList.add('nova')
        ultimaSugestao = sug.frase
      }
      texto('sug-frase', sug.frase)
      const etapa = c.etapas.find((e) => e.id === sug.etapa)
      texto('sug-etapa', etapa ? etapa.nome : sug.etapa && /obje/i.test(sug.etapa) ? 'Objeção' : '')
      $('sug-etapa').hidden = !$('sug-etapa').textContent
      texto('sug-porque', sug.porque || '')
    } else {
      ver.add('esperando')
      texto('esperando-rotulo', 'Ouvindo')
      texto('esperando-texto', 'Assim que a conversa andar, a primeira sugestão aparece aqui.')
    }

    if (c.objecao) {
      ver.add('objecao')
      texto('obj-nome', c.objecao.nome)
      texto('obj-resposta', c.objecao.resposta)
      texto('obj-evitar', c.objecao.evitar)
    }
    alertas = c.alertas.map((a) => `<div class="alerta${/compra/i.test(a.texto) ? ' compra' : ''}">${esc(a.texto)}</div>`).join('')
  }
  html('alertas', alertas)

  if (c.erro) {
    ver.add('erro')
    texto('erro', c.erro === 'sem chave' || c.erro === 'sem login' ? 'Sem login: entre com o seu e-mail da Gravaê no popup (⚙).' : 'Erro do copiloto: ' + c.erro)
  }

  if (c.resumo) {
    ver.add('resumo')
    html('resumo-md', markdown(c.resumo))
  } else if (encerrada && ativo) {
    ver.add('esperando')
    texto('esperando-rotulo', 'Escrevendo o resumo')
    texto('esperando-texto', 'A call acabou. O resumo fica pronto em até 1 minuto, aqui e na agenda.')
  }

  if (ativo || c.resumo) {
    ver.add('roteiro')
    texto('roteiro-nome', c.roteiro)
    texto('progresso', `${c.etapas.filter((e) => e.status === 2).length}/${c.etapas.length}`)
    const agora = c.etapas.find((e) => e.status < 2)
    const etapas = c.etapas
      .map(
        (e) => `<li><details class="etapa${!encerrada && agora && e.id === agora.id ? ' agora' : ''}" data-status="${e.status}" data-id="${esc(e.id)}"${abertas.has(e.id) ? ' open' : ''}>
        <summary><span class="ponto"></span><span class="nome">${esc(e.nome)}</span></summary>
        <div class="detalhe">${esc(e.objetivo)}<ul>${e.perguntas.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>${esc(e.dica)}</div>
      </details></li>`
      )
      .join('')
    if (html('etapas', etapas)) {
      for (const d of $('etapas').querySelectorAll('.etapa')) {
        d.addEventListener('toggle', () => (d.open ? abertas.add(d.dataset.id) : abertas.delete(d.dataset.id)))
      }
    }
  }

  if (c.falas.length) {
    ver.add('conversa-caixa')
    const lista = $('conversa')
    const noFim = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 30
    if (html('conversa', c.falas.map((f) => `<li class="${f.papel}"><b>${esc(f.quem)}</b>${esc(f.texto)}</li>`).join('')) && noFim) {
      lista.scrollTop = lista.scrollHeight
    }
  }
}

// ---------- ações ----------

async function ligar(ativo) {
  if (!reuniaoId) return
  await chrome.runtime.sendMessage({ tipo: 'copiloto-ligar', reuniao: reuniaoId, ativo })
}
$('ligado').addEventListener('change', (e) => ligar(e.target.checked))
$('ligar').addEventListener('click', () => ligar(true))
$('outra').addEventListener('click', async () => {
  $('outra').disabled = true
  await chrome.runtime.sendMessage({ tipo: 'copiloto-sugerir', reuniao: reuniaoId })
  setTimeout(() => ($('outra').disabled = false), 3000)
})

// O relógio do "ao vivo · N min".
setInterval(() => reuniaoId && agendar(), 30000)
acharReuniao()
