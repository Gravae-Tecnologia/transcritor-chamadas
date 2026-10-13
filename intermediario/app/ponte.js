// O que as páginas do servidor (painel e agenda) usam para falar com a extensão
// e com o servidor. Elas abrem dentro da extensão (num iframe): a extensão manda
// o login ({tipo: 'contexto', token, ...}) por postMessage, e daí em diante a
// página chama o servidor direto, com o login. O token fica só na memória.
;(function (raiz) {
  const BASE = location.pathname.replace(/\/app\/[^/]*$/, '') // "/copiloto"
  let contexto = null
  const ouvintes = []

  function souDaExtensao(evento) {
    return evento.source === window.parent && /^chrome-extension:\/\//.test(evento.origin)
  }

  addEventListener('message', (evento) => {
    if (!souDaExtensao(evento) || !evento.data || evento.data.tipo !== 'contexto') return
    contexto = { ...evento.data, origem: evento.origin }
    for (const f of ouvintes) f(contexto)
  })

  // Para a extensão: "abra a agenda", "abra este endereço"...
  function avisar(mensagem) {
    if (contexto) window.parent.postMessage(mensagem, contexto.origem)
  }

  async function api(caminho, { metodo = 'GET', corpo } = {}) {
    if (!contexto || !contexto.token) throw new Error('sem login')
    const r = await fetch(BASE + caminho, {
      method: metodo,
      headers: { Authorization: 'Bearer ' + contexto.token, ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      cache: 'no-store'
    })
    const dados = await r.json().catch(() => ({}))
    if (r.status === 401) {
      avisar({ tipo: 'sem-login' })
      throw new Error('sem login')
    }
    if (!r.ok) {
      const erro = new Error(dados.erro || `HTTP ${r.status}`)
      erro.status = r.status
      throw erro
    }
    return dados
  }

  raiz.Ponte = {
    api,
    avisar,
    aoContexto: (f) => {
      ouvintes.push(f)
      if (contexto) f(contexto)
    },
    contexto: () => contexto
  }
  // Pede o contexto (a extensão também manda sozinha quando muda de aba).
  window.parent.postMessage({ tipo: 'pronto' }, '*')
})(window)
