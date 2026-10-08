// O copiloto da extensão, com uma OpenRouter de mentira. Uso: node --test testes/
const test = require('node:test')
const assert = require('node:assert')
const { Copiloto, turnos } = require('../extensao/lib/copiloto.js')

const roteiro = {
  nome: 'Roteiro de teste',
  objetivo_da_call: 'Sair com a proposta enviada.',
  etapas: [
    { id: 'abertura', nome: 'Abertura', objetivo: 'Saber o motivo.', coberto_quando: 'o motivo foi dito', perguntas: ['O que te trouxe?'], dica: 'Ouça.' },
    { id: 'arena', nome: 'A arena', objetivo: 'Cidade e quadras.', coberto_quando: 'cidade e quadras ditas', perguntas: ['Onde fica?'], dica: 'Anote.' }
  ],
  objecoes: [{ id: 'preco', nome: 'Está caro', sinais: 'achou caro', resposta: 'Pergunte o que pesou.', evitar: 'Baixar preço.' }],
  alertas: [{ id: 'sinal_compra', texto: 'Sinal de compra: pergunte PJ ou PF.', pergunta_jev: 'O cliente deu sinal de compra?' }]
}
const inicio = '2026-10-07T17:00:00.000Z'
const hora = (s) => new Date(Date.parse(inicio) + s * 1000).toISOString()
const falas = [
  { nome: 'João', eu: true, texto: 'Oi Carlos, o que te trouxe ao Gravaê?', hora: hora(5) },
  { nome: 'Carlos', eu: false, texto: 'Os alunos pedem vídeo dos pontos.', hora: hora(9) },
  { nome: 'Carlos', eu: false, texto: 'Mas achei caro o kit.', hora: hora(14) }
]

function openrouterFalsa() {
  const pedidos = []
  const post = async (url, corpo) => {
    pedidos.push({ url, corpo })
    if (url.endsWith('/systemone')) {
      return {
        usage: { cost: 0.0001 },
        answers: {
          etapa_abertura: { score: 2 },
          etapa_arena: { score: 0 },
          objecao: { choice: 'preco', confidence: 0.9 },
          alerta_sinal_compra: { noul: 0.1 }
        }
      }
    }
    const resumo = corpo.max_tokens > 1000
    return {
      usage: { cost: resumo ? 0.03 : 0.001 },
      choices: [{ message: { content: resumo ? '## Resumo\nCarlos quer vídeo.' : '{"etapa":"arena","frase":"O que pesou mais, o kit ou a mensalidade?","porque":"objeção de preço"}' } }]
    }
  }
  return { post, pedidos }
}

test('turnos: falas seguidas da mesma pessoa viram uma linha, com papel', () => {
  const t = turnos(falas, inicio)
  assert.strictEqual(t.length, 2)
  assert.deepStrictEqual(t.map((x) => [x.papel, x.quem, Math.round(x.t)]), [['vendedor', 'João', 5], ['cliente', 'Carlos', 9]])
  assert.strictEqual(t[1].texto, 'Os alunos pedem vídeo dos pontos. Mas achei caro o kit.')
})

test('desligado: não chama a OpenRouter', async () => {
  const { post, pedidos } = openrouterFalsa()
  const c = new Copiloto(roteiro, { chave: 'x', post })
  c.atualizar(falas, inicio)
  assert.strictEqual(await c.passo(Date.now() + 10000), false)
  assert.strictEqual(pedidos.length, 0)
})

test('ligado: Jev marca a etapa e a objeção, e o LLM sugere a frase', async () => {
  const { post, pedidos } = openrouterFalsa()
  const c = new Copiloto(roteiro, { chave: 'x', post })
  c.atualizar(falas, inicio)
  c.ligar()
  assert.strictEqual(await c.passo(Date.now() + 10000), true)
  assert.strictEqual(c.status.abertura, 2)
  assert.strictEqual(c.objecao.id, 'preco')
  assert.match(c.sugestao.frase, /kit ou a mensalidade/)
  assert.strictEqual(pedidos[0].corpo.model, 'typesafe/jev-1.13')
  assert.deepStrictEqual(pedidos[0].corpo.state.conversa, ['Vendedor: Oi Carlos, o que te trouxe ao Gravaê?', 'Cliente: Os alunos pedem vídeo dos pontos. Mas achei caro o kit.'])
  // Sem fala nova, não lê de novo.
  const antes = pedidos.length
  await c.passo(Date.now() + 20000)
  assert.strictEqual(pedidos.length, antes)
})

test('sem chave: avisa em vez de chamar', async () => {
  const c = new Copiloto(roteiro, {})
  c.atualizar(falas, inicio)
  c.ligar()
  await c.passo(Date.now() + 10000)
  assert.strictEqual(c.erro, 'sem chave')
})

test('resumo do fim e estado guardado que volta igual', async () => {
  const { post } = openrouterFalsa()
  const c = new Copiloto(roteiro, { chave: 'x', post })
  c.atualizar(falas, inicio)
  c.ligar()
  await c.passo(Date.now() + 10000)
  const md = await c.resumir('Call com o Carlos')
  assert.match(md, /^# Copiloto — Call com o Carlos/)
  assert.match(md, /1\/2 etapas cobertas · fala: vendedor \d+%, cliente \d+% · custo da IA: US\$ 0\.03\d+/)
  const volta = new Copiloto(roteiro, { chave: 'x', post }, JSON.parse(JSON.stringify(c.paraGuardar())))
  assert.deepStrictEqual(volta.paraGuardar(), c.paraGuardar())
})
