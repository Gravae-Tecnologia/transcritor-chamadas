// Content script do Google Meet: espera a chamada começar, liga as legendas,
// lê o que aparece nelas e guarda a transcrição no chrome.storage.local.
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

  // ---------- leitura das legendas ----------

  function nomeDe(nome) {
    const limpo = limparTexto(nome)
    if (S.VOCE.includes(limpo)) return config.meuNome || nomeUsuario || limpo
    return limpo
  }

  // A partir de um texto que mudou, acha o bloco da legenda: o texto fica
  // num elemento cujo irmão anterior é o nome de quem fala, e os dois moram
  // dentro do bloco.
  function registrarTexto(no) {
    const textoEl = no.parentElement
    const nomeEl = textoEl && textoEl.previousElementSibling
    const bloco = textoEl && textoEl.parentElement
    if (!nomeEl || !bloco || bloco === regiao || !regiao.contains(bloco) || blocos.has(bloco)) return
    if (!limparTexto(no.data)) return
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
      if (transcricao.atualizar(bloco, nomeDe(nomeEl.textContent), textoEl.textContent)) mudou = true
    }
    if (mudou) {
      reuniao.participantes = [...new Set(reuniao.falas.map((f) => f.nome))]
      salvarLogo()
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

  // O Meet às vezes troca a área das legendas por outra; a cada 2 s confere
  // se é a mesma e, se não for, passa a observar a nova.
  function vigiarRegiao() {
    const atual = document.querySelector(S.REGIAO_LEGENDAS)
    if (!atual || atual === regiao) return
    if (observador) observador.disconnect()
    regiao = atual
    observador = new MutationObserver(aoMudar)
    observador.observe(regiao, { subtree: true, childList: true, characterData: true })
    regiao.style.opacity = config.esconderLegendas ? '0' : ''
    registrarTextosDentro(regiao)
    lerBlocos()
    // O que estava na tela já foi casado com as falas guardadas.
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
    reuniao.fim = new Date().toISOString()
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

  async function iniciar() {
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

    ;(sair.closest('button') || sair).addEventListener('click', encerrar, { capture: true })
    window.addEventListener('pagehide', () => {
      lerBlocos()
      salvarAgora()
    })

    ligarLegendas()

    let semBotaoSair = 0
    const vigia = setInterval(() => {
      if (encerrada || !extensaoViva()) return clearInterval(vigia)
      vigiarRegiao()
      atualizarTitulo()
      // Saiu da chamada sem clicar em sair (caiu, foi removido, a chamada acabou).
      semBotaoSair = icone(S.ICONE_SAIR) ? 0 : semBotaoSair + 1
      if (semBotaoSair >= 3) encerrar()
    }, 2000)
    vigiarRegiao()
  }

  // ---------- indicador na tela ----------

  function mostrarPilula() {
    // Uma cópia anterior do script (de antes de atualizar a extensão) pode ter deixado a dela.
    document.getElementById('transcritor-pilula')?.remove()
    pilula = document.createElement('div')
    pilula.id = 'transcritor-pilula'
    pilula.style.cssText = [
      'position:fixed', 'top:12px', 'left:12px', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'gap:8px', 'padding:6px 12px',
      'border-radius:999px', 'background:rgba(32,33,36,.85)', 'color:#fff',
      'font:500 13px/1.2 system-ui,sans-serif', 'pointer-events:none'
    ].join(';')
    pilula.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#ea4335"></span><span></span>'
    document.documentElement.appendChild(pilula)
    atualizarPilula()
  }

  function atualizarPilula(aviso) {
    if (!pilula) return
    const n = reuniao ? reuniao.falas.length : 0
    const texto = aviso || (n ? `Transcrevendo · ${n} ${n === 1 ? 'fala' : 'falas'}` : 'Transcrevendo · esperando legendas')
    pilula.lastChild.textContent = texto
    pilula.firstChild.style.background = encerrada ? '#34a853' : aviso ? '#fbbc04' : '#ea4335'
  }

  chrome.storage.onChanged.addListener((mudancas, area) => {
    if (area !== 'sync') return
    for (const [chave, { newValue }] of Object.entries(mudancas)) if (chave in CONFIG_PADRAO) config[chave] = newValue
    if (regiao) regiao.style.opacity = config.esconderLegendas ? '0' : ''
  })

  // O fundo e o popup perguntam se já tem transcrição rodando nesta aba antes
  // de injetar o script de novo.
  chrome.runtime.onMessage.addListener((mensagem, _remetente, responder) => {
    if (mensagem.tipo !== 'ping') return
    responder({ ok: true, falas: reuniao ? reuniao.falas.length : 0, naChamada: Boolean(reuniao), encerrada })
  })

  iniciar()
})()
