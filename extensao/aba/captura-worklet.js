// Recebe o áudio da aba na taxa do AudioContext (48 kHz, em geral), junta os
// canais, reamostra para 16 kHz (interpolação linear) e manda blocos de 0,1 s
// em PCM int16, que é o que o Transcritor do PC espera.
class Captura16k extends AudioWorkletProcessor {
  constructor(opcoes) {
    super()
    this.passo = opcoes.processorOptions.taxa / 16000
    this.pos = 0 // posição da próxima amostra de saída, relativa ao bloco atual
    this.anterior = 0 // última amostra do bloco anterior (índice -1)
    this.saida = new Int16Array(1600)
    this.n = 0
  }

  process(entradas) {
    const canais = entradas[0]
    if (!canais || !canais.length) return true
    const tamanho = canais[0].length
    const mono = new Float32Array(tamanho)
    for (const canal of canais) for (let i = 0; i < tamanho; i++) mono[i] += canal[i] / canais.length

    while (this.pos <= tamanho - 1) {
      const i = Math.floor(this.pos)
      const f = this.pos - i
      const a = i < 0 ? this.anterior : mono[i]
      const b = i + 1 < tamanho ? mono[i + 1] : mono[tamanho - 1]
      const v = Math.max(-1, Math.min(1, a + (b - a) * f))
      this.saida[this.n++] = v * 32767
      if (this.n === this.saida.length) {
        this.port.postMessage(this.saida.buffer, [this.saida.buffer])
        this.saida = new Int16Array(1600)
        this.n = 0
      }
      this.pos += this.passo
    }
    this.pos -= tamanho
    this.anterior = mono[tamanho - 1]
    return true
  }
}

registerProcessor('captura-16k', Captura16k)
