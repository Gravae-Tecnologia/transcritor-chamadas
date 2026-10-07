// Guarda as falas de uma chamada a partir dos blocos de legenda.
//
// Cada bloco de legenda do Meet é a vez de uma pessoa: o texto cresce enquanto
// ela fala, e o Meet corrige palavras já escritas. O que complica:
// - quando a mesma pessoa fala muito tempo (uma aula), o Meet tira o começo do
//   bloco aos pedaços, como uma janela que corre. Até 06/10 cada corte abria uma
//   fala nova com tudo o que ainda estava na tela, e uma aula de 1h37 saiu com
//   cada trecho repetido de 10 a 31 vezes (1 MB). Agora cada bloco lembra o
//   último texto visto; quando o começo some, as posições andam junto e o que
//   saiu da tela fica guardado na fala;
// - fala longa vira várias, cortadas no fim de uma frase (até ~1.000 caracteres);
// - se o nome em cima do bloco muda, a fala nova começa onde a anterior parou.
// Sem dependência do DOM, para rodar nos testes com Node.
(function (raiz) {
  // O bloco encolheu isso, sem nada em comum com o que estava na tela: recomeçou.
  const QUEDA_QUE_REINICIA = 250
  // Fala mais longa que isso é cortada no fim de uma frase (entre MINIMO e MAXIMO).
  const MAXIMO = 1000
  const MINIMO = 400
  const ANCORA = 30

  function limpar(texto) {
    return (texto || '').replace(/\s+/g, ' ').trim()
  }

  // Onde cortar um trecho longo: no último fim de frase depois de MINIMO; sem
  // frase, no último espaço antes de MAXIMO.
  function pontoDeCorte(trecho) {
    let corte = -1
    const fim = /[.!?…](?=\s)/g
    let m
    while ((m = fim.exec(trecho)) && m.index < MAXIMO) {
      if (m.index >= MINIMO) corte = m.index + 1
    }
    if (corte < 0) corte = trecho.lastIndexOf(' ', MAXIMO)
    return corte > 0 ? corte : MAXIMO
  }

  // Quantos caracteres o Meet tirou do começo do bloco: 0 se o começo é o mesmo,
  // null se o texto novo não se encaixa no anterior. Entre os lugares em que o
  // começo novo aparece no texto anterior, vale o que casa por mais tempo.
  function cortadoNoComeco(anterior, texto) {
    const n = Math.min(ANCORA, anterior.length, texto.length)
    if (texto.slice(0, n) === anterior.slice(0, n)) return 0
    const ancora = texto.slice(0, ANCORA)
    if (ancora.length < 12) return null
    let melhor = null
    let maior = 0
    for (let p = anterior.indexOf(ancora, 1); p >= 0; p = anterior.indexOf(ancora, p + 1)) {
      const limite = Math.min(anterior.length - p, texto.length)
      let c = 0
      while (c < limite && anterior[p + c] === texto[c]) c++
      if (c > maior) {
        maior = c
        melhor = p
      }
    }
    return melhor
  }

  class Transcricao {
    constructor(falas = []) {
      this.falas = falas
      // bloco -> { fala, inicio, fixo, visto, fim }
      //   inicio: onde a fala começa no texto do bloco
      //   fixo:   começo da fala que o Meet já tirou da tela
      //   visto:  o último texto do bloco
      //   fim:    até onde do bloco a fala já foi (para quando o nome muda)
      this.ativas = new Map()
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
      for (let i = this.pendentes.length - 1; i >= 0; i--) {
        const f = this.pendentes[i]
        if (nome && f.nome !== nome) continue
        let fixo = null
        if (texto.startsWith(f.texto) || f.texto.startsWith(texto)) fixo = ''
        else if (texto.length >= 12) {
          // A tela mostra só o fim da fala (o começo já tinha saído).
          const p = f.texto.lastIndexOf(texto.slice(0, ANCORA))
          if (p > 0) fixo = f.texto.slice(0, p)
        }
        if (fixo === null) continue
        this.pendentes.splice(i, 1)
        this.ativas.set(bloco, { fala: f, inicio: 0, fixo, visto: texto, fim: texto.length })
        return f
      }
      return null
    }

    _nova(bloco, nome, texto, inicio, agora, fixo = '') {
      const fala = { nome: nome || '?', texto: limpar(fixo + texto.slice(inicio)), hora: agora.toISOString() }
      this.falas.push(fala)
      this.ativas.set(bloco, { fala, inicio, fixo, visto: texto, fim: texto.length })
      return fala
    }

    // Recebe o estado atual de um bloco. Devolve true se alguma fala mudou.
    atualizar(bloco, nome, texto, agora = new Date()) {
      nome = limpar(nome)
      texto = limpar(texto)
      if (!texto) return false

      let estado = this.ativas.get(bloco)
      if (!estado && this.pendentes.length) {
        const adotada = this.adotar(bloco, nome, texto)
        if (adotada) {
          estado = this.ativas.get(bloco)
          const junto = limpar(estado.fixo + texto)
          if (junto.length <= adotada.texto.length) return false
        }
      }
      if (!estado) {
        this._nova(bloco, nome, texto, 0, agora)
        return true
      }

      const corte = cortadoNoComeco(estado.visto, texto)
      if (corte > 0) {
        // O Meet tirou o começo do bloco: as posições andam junto, e o que saiu
        // da tela e era desta fala fica guardado nela.
        if (estado.inicio >= corte) estado.inicio -= corte
        else {
          estado.fixo += estado.visto.slice(estado.inicio, corte)
          estado.inicio = 0
        }
        estado.fim = Math.max(0, estado.fim - corte)
      } else if (corte === null && texto.length < estado.visto.length - QUEDA_QUE_REINICIA) {
        // Encolheu sem nada em comum com o que estava na tela: o bloco recomeçou.
        this._nova(bloco, nome || estado.fala.nome, texto, 0, agora)
        return true
      }
      estado.visto = texto

      const { fala } = estado
      // Mudou quem fala dentro do mesmo bloco: a fala anterior fica com o que
      // tinha, e a nova começa onde ela parou.
      if (nome && fala.nome !== '?' && nome !== fala.nome) {
        const fim = Math.min(estado.fim, texto.length)
        if (limpar(texto.slice(fim))) {
          this._nova(bloco, nome, texto, fim, agora)
          return true
        }
        return false
      }

      const cheio = estado.fixo + texto.slice(estado.inicio)
      let trecho = limpar(cheio)
      // Fala longa demais: corta no fim de uma frase e continua numa fala nova.
      if (trecho.length > MAXIMO) {
        const ponto = pontoDeCorte(cheio)
        fala.texto = limpar(cheio.slice(0, ponto))
        if (nome && fala.nome === '?') fala.nome = nome
        if (ponto < estado.fixo.length) this._nova(bloco, nome || fala.nome, texto, estado.inicio, agora, estado.fixo.slice(ponto))
        else this._nova(bloco, nome || fala.nome, texto, estado.inicio + ponto - estado.fixo.length, agora)
        // O resto ainda pode passar do limite.
        this.atualizar(bloco, nome, texto, agora)
        return true
      }

      estado.fim = texto.length
      if (fala.texto === trecho && (!nome || fala.nome === nome)) return false
      fala.texto = trecho
      if (nome) fala.nome = nome
      return true
    }

    // O bloco saiu da tela: a fala fica como está.
    esquecer(bloco) {
      this.ativas.delete(bloco)
    }

    blocos() {
      return [...this.ativas.keys()]
    }

    falaDoBloco(bloco) {
      const estado = this.ativas.get(bloco)
      return estado ? estado.fala : null
    }
  }

  raiz.Transcricao = Transcricao
  raiz.limparTexto = limpar
  if (typeof module !== 'undefined') module.exports = { Transcricao, limparTexto: limpar }
})(typeof globalThis !== 'undefined' ? globalThis : this)
