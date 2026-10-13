// Monta o arquivo da transcrição (Markdown ou texto) e o nome dele.
// Usado pelo popup e pelo service worker; sem DOM, para rodar no Node.
(function (raiz) {
  function hora(iso) {
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  }

  function data(iso) {
    const d = new Date(iso)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  function duracao(reuniao) {
    const fim = reuniao.fim || (reuniao.falas.length ? reuniao.falas[reuniao.falas.length - 1].hora : reuniao.inicio)
    const min = Math.max(0, Math.round((new Date(fim) - new Date(reuniao.inicio)) / 60000))
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`
  }

  // Nome que é texto de ícone ("arrow_downward", do botão "Ir para o fim"):
  // entrou por engano em transcrições da 0.2.0 e fica de fora do arquivo.
  const NOME_DE_ICONE = /^[a-z]+(_[a-z]+)+$/

  // Falas seguidas da mesma pessoa ficam debaixo de um nome só.
  function turnos(falas) {
    const lista = []
    for (const fala of falas) {
      if (NOME_DE_ICONE.test(fala.nome)) continue
      const ultimo = lista[lista.length - 1]
      if (ultimo && ultimo.nome === fala.nome) ultimo.textos.push(fala.texto)
      else lista.push({ nome: fala.nome, hora: fala.hora, textos: [fala.texto] })
    }
    return lista
  }

  function aspas(texto) {
    return '"' + String(texto).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  }

  function paraMarkdown(reuniao) {
    const linhas = [
      '---',
      `titulo: ${aspas(reuniao.titulo)}`,
      `data: ${data(reuniao.inicio)}`,
      `inicio: "${hora(reuniao.inicio)}"`,
      `fim: "${reuniao.fim ? hora(reuniao.fim) : ''}"`,
      `duracao: ${aspas(duracao(reuniao))}`,
      `link: ${reuniao.url}`,
      'participantes:',
      ...(reuniao.participantes || []).filter((p) => !NOME_DE_ICONE.test(p)).map((p) => `  - ${aspas(p)}`),
      'fonte: legendas do Google Meet',
      '---',
      '',
      `# ${reuniao.titulo}`,
      ''
    ]
    for (const t of turnos(reuniao.falas)) {
      linhas.push(`**${t.nome}** · ${hora(t.hora)}`, t.textos.join(' '), '')
    }
    return linhas.join('\n')
  }

  function paraTexto(reuniao) {
    const linhas = [
      reuniao.titulo,
      `${data(reuniao.inicio)} ${hora(reuniao.inicio)} · ${duracao(reuniao)} · ${reuniao.url}`,
      ''
    ]
    for (const t of turnos(reuniao.falas)) linhas.push(`[${hora(t.hora)}] ${t.nome}: ${t.textos.join(' ')}`)
    return linhas.join('\n') + '\n'
  }

  function nomeArquivo(reuniao, extensao) {
    const titulo = String(reuniao.titulo).replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
    const h = hora(reuniao.inicio).replace(':', 'h')
    return `Transcricoes/${data(reuniao.inicio)} ${h} - ${titulo || reuniao.codigo}.${extensao}`
  }

  const Formato = { paraMarkdown, paraTexto, nomeArquivo, duracao, hora, data }
  raiz.Formato = Formato
  if (typeof module !== 'undefined') module.exports = Formato
})(typeof globalThis !== 'undefined' ? globalThis : this)
