// A casca das telas que moram no servidor (o painel do copiloto e a agenda):
// abre a página do servidor num iframe e entrega a ela o login e o contexto
// (qual call). Mudar essas telas não pede atualizar a extensão.
// eslint-disable-next-line no-unused-vars
function abrirCasca(pagina) {
  const app = document.getElementById('app')
  const aviso = document.getElementById('aviso')
  const origem = new URL(SERVIDOR).origin
  let extra = {}
  let pronta = false
  let espera = null

  function mostrarAviso(titulo, texto, tentar) {
    document.getElementById('aviso-titulo').textContent = titulo
    document.getElementById('aviso-texto').textContent = texto
    document.getElementById('aviso-tentar').hidden = !tentar
    aviso.hidden = false
    app.hidden = true
  }

  async function sessao() {
    const { sessaoCopiloto: s } = await chrome.storage.local.get('sessaoCopiloto')
    return s && s.token && s.exp * 1000 > Date.now() ? s : null
  }

  function carregar() {
    pronta = false
    // Visível desde já: a página do servidor mede a largura da tela ao carregar.
    aviso.hidden = true
    app.hidden = false
    app.src = `${SERVIDOR}/app/${pagina}?v=${chrome.runtime.getManifest().version}`
    clearTimeout(espera)
    espera = setTimeout(() => {
      if (!pronta) mostrarAviso('Sem conexão com o servidor da Gravaê', 'Confira a internet e tente de novo.', true)
    }, 10000)
  }

  async function mandar() {
    const s = await sessao()
    if (!s) {
      app.removeAttribute('src')
      pronta = false
      return mostrarAviso('Entre com o seu e-mail da Gravaê', 'Clique no G. da Gravaê na barra do Chrome › ⚙ › Copiloto de vendas, e peça o código. É uma vez só.')
    }
    if (!app.getAttribute('src')) return carregar()
    if (!pronta) return
    aviso.hidden = true
    app.hidden = false
    app.contentWindow.postMessage({ tipo: 'contexto', token: s.token, email: s.email, versao: chrome.runtime.getManifest().version, ...extra }, origem)
  }

  addEventListener('message', (evento) => {
    if (evento.source !== app.contentWindow || evento.origin !== origem || !evento.data) return
    const m = evento.data
    if (m.tipo === 'pronto') {
      pronta = true
      clearTimeout(espera)
      mandar()
    }
    if (m.tipo === 'abrir-agenda') {
      chrome.tabs.create({ url: chrome.runtime.getURL('agenda/agenda.html') + (m.reuniao ? '#reuniao=' + encodeURIComponent(m.reuniao) : '') })
    }
    if (m.tipo === 'sem-login') mandar()
  })
  document.getElementById('aviso-tentar').addEventListener('click', () => {
    aviso.hidden = true
    carregar()
  })
  chrome.storage.onChanged.addListener((mudancas, area) => {
    if (area === 'local' && mudancas.sessaoCopiloto) mandar()
  })
  mandar()

  return {
    // Muda o contexto (a call da aba, a call a abrir na agenda) e avisa a página.
    definir(novo) {
      extra = { ...extra, ...novo }
      mandar()
    }
  }
}
