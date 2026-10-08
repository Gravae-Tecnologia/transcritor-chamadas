// Copiloto de vendas: acompanha a conversa ao vivo contra um roteiro, em duas
// camadas, como o copiloto do G4:
// - o Jev (TypeSafe, pela OpenRouter) lê a conversa a cada poucas falas e decide
//   o que é fechado: quais etapas do roteiro já foram feitas, qual objeção o
//   cliente levantou e quais alertas dispararam (~US$ 0,0001 por leitura);
// - o LLM só escreve: a próxima frase sugerida (uma por vez) e o resumo do fim.
// A resposta a cada objeção vem pronta do roteiro, sem LLM.
//
// Sem chrome.* nem DOM: o service worker dá as falas e guarda o estado; os
// testes rodam no Node com um `post` de mentira.
(function (raiz) {
  const URL_JEV = 'https://openrouter.ai/api/v1/systemone'
  const URL_CHAT = 'https://openrouter.ai/api/v1/chat/completions'
  const NIVEIS = ['Não abordada', 'Começou, mas incompleta', 'Coberta']
  const MODELOS = { jev: 'typesafe/jev-1.13', sugestao: 'anthropic/claude-haiku-4.5', resumo: 'anthropic/claude-sonnet-5.5' }
  const DEBOUNCE_MS = 2500 // espera a fala assentar antes de ler
  const INTERVALO_JEV_MS = 6000 // no máximo uma leitura do Jev a cada 6 s
  const INTERVALO_SUGESTAO_MS = 40000
  const JANELA = 6000 // caracteres da conversa que o Jev lê

  async function postar(url, corpo, chave, timeoutMs = 40000) {
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const corte = new AbortController()
      const relogio = setTimeout(() => corte.abort(), timeoutMs)
      let r
      try {
        r = await fetch(url, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + chave, 'Content-Type': 'application/json', 'X-Title': 'Transcritor de Chamadas' },
          body: JSON.stringify(corpo),
          signal: corte.signal
        })
      } finally {
        clearTimeout(relogio)
      }
      if (r.ok) return r.json()
      if ([429, 502, 503, 529].includes(r.status) && tentativa < 2) {
        await new Promise((ok) => setTimeout(ok, 1500 * (tentativa + 1)))
        continue
      }
      throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
    }
    throw new Error('sem resposta')
  }

  // As falas da extensão ({nome, eu, texto, hora}) viram turnos: falas seguidas
  // da mesma pessoa, com menos de 30 s entre elas, numa linha só.
  function turnos(falas, inicio) {
    const t0 = new Date(inicio).getTime()
    const lista = []
    for (const f of falas) {
      if (!f || !f.texto) continue
      const t = Math.max(0, (new Date(f.hora).getTime() - t0) / 1000) || 0
      const papel = f.eu ? 'vendedor' : 'cliente'
      const ultimo = lista[lista.length - 1]
      if (ultimo && ultimo.quem === f.nome && t - ultimo.fim < 30) {
        ultimo.texto += ' ' + f.texto
        ultimo.fim = t
      } else lista.push({ t, fim: t, papel, quem: f.nome, texto: f.texto })
    }
    return lista
  }

  class Copiloto {
    // `guardado` é o que `paraGuardar()` devolveu antes (o service worker pode
    // ter dormido no meio da call).
    constructor(roteiro, { chave = '', modelos = {}, post = null } = {}, guardado = {}) {
      this.roteiro = roteiro
      this.chave = chave
      this.modelos = { ...MODELOS, ...modelos }
      this.post = post || ((url, corpo, timeout) => postar(url, corpo, this.chave, timeout))
      const g = guardado || {}
      this.ativo = Boolean(g.ativo)
      this.status = { ...Object.fromEntries(roteiro.etapas.map((e) => [e.id, 0])), ...(g.status || {}) }
      this.objecao = g.objecao || null
      this.objecoesVistas = g.objecoesVistas || []
      this.alertas = g.alertas || {}
      this.sugestao = g.sugestao || null
      this.resumo = g.resumo || null
      this.custo = g.custo || 0
      this.leituras = g.leituras || 0
      this.erro = null
      this.falas = []
      this.inicio = g.inicio || null
      this._assinatura = ''
      this._versao = 0
      this._versaoLida = -1
      this._ultimaMudanca = 0
      this._ultimaLeitura = 0
      this._ultimaSugestao = 0
      this._pedirSugestao = false
      this._rodando = false
    }

    // ---------- entrada ----------

    atualizar(falas, inicio) {
      if (inicio) this.inicio = inicio
      this.falas = turnos(falas, this.inicio)
      const ultimo = this.falas[this.falas.length - 1]
      const total = this.falas.reduce((n, f) => n + f.texto.length, 0)
      const assinatura = `${this.falas.length}:${total}:${ultimo ? ultimo.texto.slice(-40) : ''}`
      if (assinatura !== this._assinatura) {
        this._assinatura = assinatura
        this._versao++
        this._ultimaMudanca = Date.now()
      }
    }

    ligar(ligado = true) {
      this.ativo = ligado
      if (ligado) {
        // Lê a conversa acumulada na hora, em vez de esperar a próxima fala.
        this._versaoLida = -1
        this._ultimaLeitura = 0
        this._ultimaMudanca = 0
        this._pedirSugestao = true
      }
    }

    pedirSugestao() {
      this._pedirSugestao = true
    }

    duracao() {
      if (!this.inicio) return 0
      return Math.max(0, (Date.now() - new Date(this.inicio).getTime()) / 1000)
    }

    // ---------- o laço (o service worker chama a cada segundo) ----------

    // Devolve true se o estado mudou (para guardar e redesenhar).
    async passo(agora = Date.now()) {
      if (!this.ativo || this._rodando) return false
      if (!this.chave) {
        const mudou = this.erro !== 'sem chave'
        this.erro = 'sem chave'
        return mudou
      }
      this._rodando = true
      let mudou = false
      try {
        const novas = this._versao !== this._versaoLida
        if (novas && agora - this._ultimaMudanca > DEBOUNCE_MS && agora - this._ultimaLeitura > INTERVALO_JEV_MS) {
          const marcou = await this.lerComJev()
          mudou = true
          if (marcou || agora - this._ultimaSugestao > INTERVALO_SUGESTAO_MS) await this.sugerir()
        }
        if (this._pedirSugestao) {
          this._pedirSugestao = false
          await this.sugerir()
          mudou = true
        }
        if (this.erro) mudou = true
        this.erro = null
      } catch (e) {
        this.erro = String(e.message || e).slice(0, 200)
        mudou = true
      } finally {
        this._rodando = false
      }
      return mudou
    }

    // ---------- Jev ----------

    conversa(limite = JANELA) {
      const linhas = []
      let total = 0
      for (let i = this.falas.length - 1; i >= 0; i--) {
        const f = this.falas[i]
        const linha = `${f.papel === 'vendedor' ? 'Vendedor' : 'Cliente'}: ${f.texto}`
        total += linha.length
        if (total > limite) break
        linhas.unshift(linha)
      }
      return linhas
    }

    perguntas() {
      const q = {}
      for (const e of this.roteiro.etapas) {
        q['etapa_' + e.id] = {
          type: 'score',
          instructions: `Nesta call de vendas, a etapa "${e.nome}" já foi feita? Objetivo da etapa: ${e.objetivo} Conta como coberta quando: ${e.coberto_quando}`,
          criteria: NIVEIS
        }
      }
      q.objecao = {
        type: 'choice',
        instructions:
          'Nas últimas falas do CLIENTE (as do fim da conversa), ele levantou uma objeção, ou seja, uma RESISTÊNCIA a comprar? ' +
          'Motivação e contexto não são objeção: "o clube do lado já tem replay" ou "os alunos pedem vídeo" são motivos para comprar.',
        criteria: {
          nenhuma: 'Nenhuma resistência à compra nas últimas falas do cliente',
          ...Object.fromEntries(this.roteiro.objecoes.map((o) => [o.id, `${o.nome}: ${o.sinais}`]))
        }
      }
      for (const a of this.roteiro.alertas) {
        q['alerta_' + a.id] = { type: 'noul', instructions: a.pergunta_jev + ' Considere só o fim da conversa.' }
      }
      return q
    }

    async lerComJev() {
      const conversa = this.conversa()
      this._versaoLida = this._versao
      this._ultimaLeitura = Date.now()
      if (!conversa.length) return false
      const r = await this.post(URL_JEV, { model: this.modelos.jev, state: { conversa }, questions: this.perguntas() })
      this.leituras++
      this.custo += Number((r.usage || {}).cost || 0)
      const respostas = r.answers || {}
      const agora = this.duracao()
      let mudou = false
      for (const e of this.roteiro.etapas) {
        const nivel = Math.round(Number((respostas['etapa_' + e.id] || {}).score || 0))
        // Só sobe: uma etapa feita não "desfaz" porque a conversa andou.
        if (nivel > this.status[e.id]) {
          this.status[e.id] = Math.min(nivel, 2)
          mudou = true
        }
      }
      const obj = respostas.objecao || {}
      if (obj.choice && obj.choice !== 'nenhuma' && (obj.confidence || 0) >= 0.7) {
        const o = this.roteiro.objecoes.find((x) => x.id === obj.choice)
        if (o && (!this.objecao || this.objecao.id !== o.id)) {
          this.objecao = { ...o, t: agora }
          this.objecoesVistas.push(o.id)
          mudou = true
        }
      } else if (this.objecao && agora - this.objecao.t > 120) {
        this.objecao = null
      }
      for (const a of this.roteiro.alertas) {
        const p = Number((respostas['alerta_' + a.id] || {}).noul || 0)
        if (p >= 0.7 && !this.alertas[a.id]) {
          this.alertas[a.id] = { texto: a.texto, t: agora }
          mudou = true
        } else if (p < 0.3 && this.alertas[a.id] && agora - this.alertas[a.id].t > 30) {
          delete this.alertas[a.id]
        }
      }
      return mudou
    }

    // ---------- LLM ----------

    roteiroCompacto() {
      return this.roteiro.etapas
        .map((e) => `- [${NIVEIS[this.status[e.id]]}] ${e.id} — ${e.nome}: ${e.objetivo} Perguntas-modelo: ${e.perguntas.join(' / ')} Dica: ${e.dica}`)
        .join('\n')
    }

    async sugerir() {
      const conversa = this.conversa(4000)
      if (!conversa.length) return
      this._ultimaSugestao = Date.now()
      const objecao = this.objecao ? `\nObjeção aberta agora: ${this.objecao.nome}. Resposta do roteiro: ${this.objecao.resposta}` : ''
      const alertas = Object.values(this.alertas).map((a) => `\nAlerta: ${a.texto}`).join('')
      const prompt =
        `Você é o copiloto de um vendedor numa call ao vivo. ${this.roteiro.objetivo_da_call}\n\n` +
        `Roteiro, com o que já foi feito entre colchetes:\n${this.roteiroCompacto()}${objecao}${alertas}\n\n` +
        'Conversa até agora (a última linha é a mais recente):\n' + conversa.join('\n') + '\n\n' +
        'Diga a ÚNICA próxima coisa que o vendedor deve falar agora. Regras: responda ao que o cliente acabou ' +
        'de dizer antes de puxar outro assunto; se há objeção aberta, trate-a com a resposta do roteiro; senão, ' +
        'avance para a primeira etapa ainda não coberta que faça sentido agora; nunca repita pergunta já feita ' +
        'nem peça dado que o cliente já deu; nunca invente valor em reais, desconto ou condição (o número vem da ' +
        'proposta e da tabela); frase falada, natural, em português do Brasil, com no máximo 25 ' +
        'palavras. Responda só com JSON: {"etapa": "<id da etapa>", "frase": "...", "porque": "<até 10 palavras>"}'
      const r = await this.post(URL_CHAT, {
        model: this.modelos.sugestao,
        max_tokens: 200,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }]
      })
      this.custo += Number((r.usage || {}).cost || 0)
      const texto = r.choices[0].message.content || ''
      let dados
      try {
        dados = JSON.parse((texto.match(/\{[\s\S]*\}/) || [''])[0])
      } catch {
        dados = { frase: texto.trim().slice(0, 200) }
      }
      this.sugestao = { frase: dados.frase || '', etapa: dados.etapa || null, porque: dados.porque || '', t: this.duracao() }
    }

    // ---------- fim da call ----------

    falaPorPapel() {
      const palavras = { vendedor: 0, cliente: 0 }
      for (const f of this.falas) palavras[f.papel] += f.texto.split(/\s+/).filter(Boolean).length
      const total = palavras.vendedor + palavras.cliente || 1
      return { vendedor: Math.round((100 * palavras.vendedor) / total), cliente: Math.round((100 * palavras.cliente) / total) }
    }

    // Resumo do fim da call, em Markdown.
    async resumir(titulo) {
      if (!this.chave) throw new Error('sem chave')
      if (!this.falas.length) return null
      const fala = this.falaPorPapel()
      const aoVivo = this.leituras
        ? '\nEtapas marcadas ao vivo:\n' + this.roteiro.etapas.map((e) => `- ${e.nome}: ${NIVEIS[this.status[e.id]]}`).join('\n') + '\n'
        : ''
      const prompt =
        'Você analisa uma call de vendas da Gravaê (sistema de replays, transmissão e receita para arenas ' +
        'esportivas). Escreva em português do Brasil, em Markdown, curto e concreto, com estas seções:\n' +
        '## Resumo (3 a 5 linhas: quem é o cliente, a arena, o que ele quer)\n' +
        '## Dados da arena (cidade, esportes, quadras, sistema atual, torneios — só o que foi dito)\n' +
        '## Dor e objetivo\n## Objeções e como foram tratadas\n' +
        '## Promessas arriscadas (o que o vendedor prometeu que pode virar arrependimento; "nenhuma" se não houve)\n' +
        '## Próximos passos (quem faz o quê e quando)\n' +
        '## Roteiro (para cada etapa, feita ou não, e o que faltou)\n' +
        '## Para a próxima call (2 ou 3 conselhos ao vendedor, baseados no roteiro)\n\n' +
        `Roteiro da call:\n${this.roteiroCompacto()}\n${aoVivo}` +
        `Fala: vendedor ${fala.vendedor}%, cliente ${fala.cliente}% (por palavras).\n\n` +
        'Transcrição (Vendedor = quem usa o sistema; Cliente = as outras vozes; as legendas automáticas ' +
        'erram palavras, interprete pelo sentido):\n' + this.conversa(60000).join('\n')
      const r = await this.post(
        URL_CHAT,
        { model: this.modelos.resumo, max_tokens: 4000, temperature: 0.2, messages: [{ role: 'user', content: prompt }] },
        120000
      )
      this.custo += Number((r.usage || {}).cost || 0)
      const feitas = Object.values(this.status).filter((v) => v === 2).length
      const d = new Date(this.inicio || Date.now())
      const p = (n) => String(n).padStart(2, '0')
      const quando = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
      this.resumo =
        `# Copiloto — ${titulo}\n\n` +
        `${quando} · roteiro ${this.roteiro.nome} · ${feitas}/${this.roteiro.etapas.length} etapas cobertas · ` +
        `fala: vendedor ${fala.vendedor}%, cliente ${fala.cliente}% · custo da IA: US$ ${this.custo.toFixed(4)}\n\n` +
        r.choices[0].message.content.trim() + '\n'
      return this.resumo
    }

    // ---------- estado ----------

    paraGuardar() {
      const { ativo, status, objecao, objecoesVistas, alertas, sugestao, resumo, custo, leituras, inicio } = this
      return { ativo, status, objecao, objecoesVistas, alertas, sugestao, resumo, custo, leituras, inicio }
    }

    // O que o painel lateral e a agenda mostram.
    estado() {
      return {
        ...this.paraGuardar(),
        roteiro: this.roteiro.nome,
        etapas: this.roteiro.etapas.map((e) => ({ id: e.id, nome: e.nome, status: this.status[e.id], objetivo: e.objetivo, perguntas: e.perguntas, dica: e.dica })),
        alertas: Object.values(this.alertas),
        fala: this.falaPorPapel(),
        falas: this.falas.slice(-40).map(({ t, papel, quem, texto }) => ({ t, papel, quem, texto })),
        erro: this.erro
      }
    }
  }

  const Copilotagem = { Copiloto, turnos, postar, NIVEIS, MODELOS }
  raiz.Copilotagem = Copilotagem
  if (typeof module !== 'undefined') module.exports = Copilotagem
})(typeof globalThis !== 'undefined' ? globalThis : this)
