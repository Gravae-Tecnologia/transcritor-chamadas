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
  if (area === 'local' && (mudancas.sessaoCopiloto || mudancas.roteiroImportado || mudancas.roteiroGravae)) agendar()
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

async function desenhar() {
  const mostrar = (id, sim) => ($(id).hidden = !sim)
  for (const id of ['sem-call', 'sem-copiloto', 'controle', 'desligado', 'fala', 'sugestao', 'objecao', 'esperando', 'erro', 'resumo', 'roteiro', 'conversa-caixa', 'situacao']) mostrar(id, false)
  $('alertas').innerHTML = ''

  if (!reuniaoId) {
    $('titulo').textContent = 'Gravaê'
    return mostrar('sem-call', true)
  }
  const { ['reuniao:' + reuniaoId]: reuniao, ['copiloto:' + reuniaoId]: salvo } = await chrome.storage.local.get(['reuniao:' + reuniaoId, 'copiloto:' + reuniaoId])
  const c = salvo && salvo.estado
  const encerrada = Boolean(reuniao && reuniao.fim)
  $('titulo').textContent = (reuniao && reuniao.titulo) || (salvo && salvo.titulo) || 'Google Meet'
  if (reuniao) {
    mostrar('situacao', true)
    $('situacao').className = 'chip' + (encerrada ? '' : ' vivo')
    $('situacao').textContent = encerrada ? `encerrada · ${minutos(reuniao.inicio, reuniao.fim)}` : `ao vivo · ${minutos(reuniao.inicio)}`
  }

  const { disponivel } = (await chrome.runtime.sendMessage({ tipo: 'copiloto-disponivel' }).catch(() => null)) || {}
  if (!disponivel && !(c && c.resumo)) {
    mostrar('sem-copiloto', true)
    $('sem-copiloto-texto').textContent =
      'Para usar o copiloto, entre com a sua conta da Gravaê: abra o popup da extensão (o G. na barra do Chrome), clique em ⚙ e em Entrar com Google.'
    return
  }

  const ativo = Boolean(c && c.ativo)
  if (!encerrada) {
    mostrar('controle', true)
    $('ligado').checked = ativo
  }
  if (c) $('custo').textContent = `${c.leituras} leituras · IA US$ ${Number(c.custo || 0).toFixed(3)}`
  if (!ativo && !encerrada) mostrar('desligado', true)
  if (!c) return

  // Quanto cada lado falou.
  if (c.falas.length) {
    mostrar('fala', true)
    $('fala-vendedor').style.width = c.fala.vendedor + '%'
    $('pct-vendedor').textContent = c.fala.vendedor + '%'
    $('pct-cliente').textContent = c.fala.cliente + '%'
    $('fala').classList.toggle('demais', c.fala.vendedor > 65 && c.falas.length > 6)
  }

  if (ativo && !encerrada) {
    const sug = c.sugestao
    if (sug && sug.frase) {
      mostrar('sugestao', true)
      if (sug.frase !== ultimaSugestao) {
        $('sugestao').classList.remove('nova')
        void $('sugestao').offsetWidth
        $('sugestao').classList.add('nova')
        ultimaSugestao = sug.frase
      }
      $('sug-frase').textContent = sug.frase
      const etapa = c.etapas.find((e) => e.id === sug.etapa)
      $('sug-etapa').textContent = etapa ? etapa.nome : sug.etapa && /obje/i.test(sug.etapa) ? 'Objeção' : ''
      $('sug-etapa').hidden = !$('sug-etapa').textContent
      $('sug-porque').textContent = sug.porque || ''
    } else mostrar('esperando', true)

    if (c.objecao) {
      mostrar('objecao', true)
      $('obj-nome').textContent = c.objecao.nome
      $('obj-resposta').textContent = c.objecao.resposta
      $('obj-evitar').textContent = c.objecao.evitar
    }
    $('alertas').innerHTML = c.alertas.map((a) => `<div class="alerta${/compra/i.test(a.texto) ? ' compra' : ''}">${esc(a.texto)}</div>`).join('')
  }

  if (c.erro) {
    mostrar('erro', true)
    $('erro').textContent = c.erro === 'sem chave' || c.erro === 'sem login' ? 'Sem login: entre com a conta da Gravaê no popup (⚙).' : 'Erro do copiloto: ' + c.erro
  }

  if (c.resumo) {
    mostrar('resumo', true)
    $('resumo-md').innerHTML = markdown(c.resumo)
  } else if (encerrada && ativo) {
    mostrar('esperando', true)
    $('esperando').querySelector('.rotulo').textContent = 'Escrevendo o resumo'
    $('esperando').querySelector('p').textContent = 'A call acabou. O resumo fica pronto em até 1 minuto, aqui e na agenda.'
  }

  if (ativo || c.resumo) {
    mostrar('roteiro', true)
    $('roteiro-nome').textContent = c.roteiro
    $('progresso').textContent = `${c.etapas.filter((e) => e.status === 2).length}/${c.etapas.length}`
    const agora = c.etapas.find((e) => e.status < 2)
    $('etapas').innerHTML = c.etapas
      .map(
        (e) => `<li><details class="etapa${!encerrada && agora && e.id === agora.id ? ' agora' : ''}" data-status="${e.status}" data-id="${esc(e.id)}"${abertas.has(e.id) ? ' open' : ''}>
        <summary><span class="ponto"></span><span class="nome">${esc(e.nome)}</span></summary>
        <div class="detalhe">${esc(e.objetivo)}<ul>${e.perguntas.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>${esc(e.dica)}</div>
      </details></li>`
      )
      .join('')
    for (const d of $('etapas').querySelectorAll('.etapa')) {
      d.addEventListener('toggle', () => (d.open ? abertas.add(d.dataset.id) : abertas.delete(d.dataset.id)))
    }
  }

  if (c.falas.length) {
    mostrar('conversa-caixa', true)
    $('conversa').innerHTML = c.falas
      .map((f) => `<li class="${f.papel}"><b>${esc(f.quem)}</b>${esc(f.texto)}</li>`)
      .join('')
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
