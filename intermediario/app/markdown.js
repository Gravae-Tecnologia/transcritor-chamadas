// Markdown simples para HTML: o resumo do copiloto (títulos, listas, negrito,
// itálico, código). Escapa tudo antes, então texto da call nunca vira HTML.
(function (raiz) {
  function esc(texto) {
    return String(texto ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  }

  function inline(texto) {
    return esc(texto)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
  }

  function markdown(md) {
    const saida = []
    let lista = null // 'ul' | 'ol'
    let paragrafo = []
    const fecharParagrafo = () => {
      if (paragrafo.length) saida.push(`<p>${paragrafo.map(inline).join('<br>')}</p>`)
      paragrafo = []
    }
    const fecharLista = () => {
      if (lista) saida.push(`</${lista}>`)
      lista = null
    }
    for (const bruta of String(md || '').split('\n')) {
      const linha = bruta.trimEnd()
      let m
      if (!linha.trim()) {
        fecharParagrafo()
        fecharLista()
      } else if ((m = linha.match(/^(#{1,4})\s+(.*)$/))) {
        fecharParagrafo()
        fecharLista()
        const n = Math.min(m[1].length + 1, 5)
        saida.push(`<h${n}>${inline(m[2])}</h${n}>`)
      } else if ((m = linha.match(/^\s*[-*]\s+(.*)$/)) || (m = linha.match(/^\s*\d+[.)]\s+(.*)$/))) {
        fecharParagrafo()
        const tipo = /^\s*\d/.test(linha) ? 'ol' : 'ul'
        if (lista !== tipo) {
          fecharLista()
          saida.push(`<${tipo}>`)
          lista = tipo
        }
        saida.push(`<li>${inline(m[1])}</li>`)
      } else {
        fecharLista()
        paragrafo.push(linha.trim())
      }
    }
    fecharParagrafo()
    fecharLista()
    return saida.join('\n')
  }

  raiz.Markdown = { markdown, esc, inline }
  if (typeof module !== 'undefined') module.exports = raiz.Markdown
})(typeof globalThis !== 'undefined' ? globalThis : this)
