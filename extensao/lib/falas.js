// Guarda as falas de uma chamada a partir dos blocos de legenda.
//
// Cada bloco de legenda na tela é uma fala de uma pessoa, e o texto dele vai
// mudando enquanto ela fala (e o Meet ainda corrige palavras já escritas).
// Aqui cada bloco vira uma fala só, atualizada no lugar, em vez de uma fala
// nova a cada mudança. Sem dependência do DOM, para rodar nos testes com Node.
(function (raiz) {
  // Quando a mesma pessoa fala por muito tempo, o Meet descarta o começo do
  // bloco e o texto encolhe de uma vez. Aí o que já foi dito fica guardado e
  // o resto do bloco vira uma fala nova.
  const QUEDA_QUE_REINICIA = 250

  function limpar(texto) {
    return (texto || '').replace(/\s+/g, ' ').trim()
  }

  class Transcricao {
    constructor(falas = []) {
      this.falas = falas
      this.ativas = new Map() // bloco -> fala
      this.pendentes = [] // falas de antes da retomada que ainda podem estar na tela
    }

    // Retomando uma transcrição (a aba recarregou, a extensão foi atualizada):
    // as legendas que ainda estão na tela já foram guardadas. Enquanto durar a
    // retomada, um bloco novo que bate com uma das últimas falas continua
    // aquela fala em vez de repetir.
    retomar(quantas = 10) {
      this.pendentes = this.falas.slice(-quantas)
    }

    fimDaRetomada() {
      this.pendentes = []
    }

    adotar(bloco, nome, texto) {
      const i = this.pendentes.findIndex(
        (f) => (!nome || f.nome === nome) && (texto.startsWith(f.texto) || f.texto.startsWith(texto))
      )
      if (i < 0) return null
      const fala = this.pendentes.splice(i, 1)[0]
      this.ativas.set(bloco, fala)
      return fala
    }

    // Recebe o estado atual de um bloco. Devolve true se alguma fala mudou.
    atualizar(bloco, nome, texto, agora = new Date()) {
      nome = limpar(nome)
      texto = limpar(texto)
      if (!texto) return false

      let atual = this.ativas.get(bloco)
      if (!atual && this.pendentes.length) {
        atual = this.adotar(bloco, nome, texto)
        if (atual && atual.texto.length >= texto.length) return false
      }
      if (atual && atual.texto === texto && (!nome || atual.nome === nome)) return false

      if (!atual || texto.length < atual.texto.length - QUEDA_QUE_REINICIA) {
        const fala = { nome: nome || (atual && atual.nome) || '?', texto, hora: agora.toISOString() }
        this.falas.push(fala)
        this.ativas.set(bloco, fala)
        return true
      }

      atual.texto = texto
      if (nome) atual.nome = nome
      return true
    }

    // O bloco saiu da tela: a fala fica como está.
    esquecer(bloco) {
      this.ativas.delete(bloco)
    }

    blocos() {
      return [...this.ativas.keys()]
    }
  }

  raiz.Transcricao = Transcricao
  raiz.limparTexto = limpar
  if (typeof module !== 'undefined') module.exports = { Transcricao, limparTexto: limpar }
})(typeof globalThis !== 'undefined' ? globalThis : this)
