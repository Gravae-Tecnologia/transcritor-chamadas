// Documento invisível (offscreen) que segura a captura de áudio das abas: o
// service worker não pode usar getUserMedia nem AudioContext.
//
// Para cada aba: pega o stream da aba, continua tocando o som (senão a aba
// fica muda), reamostra para 16 kHz no worklet e manda ao Transcritor do PC
// por WebSocket (ws://127.0.0.1:8766, ver desktop/servidor.py). As linhas que
// voltam vão para o service worker, que guarda para o popup.
const ENDERECO = 'ws://127.0.0.1:8766'
const capturas = new Map() // aba -> { ws, stream, ctx }

function avisar(aba, dado) {
  chrome.runtime.sendMessage({ tipo: 'aba-evento', aba, dado }).catch(() => {})
}

function conectar() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ENDERECO)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('O Transcritor do PC não está aberto (nada respondendo em 127.0.0.1:8766).'))
  })
}

async function capturar({ aba, streamId, titulo, url, microfone }) {
  if (capturas.has(aba)) return { ja: true }
  const ws = await conectar()
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false
    })
  } catch (erro) {
    ws.close()
    throw erro
  }
  const ctx = new AudioContext()
  const fonte = ctx.createMediaStreamSource(stream)
  fonte.connect(ctx.destination) // a aba continua com som
  await ctx.audioWorklet.addModule('captura-worklet.js')
  const no = new AudioWorkletNode(ctx, 'captura-16k', { processorOptions: { taxa: ctx.sampleRate } })
  no.port.onmessage = (e) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(e.data)
  }
  fonte.connect(no)

  capturas.set(aba, { ws, stream, ctx })
  ws.onmessage = (e) => {
    const dado = JSON.parse(e.data)
    avisar(aba, dado)
    if (dado.tipo === 'salvo') ws.close()
  }
  ws.onclose = () => {
    liberar(aba)
    avisar(aba, { tipo: 'fechado' })
  }
  stream.getAudioTracks()[0].addEventListener('ended', () => parar(aba))
  ws.send(JSON.stringify({ tipo: 'inicio', titulo, url, microfone }))
  return { ok: true }
}

// Para de mandar áudio e pede ao PC para fechar o arquivo; a conexão só fecha
// quando ele responde "salvo".
function parar(aba) {
  const c = capturas.get(aba)
  if (!c) return
  c.stream.getTracks().forEach((t) => t.stop())
  c.ctx.close().catch(() => {})
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ tipo: 'fim' }))
  else liberar(aba)
}

function liberar(aba) {
  const c = capturas.get(aba)
  if (!c) return
  c.stream.getTracks().forEach((t) => t.stop())
  c.ctx.close().catch(() => {})
  capturas.delete(aba)
}

chrome.runtime.onMessage.addListener((mensagem, _remetente, responder) => {
  if (mensagem.alvo !== 'offscreen') return
  if (mensagem.tipo === 'capturar') {
    capturar(mensagem)
      .then(responder)
      .catch((erro) => responder({ erro: String(erro.message || erro) }))
    return true
  }
  if (mensagem.tipo === 'parar') {
    parar(mensagem.aba)
    responder({ ok: true })
  }
})
