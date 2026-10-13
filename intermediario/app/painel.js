// O painel do copiloto, servido pelo servidor da Gravaê e aberto dentro da
// extensão (no painel lateral do Chrome, ao lado do Meet). A extensão manda o
// login e qual call está nesta aba (ponte.js); daqui, a página pergunta ao
// servidor o estado do copiloto a cada 1,5 s ("igual" quando nada mudou).
// Mudar esta página vale na hora para todo mundo, sem atualizar a extensão.
const { esc, markdown } = Markdown
const $ = (id) => document.getElementById(id)

let reuniaoId = null
let ultimaSugestao = null
const abertas = new Set() // etapas abertas pelo usuário
let versao = null
let dados = { call: null, cop: null }
let aguardando = false // a call ainda não chegou ao servidor (primeiros segundos)
let erroRede = null
let grudado = true // a transcrição acompanha a fala mais nova (o vendedor não rolou para cima)

function minutos(desde, ate) {
  const min = Math.max(0, Math.round((new Date(ate || Date.now()) - new Date(desde)) / 60000))
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`
}

// Segundos desde o início da call, como no player: 4:07, 1:02:15.
function relogio(t) {
  const s = Math.max(0, Math.round(t || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

$('agenda-1').addEventListener('click', () => Ponte.avisar({ tipo: 'abrir-agenda' }))
$('agenda-2').addEventListener('click', () => Ponte.avisar({ tipo: 'abrir-agenda', reuniao: reuniaoId }))

// ---------- os dados ----------

Ponte.aoContexto((c) => {
  if ((c.reuniao || null) !== reuniaoId) {
    reuniaoId = c.reuniao || null
    versao = null
    dados = { call: null, cop: null }
    ultimaSugestao = null
    grudado = true
  }
  atualizar()
})

let buscando = false
async function atualizar() {
  if (buscando) return
  buscando = true
  try {
    const id = reuniaoId
    if (id) {
      try {
        const r = await Ponte.api(`/v1/calls/${encodeURIComponent(id)}/estado` + (versao ? '?v=' + encodeURIComponent(versao) : ''))
        if (id !== reuniaoId) return
        if (!r.igual) {
          versao = r.versao
          dados = { call: r.call, cop: r.copiloto }
        }
        aguardando = false
        erroRede = null
      } catch (e) {
        if (e.status === 404) aguardando = true
        else if (e.message !== 'sem login') erroRede = 'Sem conexão com o servidor da Gravaê. Tentando de novo…'
      }
    }
    desenhar()
  } finally {
    buscando = false
  }
}
setInterval(() => !document.hidden && atualizar(), 1500)
// O relógio do "ao vivo · N min".
setInterval(() => desenhar(), 30000)

// ---------- desenho (sem espera no meio: o navegador só pinta o resultado final) ----------

const SECOES = ['sem-call', 'sem-copiloto', 'controle', 'fala', 'sugestao', 'objecao', 'esperando', 'erro', 'resumo', 'roteiro', 'transcricao', 'sem-falas', 'situacao']
const htmlAtual = {}

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

function desenhar() {
  const ver = new Set()
  if (reuniaoId && aguardando && !dados.call) {
    texto('titulo', 'Google Meet')
    ver.add('esperando')
    texto('esperando-rotulo', 'Conectando')
    texto('esperando-texto', 'a call aparece aqui em alguns segundos.')
    html('alertas', '')
  } else {
    const salvo = dados.cop ? { estado: dados.cop, titulo: dados.call && dados.call.titulo } : null
    aplicar(ver, dados.call, salvo, true)
  }
  if (erroRede) {
    ver.add('erro')
    texto('erro', erroRede)
  }
  for (const secao of SECOES) {
    const esconder = !ver.has(secao)
    if ($(secao).hidden !== esconder) $(secao).hidden = esconder
  }
  // Depois de mostrar: só agora a lista tem altura para rolar até o fim.
  const lista = $('conversa')
  if (grudado && lista.scrollHeight - lista.scrollTop - lista.clientHeight > 1) lista.scrollTop = lista.scrollHeight
}

function aplicar(ver, reuniao, salvo, disponivel) {
  if (!reuniaoId) {
    texto('titulo', 'Copiloto')
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
  // A faixa do copiloto: o interruptor (só com a call no ar) e quanto cada lado falou.
  if (!encerrada || (c && c.falas.length)) ver.add('controle')
  const interruptor = $('ligado').closest('label')
  if (interruptor.hidden !== encerrada) interruptor.hidden = encerrada
  if ($('ligado').checked !== ativo) $('ligado').checked = ativo
  texto('custo', encerrada ? '' : ativo ? `US$ ${Number((c && c.custo) || 0).toFixed(3).replace('.', ',')}` : 'desligado')
  if (!c) return html('alertas', '')

  if (c.falas.length) {
    ver.add('fala')
    $('fala-vendedor').style.width = c.fala.vendedor + '%'
    texto('pct-vendedor', c.fala.vendedor + '%')
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
      texto('esperando-texto', 'a primeira sugestão aparece em instantes.')
    }

    if (c.objecao) {
      ver.add('objecao')
      // Objeção nova chega fechada.
      if ($('obj-nome').textContent !== c.objecao.nome) abrirObjecao(false)
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
    texto('esperando-texto', 'fica pronto em até 1 minuto.')
  }

  if (ativo || c.resumo) {
    ver.add('roteiro')
    const agora = c.etapas.find((e) => e.status < 2)
    const feitas = `${c.etapas.filter((e) => e.status === 2).length}/${c.etapas.length}`
    texto('progresso', !encerrada && agora ? `${feitas} · agora: ${agora.nome}` : feitas)
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

  // A transcrição, ao vivo (as últimas 40 falas; a call inteira fica na agenda).
  ver.add('transcricao')
  if (!c.falas.length) ver.add('sem-falas')
  const antes = c.falas.length >= 40 ? '<li class="antes">As falas anteriores estão na agenda.</li>' : ''
  const falas = c.falas
    .map((f) => `<li class="${f.papel}"><div class="quem"><b>${esc(f.quem)}</b><time>${relogio(f.t)}</time></div><p>${esc(f.texto)}</p></li>`)
    .join('')
  if (html('conversa', antes + falas) && !grudado && !encerrada) $('ao-vivo').hidden = false
}

function abrirObjecao(aberta) {
  $('objecao').classList.toggle('aberta', aberta)
  texto('obj-mais', aberta ? 'recolher ▴' : 'ver tudo ▾')
}
$('objecao').addEventListener('click', () => abrirObjecao(!$('objecao').classList.contains('aberta')))

// Rolou para cima: a lista para de acompanhar até o vendedor voltar ao fim.
$('conversa').addEventListener('scroll', () => {
  const lista = $('conversa')
  grudado = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 40
  if (grudado) $('ao-vivo').hidden = true
})
$('ao-vivo').addEventListener('click', () => {
  grudado = true
  $('ao-vivo').hidden = true
  $('conversa').scrollTop = $('conversa').scrollHeight
})

// ---------- ações (vão direto ao servidor) ----------

async function comando(corpo) {
  if (!reuniaoId) return
  try {
    await Ponte.api(`/v1/calls/${encodeURIComponent(reuniaoId)}/copiloto`, { metodo: 'POST', corpo })
  } catch (e) {
    erroRede = 'Não deu: ' + e.message
  }
  versao = null
  atualizar()
}
$('ligado').addEventListener('change', (e) => comando({ ativo: e.target.checked }))
$('outra').addEventListener('click', async () => {
  $('outra').disabled = true
  await comando({ sugerir: true })
  setTimeout(() => ($('outra').disabled = false), 3000)
})
desenhar()
