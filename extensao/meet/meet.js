// Content script do Google Meet: espera a chamada começar, liga as legendas,
// lê o que aparece nelas e guarda a transcrição no chrome.storage.local. Cada
// fala vai também para o service worker, que manda ao servidor da Gravaê (onde
// a call fica guardada e o copiloto roda).
(function () {
  const S = SELETORES_MEET
  const CONFIG_PADRAO = { automatico: true, baixarAoSair: true, esconderLegendas: false, meuNome: '' }

  let config = { ...CONFIG_PADRAO }
  let reuniao = null
  let transcricao = null
  let regiao = null
  let observador = null
  let nomeUsuario = ''
  let encerrada = false
  let pilula = null
  const blocos = new Map() // bloco -> { nomeEl, textoEl }
  const enviadas = new Map() // índice da fala -> o que o copiloto já recebeu dela
  let ultimoSinal = Date.now() // a última vez que a call deu sinal de vida
  let avisoIdioma = ''

  // ---------- utilidades ----------

  function icone(texto) {
    return [...document.querySelectorAll(S.ICONE)].find((el) => el.textContent.trim() === texto)
  }

  function esperar(teste, intervalo = 500) {
    return new Promise((resolve) => {
      const tentar = () => {
        const achado = teste()
        if (achado) resolve(achado)
        else setTimeout(tentar, intervalo)
      }
      tentar()
    })
  }

  function extensaoViva() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id)
    } catch {
      return false
    }
  }

  function avisarFundo(mensagem) {
    if (!extensaoViva()) return
    try {
      chrome.runtime.sendMessage(mensagem, () => void chrome.runtime.lastError)
    } catch {}
  }

  // ---------- salvar ----------

  let salvarPendente = null
  function salvarLogo() {
    if (salvarPendente) return
    salvarPendente = setTimeout(salvarAgora, 2000)
  }

  function salvarAgora() {
    clearTimeout(salvarPendente)
    salvarPendente = null
    if (!reuniao || !extensaoViva()) return Promise.resolve()
    reuniao.atualizado = new Date().toISOString()
    return chrome.storage.local.set({ ['reuniao:' + reuniao.id]: reuniao }).catch(() => {})
  }

  // ---------- as falas para o copiloto ----------

  function paraCopiloto(dados) {
    avisarFundo({ tipo: 'meet', dados })
  }

  // Avisa o service worker que a chamada existe e manda as falas que já tem.
  function anunciar() {
    if (!reuniao || encerrada) return
    enviadas.clear()
    const { id, codigo, titulo, url, inicio } = reuniao
    paraCopiloto({ tipo: 'meet-inicio', reuniao: { id, codigo, titulo, url, inicio } })
    enviarFalas(true)
  }

  // As falas mudam no lugar enquanto a pessoa fala (e o Meet corrige palavras);
  // só as que mudaram desde o último envio vão de novo. Correção acontece nas
  // falas recentes, então fora da retomada bastam as últimas 30.
  function enviarFalas(todas = false) {
    const falas = reuniao.falas
    for (let i = todas ? 0 : Math.max(0, falas.length - 30); i < falas.length; i++) {
      const f = falas[i]
      const marca = `${f.nome}\u0001${f.texto}\u0001${f.eu ? 1 : 0}`
      if (enviadas.get(i) === marca) continue
      enviadas.set(i, marca)
      paraCopiloto({ tipo: 'meet-fala', reuniao_id: reuniao.id, i, nome: f.nome, eu: Boolean(f.eu), texto: f.texto, hora: f.hora })
    }
  }

  // ---------- diagnóstico ----------

  // A estrutura da área das legendas, resumida: é o que mostra o que o Google
  // mudou quando a leitura quebra. O popup copia (botão Diagnóstico) para mandar
  // a quem cuida da extensão. Texto cortado em 40 caracteres.
  function arvore(el, nivel = 0) {
    const proprio = [...el.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.data)
      .join('')
      .trim()
    const no = { t: el.tagName.toLowerCase() }
    if (el.className && typeof el.className === 'string') no.c = el.className.slice(0, 80)
    for (const [atributo, chave] of [['role', 'r'], ['aria-label', 'a'], ['jsname', 'j']]) {
      if (el.getAttribute(atributo)) no[chave] = el.getAttribute(atributo).slice(0, 60)
    }
    if (proprio) no.x = proprio.length > 40 ? proprio.slice(0, 40) + `… (${proprio.length})` : proprio
    const filhos = [...el.children]
    if (filhos.length) {
      no.f = filhos.length
      if (nivel < 8) no.k = filhos.slice(-6).map((filho) => arvore(filho, nivel + 1))
    }
    return no
  }

  function caminho(el) {
    const passos = []
    while (el && el !== regiao && passos.length < 12) {
      const pai = el.parentElement
      passos.unshift(pai ? [...pai.children].indexOf(el) : 0)
      el = pai
    }
    return passos.join('>')
  }

  function diagnostico(motivo) {
    if (!reuniao) return null
    const falas = reuniao.falas
    return {
      tipo: 'meet-diagnostico',
      motivo,
      reuniao_id: reuniao.id,
      versao: chrome.runtime.getManifest().version,
      idioma_navegador: navigator.language,
      falas: falas.length,
      maior_fala: falas.reduce((m, f) => Math.max(m, f.texto.length), 0),
      ultimas: falas.slice(-4).map((f) => ({ nome: f.nome, eu: Boolean(f.eu), n: f.texto.length, fim: f.texto.slice(-120) })),
      blocos: [...blocos].map(([bloco, { nomeEl, textoEl }]) => ({
        caminho: caminho(bloco),
        nome: limparTexto(nomeEl.textContent).slice(0, 40),
        texto: limparTexto(textoEl.textContent).length,
        vivo: bloco.isConnected
      })),
      regiao: regiao ? arvore(regiao) : null
    }
  }

  // ---------- idioma das legendas ----------

  // O Meet escreve as legendas no idioma escolhido nas configurações dele, não
  // no que se fala. Em inglês numa call em português, sai "Kentucky" no lugar de
  // "quem tá aqui". Conta palavras curtas que entregam cada idioma.
  const PALAVRAS = {
    pt: new Set('que não nao é eu você voce pra para tá ta uma um com isso aqui então entao mas tem gente também tambem do da no na'.split(' ')),
    en: new Set('the and you is to of that it this what we are for with have i so just like yeah okay'.split(' '))
  }

  function idiomaDasFalas() {
    const palavras = reuniao.falas
      .slice(-40)
      .map((f) => f.texto)
      .join(' ')
      .toLowerCase()
      .match(/[a-záàâãéêíóôõúç']+/g) || []
    if (palavras.length < 40) return null
    const pt = palavras.filter((p) => PALAVRAS.pt.has(p)).length
    const en = palavras.filter((p) => PALAVRAS.en.has(p)).length
    if (en > Math.max(4, pt * 1.5)) return 'en'
    if (pt > Math.max(4, en * 1.5)) return 'pt'
    return null
  }

  let idiomaConferido = 0
  function conferirIdioma() {
    if (Date.now() - idiomaConferido < 20000) return
    idiomaConferido = Date.now()
    const idioma = idiomaDasFalas()
    if (!idioma) return
    const esperado = (navigator.language || 'pt').slice(0, 2)
    avisoIdioma = esperado === 'pt' && idioma === 'en' ? 'Legendas em inglês: no Meet, ⋮ › Configurações › Legendas › Português' : ''
  }

  // ---------- leitura das legendas ----------

  function nomeDe(nome) {
    const limpo = limparTexto(nome)
    if (S.VOCE.includes(limpo)) return config.meuNome || nomeUsuario || limpo
    return limpo
  }

  // O bloco de uma fala tem duas partes: em cima a foto e o nome, embaixo o
  // texto. Subindo a partir do texto até achar esse formato, a leitura não
  // depende de como o texto está aninhado lá dentro.
  function acharBloco(no) {
    let el = no.parentElement
    while (el && el !== regiao && regiao.contains(el)) {
      const partes = [...el.children]
      const textoEl = partes[partes.length - 1]
      const antes = partes.slice(0, -1)
      // A parte do texto nunca tem foto: se tem, "el" é a caixa com todos os blocos.
      if (antes.length && textoEl.contains(no) && !textoEl.querySelector('img') && antes.some((p) => p.matches('img') || p.querySelector('img'))) {
        // No Meet, foto e nome ficam juntos; senão, o nome é o que vem logo antes do texto.
        return { bloco: el, nomeEl: antes[antes.length - 1], textoEl }
      }
      el = el.parentElement
    }
    // Sem foto: o jeito antigo, com o nome logo antes do texto.
    const textoEl = no.parentElement
    return { textoEl, nomeEl: textoEl && textoEl.previousElementSibling, bloco: textoEl && textoEl.parentElement }
  }

  function registrarTexto(no) {
    if (!regiao || !limparTexto(no.data)) return
    const { bloco, nomeEl, textoEl } = acharBloco(no)
    if (!nomeEl || !bloco || bloco === regiao || !regiao.contains(bloco) || blocos.has(bloco)) return
    const nome = limparTexto(nomeEl.textContent)
    if (!nome || nome.length > 80 || !limparTexto(textoEl.textContent)) return
    // Botões da área de legendas ("Ir para o fim") têm um ícone no lugar do
    // nome, e o texto do ícone é o nome dele: "arrow_downward".
    if (nomeEl.matches(S.ICONE) || nomeEl.querySelector(S.ICONE) || /^[a-z]+(_[a-z]+)+$/.test(nome)) return
    blocos.set(bloco, { nomeEl, textoEl })
  }

  function registrarTextosDentro(el) {
    const andador = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    while (andador.nextNode()) registrarTexto(andador.currentNode)
  }

  function lerBlocos() {
    let mudou = false
    for (const [bloco, { nomeEl, textoEl }] of blocos) {
      if (!bloco.isConnected) {
        blocos.delete(bloco)
        transcricao.esquecer(bloco)
        continue
      }
      const cru = limparTexto(nomeEl.textContent)
      const nome = nomeDe(cru)
      if (transcricao.atualizar(bloco, nome, textoEl.textContent)) {
        mudou = true
        const fala = transcricao.falaDoBloco(bloco)
        if (fala && fala.nome === nome) fala.eu = S.VOCE.includes(cru)
      }
    }
    if (mudou) {
      reuniao.participantes = [...new Set(reuniao.falas.map((f) => f.nome))]
      salvarLogo()
      enviarFalas()
      conferirIdioma()
      atualizarPilula()
    }
  }

  let leituraPendente = false
  function aoMudar(mutacoes) {
    for (const m of mutacoes) {
      if (m.type === 'characterData') registrarTexto(m.target)
      for (const no of m.addedNodes) {
        if (no.nodeType === Node.TEXT_NODE) registrarTexto(no)
        else if (no.nodeType === Node.ELEMENT_NODE) registrarTextosDentro(no)
      }
    }
    if (leituraPendente) return
    leituraPendente = true
    setTimeout(() => {
      leituraPendente = false
      lerBlocos()
    }, 300)
  }

  // A área das legendas. O Meet tem outras "regiões" (chat, pessoas,
  // apresentação): em 07/10 a extensão passou a observar uma delas no meio da
  // call e só as primeiras falas foram salvas. Agora vale a que se chama
  // "Legendas" (ou Captions, Subtítulos…), e ela não é trocada enquanto existir.
  function ehRegiaoDeLegendas(el) {
    return S.ROTULO_LEGENDAS.test(el.getAttribute('aria-label') || '')
  }

  let semRegiao = 0
  function vigiarRegiao() {
    const rotulada = () => [...document.querySelectorAll(S.REGIOES)].find(ehRegiaoDeLegendas)
    if (regiao && regiao.isConnected) {
      semRegiao = 0
      if (ehRegiaoDeLegendas(regiao)) return
      // A atual não tem nome de legendas: troca só se aparecer uma que tenha.
      const melhor = rotulada()
      if (melhor) observar(melhor)
      return
    }
    // Ainda não achou, ou o Meet tirou a área da tela (refaz quando alguém apresenta).
    semRegiao++
    const nova = rotulada()
    if (nova) return observar(nova)
    // Meet num idioma sem nome conhecido: a primeira região com tabindex, mas só
    // no começo ou depois de 6 s sem a anterior.
    const qualquer = document.querySelector(S.REGIAO_LEGENDAS)
    if (qualquer && (!regiao || semRegiao >= 3)) observar(qualquer)
  }

  function observar(nova) {
    if (observador) observador.disconnect()
    regiao = nova
    observador = new MutationObserver(aoMudar)
    observador.observe(regiao, { subtree: true, childList: true, characterData: true })
    regiao.style.opacity = config.esconderLegendas ? '0' : ''
    // Área refeita: as legendas que ainda estão nela continuam as falas já
    // guardadas, em vez de virar falas repetidas.
    transcricao.retomar()
    registrarTextosDentro(regiao)
    lerBlocos()
    transcricao.fimDaRetomada()
  }

  // ---------- início e fim da chamada ----------

  function capturarNomeUsuario() {
    const busca = setInterval(() => {
      const nome = limparTexto(document.querySelector(S.NOME_USUARIO)?.textContent)
      if (nome) nomeUsuario = nome
      if (nome || reuniao) clearInterval(busca)
    }, 500)
  }

  function atualizarTitulo() {
    const titulo = limparTexto(document.querySelector(S.TITULO)?.textContent)
    if (titulo && titulo !== reuniao.codigo && titulo !== reuniao.titulo) {
      reuniao.titulo = titulo
      salvarLogo()
    }
  }

  async function ligarLegendas() {
    const achado = await Promise.race([
      esperar(() => icone(S.ICONE_LEGENDA_DESLIGADA) || icone(S.ICONE_LEGENDA_LIGADA)),
      new Promise((r) => setTimeout(r, 60000))
    ])
    if (!achado) return atualizarPilula('Não achei o botão de legendas')
    if (config.automatico && achado.textContent.trim() === S.ICONE_LEGENDA_DESLIGADA) {
      ;(achado.closest('button') || achado).click()
    }
  }

  async function encerrar() {
    if (encerrada || !reuniao) return
    encerrada = true
    lerBlocos()
    if (observador) observador.disconnect()
    // O fim é a última vez que a call deu sinal (a aba pode ter ficado em segundo plano).
    reuniao.fim = new Date(Math.min(Date.now(), ultimoSinal + 10000)).toISOString()
    await salvarAgora()
    avisarFundo({ tipo: 'reuniao-encerrada', id: reuniao.id })
    atualizarPilula(reuniao.falas.length ? 'Transcrição salva' : 'Nada foi transcrito')
    setTimeout(() => pilula && pilula.remove(), 8000)
  }

  // A mesma chamada ainda aberta e mexida há pouco (a aba recarregou ou a
  // extensão foi atualizada no meio): continua nela em vez de abrir outra.
  async function reuniaoParaRetomar(codigo) {
    const tudo = await chrome.storage.local.get(null)
    const agora = Date.now()
    return Object.entries(tudo)
      .filter(([chave, r]) => chave.startsWith('reuniao:') && r.codigo === codigo && !r.fim)
      .map(([, r]) => r)
      .filter((r) => agora - new Date(r.atualizado || r.inicio).getTime() < 15 * 60000)
      .sort((a, b) => b.inicio.localeCompare(a.inicio))[0] || null
  }

  // Onde ler as legendas: o servidor publica (o service worker guarda uma vez por
  // dia) e vale por cima do que veio na extensão (seletores.js). Seletor que não
  // funciona no navegador é ignorado.
  async function aplicarSeletoresRemotos() {
    try {
      const { seletoresMeet } = await chrome.storage.local.get('seletoresMeet')
      const d = seletoresMeet && seletoresMeet.dados
      if (!d) return
      for (const k of ['ICONE', 'REGIOES', 'REGIAO_LEGENDAS', 'NOME_USUARIO', 'TITULO']) {
        if (typeof d[k] !== 'string' || !d[k]) continue
        try {
          document.querySelector(d[k])
          S[k] = d[k]
        } catch {}
      }
      for (const k of ['ICONE_SAIR', 'ICONE_LEGENDA_DESLIGADA', 'ICONE_LEGENDA_LIGADA']) if (typeof d[k] === 'string' && d[k]) S[k] = d[k]
      if (typeof d.ROTULO_LEGENDAS === 'string' && d.ROTULO_LEGENDAS) S.ROTULO_LEGENDAS = new RegExp(d.ROTULO_LEGENDAS, 'i')
      if (Array.isArray(d.VOCE) && d.VOCE.length) S.VOCE = d.VOCE
    } catch {}
  }

  async function iniciar() {
    await aplicarSeletoresRemotos()
    config = { ...CONFIG_PADRAO, ...(await chrome.storage.sync.get(CONFIG_PADRAO)) }
    capturarNomeUsuario()

    // Dentro da chamada, o botão de sair aparece. Na tela de entrada, não.
    const sair = await esperar(() => icone(S.ICONE_SAIR))
    const codigo = location.pathname.replace(/^\//, '').split(/[/?#]/)[0] || 'sem-codigo'
    reuniao = await reuniaoParaRetomar(codigo)
    transcricao = new Transcricao(reuniao ? reuniao.falas : [])
    if (reuniao) {
      transcricao.retomar()
      setTimeout(() => transcricao.fimDaRetomada(), 15000)
    } else {
      const inicio = new Date()
      reuniao = {
        id: codigo + '-' + inicio.getTime(),
        codigo,
        titulo: codigo,
        url: location.origin + '/' + codigo,
        inicio: inicio.toISOString(),
        fim: null,
        participantes: [],
        falas: transcricao.falas
      }
    }
    await salvarAgora()
    avisarFundo({ tipo: 'reuniao-iniciada', id: reuniao.id })
    mostrarPilula()
    atualizarTitulo()
    anunciar()

    ;(sair.closest('button') || sair).addEventListener('click', encerrar, { capture: true })
    window.addEventListener('pagehide', () => {
      lerBlocos()
      salvarAgora()
    })

    ligarLegendas()

    let semBotaoSair = 0
    let legendasDesligadas = 0
    let ultimaReligada = 0
    const vigia = setInterval(() => {
      if (encerrada || !extensaoViva()) return clearInterval(vigia)
      vigiarRegiao()
      atualizarTitulo()
      // Saiu da chamada sem clicar em sair (caiu, foi removido, a chamada acabou).
      // Com a aba em segundo plano ou o Meet na janelinha flutuante, o botão de
      // sair some da página sem a call ter acabado: aí não conta.
      const pip = window.documentPictureInPicture && window.documentPictureInPicture.window
      if (icone(S.ICONE_SAIR) || document.hidden || pip) {
        semBotaoSair = 0
        ultimoSinal = Date.now()
      } else semBotaoSair++
      if (semBotaoSair >= 5) encerrar()
      // As legendas desligaram no meio da call: religa (a transcrição depende delas).
      legendasDesligadas = icone(S.ICONE_LEGENDA_DESLIGADA) && !icone(S.ICONE_LEGENDA_LIGADA) ? legendasDesligadas + 1 : 0
      if (config.automatico && legendasDesligadas >= 2 && Date.now() - ultimaReligada > 30000) {
        ultimaReligada = Date.now()
        const botao = icone(S.ICONE_LEGENDA_DESLIGADA)
        ;(botao.closest('button') || botao).click()
        atualizarPilula('Legendas religadas para continuar transcrevendo')
        setTimeout(() => atualizarPilula(), 6000)
      }
    }, 2000)
    vigiarRegiao()
  }

  // ---------- indicador na tela ----------

  function mostrarPilula() {
    // Uma cópia anterior do script (de antes de atualizar a extensão) pode ter deixado a dela.
    document.getElementById('transcritor-pilula')?.remove()
    pilula = document.createElement('div')
    pilula.id = 'transcritor-pilula'
    // Tema Gravaê: fundo zinc escuro, ponto no vermelho da marca.
    pilula.style.cssText = [
      'position:fixed', 'top:12px', 'left:12px', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'gap:8px', 'padding:6px 12px 6px 10px', 'max-width:60vw',
      'border-radius:999px', 'background:rgba(24,24,27,.92)', 'border:1px solid #3f3f46', 'color:#f2f2fa',
      'font:600 12.5px/1.25 "Segoe UI",system-ui,sans-serif',
      'box-shadow:0 4px 14px rgba(0,0,0,.35)', 'pointer-events:none'
    ].join(';')
    pilula.innerHTML =
      '<span style="flex:none;width:9px;height:9px;border-radius:50%;background:#d30404"></span>' +
      '<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></span>'
    document.documentElement.appendChild(pilula)
    atualizarPilula()
  }

  function atualizarPilula(aviso) {
    if (!pilula) return
    const n = reuniao ? reuniao.falas.length : 0
    const base = n ? `Transcrevendo · ${n} ${n === 1 ? 'fala' : 'falas'}` : 'Transcrevendo · esperando legendas'
    const texto = aviso || avisoIdioma || base
    pilula.lastChild.textContent = texto
    pilula.firstChild.style.background = encerrada ? '#1fb055' : aviso || avisoIdioma ? '#f59e0b' : '#d30404'
  }

  chrome.storage.onChanged.addListener((mudancas, area) => {
    if (area !== 'sync') return
    for (const [chave, { newValue }] of Object.entries(mudancas)) if (chave in CONFIG_PADRAO) config[chave] = newValue
    if (regiao) regiao.style.opacity = config.esconderLegendas ? '0' : ''
  })

  // O fundo e o popup perguntam se já tem transcrição rodando nesta aba antes
  // de injetar o script de novo.
  chrome.runtime.onMessage.addListener((mensagem, _remetente, responder) => {
    if (mensagem.tipo === 'diagnostico') {
      const dados = diagnostico('pedido')
      responder({ ok: Boolean(dados), dados })
      return
    }
    if (mensagem.tipo !== 'ping') return
    responder({
      ok: true,
      falas: reuniao ? reuniao.falas.length : 0,
      naChamada: Boolean(reuniao),
      encerrada,
      reuniao: reuniao ? reuniao.id : null,
      avisoIdioma
    })
  })

  iniciar()
})()
