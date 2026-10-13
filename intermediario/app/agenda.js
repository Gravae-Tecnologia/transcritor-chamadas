// A agenda de calls, servida pelo servidor da Gravaê e aberta dentro da extensão
// (agenda/agenda.html). As calls vêm do servidor, só as de quem está logado: a
// lista traz os dados de cada uma, e a transcrição completa vem quando a call é
// aberta. Mudar esta página vale na hora para todo mundo, sem atualizar a extensão.
const { esc, markdown } = Markdown
const $ = (id) => document.getElementById(id)

const HORA = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hora')) || 52
const CORES = ['#60a5fa', '#4ade80', '#f5b833', '#c084fc', '#22d3ee', '#f472b6', '#a3e635', '#fb923c']
const COR_VOCE = '#ff7a6b'
const DIAS_CURTOS = ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.']

let reunioes = []
let base = inicioDoDia(new Date()) // o dia em que a visão está
let mesMini = new Date(base.getFullYear(), base.getMonth(), 1)
let visao = lerPreferencia('visao') || (innerWidth < 640 ? 'dia' : 'semana')
let selecionada = null
let aba = null
let busca = ''
let disponivel = false
let rolouParaHora = false

// ---------- utilidades ----------

function lerPreferencia(chave) {
  try {
    return localStorage.getItem('agenda:' + chave)
  } catch {
    return null
  }
}
function gravarPreferencia(chave, valor) {
  try {
    localStorage.setItem('agenda:' + chave, valor)
  } catch {}
}

function inicioDoDia(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}
function somarDias(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}
function mesmoDia(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function inicioDaSemana(d) {
  return somarDias(inicioDoDia(d), -d.getDay()) // domingo, como o Google Agenda em português
}
function hm(d) {
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}
function duracaoTexto(min) {
  min = Math.max(1, Math.round(min))
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ' ' + String(min % 60).padStart(2, '0') + ' min' : ''}`
}
function normal(texto) {
  return String(texto || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}
function realcar(texto, termo) {
  const seguro = esc(texto)
  if (!termo) return seguro
  const alvo = esc(termo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return seguro.replace(new RegExp(alvo, 'gi'), (m) => `<mark>${m}</mark>`)
}

// ---------- dados ----------

const detalhes = {} // id -> {falas, copiloto} da call aberta

async function carregar() {
  let lista
  try {
    lista = (await Ponte.api('/v1/calls')).calls
  } catch (e) {
    if (e.message !== 'sem login') $('vazio').textContent = 'Sem conexão com o servidor da Gravaê. Tentando de novo…'
    return
  }
  const agora = Date.now()
  reunioes = lista
    .filter((r) => r.inicio)
    .map((r) => {
      const atualizado = new Date(r.atualizado || r.inicio)
      const vivo = !r.fim && agora - atualizado < 5 * 60000
      const inicio = new Date(r.inicio)
      let fim = r.fim ? new Date(r.fim) : vivo ? new Date(agora) : atualizado
      if (fim < inicio) fim = inicio
      const d = detalhes[r.id] || {}
      return { ...r, falas: d.falas || [], copiloto: d.copiloto || null, _inicio: inicio, _fim: fim, vivo }
    })
    .sort((a, b) => a._inicio - b._inicio)
  desenhar()
}

// A transcrição e o copiloto de uma call (só quando ela é aberta).
async function carregarDetalhe(id) {
  try {
    const call = await Ponte.api('/v1/calls/' + encodeURIComponent(id))
    detalhes[id] = { falas: call.falas || [], copiloto: call.copiloto || null }
    const r = reunioes.find((x) => x.id === id)
    if (r) Object.assign(r, detalhes[id], { tem_resumo: call.tem_resumo, fim: call.fim, titulo: call.titulo })
    if (selecionada === id) desenharDetalhe()
  } catch (e) {
    if (e.status === 404) fechar()
  }
}

// ---------- a visão (semana ou dia) ----------

function diasDaVisao() {
  if (visao === 'dia') return [base]
  const ini = inicioDaSemana(base)
  return Array.from({ length: 7 }, (_, i) => somarDias(ini, i))
}

function periodoTexto(dias) {
  const fmt = (d, o) => d.toLocaleDateString('pt-BR', o)
  if (dias.length === 1) return fmt(dias[0], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const a = dias[0]
  const b = dias[dias.length - 1]
  if (a.getMonth() === b.getMonth()) return `${a.getDate()} – ${b.getDate()} de ${fmt(b, { month: 'long' })} de ${b.getFullYear()}`
  return `${fmt(a, { day: 'numeric', month: 'short' })} – ${fmt(b, { day: 'numeric', month: 'short' })} de ${b.getFullYear()}`
}

function eventosDoDia(dia) {
  const ini = dia.getTime()
  const fim = somarDias(dia, 1).getTime()
  return reunioes.filter((r) => r._inicio.getTime() < fim && Math.max(r._fim.getTime(), r._inicio.getTime() + 60000) > ini)
}

// Eventos que se cruzam dividem a largura, como no Google Agenda.
function emPistas(eventos, dia) {
  const ini = dia.getTime()
  const caixas = eventos
    .map((r) => {
      const a = Math.max(0, (r._inicio.getTime() - ini) / 60000)
      const b = Math.min(1440, Math.max(a + 20, (r._fim.getTime() - ini) / 60000))
      return { r, a, b }
    })
    .sort((x, y) => x.a - y.a || y.b - x.b)
  let grupo = []
  let fimGrupo = -1
  const fechar = () => {
    const pistas = []
    for (const c of grupo) {
      let p = pistas.findIndex((fim) => fim <= c.a)
      if (p < 0) p = pistas.push(0) - 1
      pistas[p] = c.b
      c.pista = p
    }
    for (const c of grupo) c.total = pistas.length
    grupo = []
  }
  for (const c of caixas) {
    if (c.a >= fimGrupo && grupo.length) fechar()
    grupo.push(c)
    fimGrupo = Math.max(fimGrupo, c.b)
  }
  fechar()
  return caixas
}

function desenhar() {
  const dias = diasDaVisao()
  const hoje = inicioDoDia(new Date())
  $('periodo').textContent = periodoTexto(dias)
  for (const b of document.querySelectorAll('[data-visao]')) b.classList.toggle('ativo', b.dataset.visao === visao)

  const colunas = `56px repeat(${dias.length}, minmax(0, 1fr))`
  $('cabecalho').style.gridTemplateColumns = colunas
  $('grade').style.gridTemplateColumns = colunas

  $('cabecalho').innerHTML =
    '<div></div>' +
    dias
      .map((d) => `<div class="dia${mesmoDia(d, hoje) ? ' hoje' : ''}" data-dia="${d.getTime()}"><span>${DIAS_CURTOS[d.getDay()]}</span><b>${d.getDate()}</b></div>`)
      .join('')

  let html = '<div class="horas">' + Array.from({ length: 24 }, (_, h) => `<div>${h ? `<span>${String(h).padStart(2, '0')}:00</span>` : ''}</div>`).join('') + '</div>'
  let total = 0
  let minutosEmCall = 0
  let comResumo = 0
  for (const dia of dias) {
    const eventos = emPistas(eventosDoDia(dia), dia)
    html += `<div class="coluna${mesmoDia(dia, hoje) ? ' hoje' : ''}" style="height:${24 * HORA}px">`
    for (const { r, a, b, pista, total: pistas } of eventos) {
      const altura = ((b - a) / 60) * HORA - 2
      const curto = altura < 38
      const largura = 100 / pistas
      const icones = (r.tem_resumo ? '✦' : '') + (r.vivo ? ' ●' : '')
      html += `<button class="evento${curto ? ' curto' : ''}${r.vivo ? ' vivo' : ''}${r.id === selecionada ? ' selecionado' : ''}" data-id="${esc(r.id)}"
        style="top:${(a / 60) * HORA}px;height:${altura}px;left:calc(${pista * largura}% + 3px);right:auto;width:calc(${largura}% - 7px)"
        title="${esc(r.titulo)} · ${hm(r._inicio)} – ${r.vivo ? 'agora' : hm(r._fim)}">
        <strong>${esc(r.titulo)}</strong><span class="h">${hm(r._inicio)} – ${r.vivo ? 'agora' : hm(r._fim)}</span>
        ${icones ? `<span class="icones">${icones}</span>` : ''}</button>`
      if (r._inicio >= dia && r._inicio < somarDias(dia, 1)) {
        total++
        minutosEmCall += (r._fim - r._inicio) / 60000
        if (r.tem_resumo) comResumo++
      }
    }
    if (mesmoDia(dia, hoje)) {
      const agora = new Date()
      html += `<div class="agora" style="top:${((agora.getHours() * 60 + agora.getMinutes()) / 60) * HORA}px"></div>`
    }
    html += '</div>'
  }
  $('grade').innerHTML = html
  $('vazio').hidden = total > 0
  $('numeros').innerHTML = total
    ? `<div><b>${total}</b> ${total === 1 ? 'call' : 'calls'} ${visao === 'dia' ? 'neste dia' : 'nesta semana'}</div>
       <div><b>${duracaoTexto(minutosEmCall)}</b> em call</div>
       <div><b>${comResumo}</b> com resumo do copiloto</div>`
    : ''

  if (!rolouParaHora) {
    rolouParaHora = true
    const primeiras = dias.flatMap((d) => eventosDoDia(d)).map((r) => r._inicio.getHours())
    const alvo = dias.some((d) => mesmoDia(d, hoje)) ? Math.min(new Date().getHours() - 2, ...primeiras) : primeiras.length ? Math.min(...primeiras) : 8
    $('rolagem').scrollTop = Math.max(0, Math.min(alvo, 20) - 0.5) * HORA
  }
  desenharMini(dias)
  if (selecionada) desenharDetalhe()
}

function desenharMini(dias) {
  const hoje = inicioDoDia(new Date())
  const mes = mesMini.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
  $('mini-mes').textContent = mes.charAt(0).toUpperCase() + mes.slice(1)
  const ini = inicioDaSemana(mesMini)
  const comCall = new Set(reunioes.map((r) => inicioDoDia(r._inicio).getTime()))
  const naVisao = new Set(dias.map((d) => d.getTime()))
  let html = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((d) => `<span class="dsem">${d}</span>`).join('')
  for (let i = 0; i < 42; i++) {
    const d = somarDias(ini, i)
    const classes = [
      d.getMonth() !== mesMini.getMonth() && 'fora',
      mesmoDia(d, hoje) && 'hoje',
      naVisao.has(d.getTime()) && 'na-semana',
      comCall.has(d.getTime()) && 'tem'
    ].filter(Boolean)
    html += `<button type="button" class="${classes.join(' ')}" data-dia="${d.getTime()}">${d.getDate()}</button>`
  }
  $('mini-grade').innerHTML = html
}

// ---------- navegação ----------

function irPara(dia) {
  base = inicioDoDia(dia)
  mesMini = new Date(base.getFullYear(), base.getMonth(), 1)
  rolouParaHora = false
  desenhar()
}
$('hoje').addEventListener('click', () => irPara(new Date()))
$('anterior').addEventListener('click', () => irPara(somarDias(base, visao === 'dia' ? -1 : -7)))
$('proximo').addEventListener('click', () => irPara(somarDias(base, visao === 'dia' ? 1 : 7)))
$('mini-ant').addEventListener('click', () => {
  mesMini = new Date(mesMini.getFullYear(), mesMini.getMonth() - 1, 1)
  desenharMini(diasDaVisao())
})
$('mini-prox').addEventListener('click', () => {
  mesMini = new Date(mesMini.getFullYear(), mesMini.getMonth() + 1, 1)
  desenharMini(diasDaVisao())
})
$('mini-grade').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dia]')
  if (b) irPara(new Date(Number(b.dataset.dia)))
})
$('cabecalho').addEventListener('click', (e) => {
  const d = e.target.closest('[data-dia]')
  if (!d) return
  visao = 'dia'
  gravarPreferencia('visao', visao)
  irPara(new Date(Number(d.dataset.dia)))
})
for (const b of document.querySelectorAll('[data-visao]')) {
  b.addEventListener('click', () => {
    visao = b.dataset.visao
    gravarPreferencia('visao', visao)
    rolouParaHora = false
    desenhar()
  })
}
$('grade').addEventListener('click', (e) => {
  const ev = e.target.closest('.evento')
  if (ev) abrir(ev.dataset.id)
})
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input')) return
  if (e.key === 'Escape') fechar()
  if (e.key === 'ArrowLeft') $('anterior').click()
  if (e.key === 'ArrowRight') $('proximo').click()
  if (e.key === 't') $('hoje').click()
})

// ---------- busca em todas as calls ----------

let buscaPendente = null
$('busca').addEventListener('input', () => {
  busca = $('busca').value.trim()
  document.body.classList.toggle('buscando', Boolean(busca))
  clearTimeout(buscaPendente)
  buscaPendente = setTimeout(desenharResultados, 300)
})

async function desenharResultados() {
  const caixa = $('resultados')
  caixa.hidden = !busca
  if (!busca) return
  const termo = busca
  let achadas = []
  try {
    achadas = (await Ponte.api('/v1/calls/busca?q=' + encodeURIComponent(termo))).resultados
  } catch {}
  if (termo !== busca) return
  const t = normal(termo)
  caixa.innerHTML =
    `<div class="rotulo">${achadas.length ? achadas.length + (achadas.length === 30 ? '+' : '') + (achadas.length === 1 ? ' call' : ' calls') : 'Nada encontrado'}</div>` +
    achadas
      .map((r) => {
        let trecho = ''
        if (r.texto) {
          const i = Math.max(0, normal(r.texto).indexOf(t))
          const ini = Math.max(0, i - 50)
          trecho = (ini ? '…' : '') + r.texto.slice(ini, i + t.length + 90)
        }
        const inicio = new Date(r.inicio)
        return `<button type="button" class="resultado cartao" data-id="${esc(r.id)}">
          <strong>${realcar(r.titulo || 'Google Meet', termo)}</strong>
          <span>${inicio.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' })} · ${hm(inicio)}</span>
          ${trecho ? `<p>${r.nome ? esc(r.nome) + ': ' : ''}${realcar(trecho, termo)}</p>` : ''}</button>`
      })
      .join('')
}
$('resultados').addEventListener('click', (e) => {
  const b = e.target.closest('.resultado')
  if (!b) return
  const r = reunioes.find((x) => x.id === b.dataset.id)
  if (!r) return
  irPara(r._inicio)
  abrir(r.id, 'transcricao', busca)
})

// ---------- o detalhe da call ----------

function coresDasPessoas(r) {
  const cores = new Map()
  let i = 0
  for (const f of r.falas) {
    if (cores.has(f.nome)) continue
    cores.set(f.nome, f.eu ? COR_VOCE : CORES[i++ % CORES.length])
  }
  return cores
}

function turnos(falas) {
  const lista = []
  for (const f of falas) {
    const ultimo = lista[lista.length - 1]
    if (ultimo && ultimo.nome === f.nome) ultimo.texto += ' ' + f.texto
    else lista.push({ nome: f.nome, eu: f.eu, hora: f.hora, texto: f.texto })
  }
  return lista
}

function abrir(id, abaPedida, termo) {
  selecionada = id
  carregarDetalhe(id)
  aba = abaPedida || null
  if (termo != null) $('d-busca').value = termo
  else $('d-busca').value = ''
  history.replaceState(null, '', '#reuniao=' + encodeURIComponent(id))
  $('detalhe').hidden = false
  document.body.classList.add('com-detalhe')
  $('detalhe').querySelector('.detalhe-rolagem').scrollTop = 0
  desenhar()
}

function fechar() {
  selecionada = null
  $('detalhe').hidden = true
  document.body.classList.remove('com-detalhe')
  history.replaceState(null, '', location.pathname)
  desenhar()
}
$('fechar').addEventListener('click', fechar)

function desenharDetalhe() {
  const r = reunioes.find((x) => x.id === selecionada)
  if (!r) return fechar()
  const c = r.copiloto
  const rolagem = $('detalhe').querySelector('.detalhe-rolagem')
  const posicao = rolagem.scrollTop

  $('d-titulo').textContent = r.titulo
  const dia = r._inicio.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
  $('d-quando').innerHTML = r.vivo
    ? `${esc(dia)} · desde ${hm(r._inicio)} <span class="chip vivo">ao vivo</span>`
    : `${esc(dia)} · ${hm(r._inicio)} – ${hm(r._fim)} · ${duracaoTexto((r._fim - r._inicio) / 60000)}`

  const cores = coresDasPessoas(r)
  $('d-pessoas').innerHTML = [...cores].map(([nome, cor]) => `<span class="chip"><i style="background:${cor}"></i>${esc(nome)}</span>`).join('')

  const numeros = [`${r.falas.length} ${r.falas.length === 1 ? 'fala' : 'falas'}`]
  if (c) {
    numeros.push(`${c.etapas.filter((e) => e.status === 2).length}/${c.etapas.length} etapas do roteiro`)
    if (c.falas.length) numeros.push(`fala: você ${c.fala.vendedor}% · cliente ${c.fala.cliente}%`)
    if (c.custo) numeros.push(`IA US$ ${Number(c.custo).toFixed(3)}`)
  }
  $('d-numeros').innerHTML = numeros.map((n) => `<span class="chip">${esc(n)}</span>`).join('') + (c && c.resumo ? '<span class="chip ok">✦ resumo do copiloto</span>' : '')

  const link = $('abrir-meet')
  link.hidden = !r.url
  if (r.url) link.href = r.url

  const temResumo = Boolean(c && c.resumo)
  if (!aba) aba = temResumo ? 'resumo' : 'transcricao'
  for (const b of document.querySelectorAll('[data-aba]')) b.classList.toggle('ativo', b.dataset.aba === aba)
  document.querySelector('[data-aba="transcricao"]').textContent = `Transcrição (${r.falas.length})`
  $('aba-resumo').hidden = aba !== 'resumo'
  $('aba-transcricao').hidden = aba !== 'transcricao'

  // Resumo: as seções, sem o título e a linha de números (já estão em cima).
  if (temResumo) {
    const i = c.resumo.indexOf('\n## ')
    $('d-resumo').innerHTML = markdown(i >= 0 ? c.resumo.slice(i + 1) : c.resumo)
  } else $('d-resumo').innerHTML = ''
  $('d-sem-resumo').hidden = temResumo
  if (!temResumo) {
    const gerando = $('gerar').dataset.gerando === r.id
    $('gerar').hidden = r.vivo || !r.falas.length
    $('gerar').disabled = gerando || !disponivel
    $('gerar').textContent = gerando ? 'Escrevendo o resumo… (até 1 min)' : 'Gerar o resumo agora'
    $('d-sem-resumo-texto').textContent = r.vivo
      ? c && c.ativo
        ? 'O copiloto está acompanhando esta call. O resumo aparece aqui quando ela acabar.'
        : 'Call em andamento, com o copiloto desligado. Dá para ligá-lo no painel lateral do Meet.'
      : !r.falas.length
        ? 'Esta call não tem fala transcrita.'
        : disponivel
          ? 'Esta call não tem resumo do copiloto. Dá para gerar agora, a partir da transcrição (uns US$ 0,03).'
          : 'Esta call não tem resumo. Para gerar, entre com o seu e-mail da Gravaê no popup (⚙ › Copiloto de vendas).'
  }

  const termo = $('d-busca').value.trim()
  const termoNormal = normal(termo)
  $('d-falas').innerHTML = turnos(r.falas)
    .map((t) => {
      const visivel = !termo || normal(t.texto).includes(termoNormal) || normal(t.nome).includes(termoNormal)
      return `<li class="${visivel ? '' : 'escondida'}"><time>${hm(new Date(t.hora))}</time><div><b style="color:${cores.get(t.nome) || 'inherit'}">${esc(t.nome)}</b><p>${realcar(t.texto, termo)}</p></div></li>`
    })
    .join('')
  rolagem.scrollTop = posicao
}

for (const b of document.querySelectorAll('[data-aba]')) {
  b.addEventListener('click', () => {
    aba = b.dataset.aba
    desenharDetalhe()
  })
}
$('d-busca').addEventListener('input', desenharDetalhe)

$('gerar').addEventListener('click', async () => {
  const id = selecionada
  $('gerar').dataset.gerando = id
  desenharDetalhe()
  try {
    await Ponte.api(`/v1/calls/${encodeURIComponent(id)}/resumir`, { metodo: 'POST', corpo: {} })
  } catch (e) {
    $('d-sem-resumo-texto').textContent = 'Não deu: ' + e.message
  }
  delete $('gerar').dataset.gerando
  await carregarDetalhe(id)
  await carregar()
})

// ---------- ações ----------

function paraArquivo(r) {
  let md = Formato.paraMarkdown(r)
  if (r.copiloto && r.copiloto.resumo) md += '\n---\n\n' + r.copiloto.resumo
  return md
}

$('baixar').addEventListener('click', async () => {
  const r = reunioes.find((x) => x.id === selecionada)
  if (!r) return
  const url = URL.createObjectURL(new Blob([paraArquivo(r)], { type: 'text/markdown;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = Formato.nomeArquivo(r, 'md').split('/').pop()
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
})

$('copiar').addEventListener('click', async () => {
  const r = reunioes.find((x) => x.id === selecionada)
  if (!r) return
  await navigator.clipboard.writeText(paraArquivo(r))
  $('copiar').textContent = 'Copiado'
  setTimeout(() => ($('copiar').textContent = 'Copiar'), 1500)
})

$('apagar').addEventListener('click', async () => {
  const b = $('apagar')
  if (!b.dataset.confirmar) {
    b.dataset.confirmar = '1'
    b.textContent = 'Apagar mesmo?'
    setTimeout(() => {
      delete b.dataset.confirmar
      b.textContent = 'Apagar'
    }, 4000)
    return
  }
  const id = selecionada
  try {
    await Ponte.api('/v1/calls/' + encodeURIComponent(id), { metodo: 'DELETE' })
  } catch (e) {
    b.textContent = 'Não deu: ' + e.message
    return
  }
  delete detalhes[id]
  delete b.dataset.confirmar
  b.textContent = 'Apagar'
  fechar()
  carregar()
})

// ---------- começo ----------

// A extensão manda o login e, se veio do popup ou do painel, qual call abrir.
let pedida = null
function abrirPedida() {
  const r = pedida && reunioes.find((x) => x.id === pedida)
  if (r && r.id !== selecionada) {
    irPara(r._inicio)
    abrir(r.id)
  }
  if (r) pedida = null
}

let comecou = false
Ponte.aoContexto(async (c) => {
  disponivel = Boolean(c.token)
  if (c.abrir) pedida = c.abrir
  await carregar()
  abrirPedida()
  if (!comecou) {
    comecou = true
    // O "agora" e as calls ao vivo andam sozinhos; a call aberta, se ao vivo, a cada 10 s.
    setInterval(carregar, 60000)
    setInterval(() => {
      const r = reunioes.find((x) => x.id === selecionada)
      if (r && r.vivo && !document.hidden) carregarDetalhe(r.id)
    }, 10000)
  }
})
