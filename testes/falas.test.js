// Testes da lógica que não depende do navegador. Uso: node --test testes/
const test = require('node:test')
const assert = require('node:assert')
const { Transcricao } = require('../extensao/lib/falas.js')
const Formato = require('../extensao/lib/formato.js')

const t0 = new Date('2026-09-29T12:00:00Z')

test('o mesmo bloco crescendo vira uma fala só', () => {
  const t = new Transcricao()
  const bloco = {}
  t.atualizar(bloco, 'Ana', 'Bom', t0)
  t.atualizar(bloco, 'Ana', 'Bom dia', t0)
  t.atualizar(bloco, 'Ana', 'Bom dia a todos', t0)
  assert.deepStrictEqual(t.falas.map((f) => f.texto), ['Bom dia a todos'])
})

test('correção de palavra num bloco antigo atualiza a fala dele', () => {
  const t = new Transcricao()
  const a = {}, b = {}
  t.atualizar(a, 'Ana', 'Vamos falar do contato', t0)
  t.atualizar(b, 'Beto', 'Pode ser', t0)
  t.atualizar(a, 'Ana', 'Vamos falar do contrato', t0)
  assert.deepStrictEqual(t.falas.map((f) => `${f.nome}: ${f.texto}`), ['Ana: Vamos falar do contrato', 'Beto: Pode ser'])
})

test('texto repetido não conta como mudança', () => {
  const t = new Transcricao()
  const a = {}
  assert.strictEqual(t.atualizar(a, 'Ana', 'Oi', t0), true)
  assert.strictEqual(t.atualizar(a, 'Ana', '  Oi ', t0), false)
  assert.strictEqual(t.atualizar(a, 'Ana', '', t0), false)
})

test('quando o Meet corta o começo de um bloco longo, o dito fica e o resto vira fala nova', () => {
  const t = new Transcricao()
  const a = {}
  const longo = 'palavra '.repeat(60).trim()
  t.atualizar(a, 'Ana', longo, t0)
  t.atualizar(a, 'Ana', 'e aí seguimos', t0)
  t.atualizar(a, 'Ana', 'e aí seguimos com o plano', t0)
  assert.strictEqual(t.falas.length, 2)
  assert.strictEqual(t.falas[0].texto, longo)
  assert.strictEqual(t.falas[1].texto, 'e aí seguimos com o plano')
})

test('bloco esquecido não é mais atualizado', () => {
  const t = new Transcricao()
  const a = {}
  t.atualizar(a, 'Ana', 'Tchau', t0)
  t.esquecer(a)
  t.atualizar(a, 'Ana', 'Tchau', t0)
  assert.strictEqual(t.falas.length, 2)
})

test('markdown agrupa falas seguidas da mesma pessoa e traz o cabeçalho', () => {
  const reuniao = {
    id: 'abc-defg-hij-1',
    codigo: 'abc-defg-hij',
    titulo: 'Reunião "semanal"',
    url: 'https://meet.google.com/abc-defg-hij',
    inicio: '2026-09-29T12:00:00Z',
    fim: '2026-09-29T12:45:00Z',
    participantes: ['Ana', 'Beto'],
    falas: [
      { nome: 'Ana', texto: 'Bom dia.', hora: '2026-09-29T12:01:00Z' },
      { nome: 'Ana', texto: 'Vamos começar.', hora: '2026-09-29T12:01:10Z' },
      { nome: 'Beto', texto: 'Bora.', hora: '2026-09-29T12:02:00Z' }
    ]
  }
  const md = Formato.paraMarkdown(reuniao)
  assert.match(md, /titulo: "Reunião \\"semanal\\""/)
  assert.match(md, /duracao: "45 min"/)
  assert.match(md, /\*\*Ana\*\* · \d\d:\d\d\nBom dia\. Vamos começar\.\n/)
  assert.match(md, /\*\*Beto\*\* · \d\d:\d\d\nBora\./)
  assert.match(Formato.paraTexto(reuniao), /\] Ana: Bom dia\. Vamos começar\.\n\[/)
  assert.match(Formato.nomeArquivo(reuniao, 'md'), /^Transcricoes\/2026-09-29 \d\dh\d\d - Reunião semanal\.md$/)
})

test('retomada: legendas ainda na tela continuam as falas guardadas, sem repetir', () => {
  const guardadas = [
    { nome: 'Ana', texto: 'Bom dia', hora: t0.toISOString() },
    { nome: 'Beto', texto: 'Oi Ana tudo', hora: t0.toISOString() }
  ]
  const t = new Transcricao(guardadas)
  t.retomar()
  const a = {}, b = {}
  assert.strictEqual(t.atualizar(a, 'Ana', 'Bom dia', t0), false)
  t.atualizar(b, 'Beto', 'Oi Ana tudo bem', t0)
  t.fimDaRetomada()
  t.atualizar({}, 'Ana', 'Bom dia', t0) // depois da retomada, repetir é fala nova
  assert.deepStrictEqual(t.falas.map((f) => `${f.nome}: ${f.texto}`), ['Ana: Bom dia', 'Beto: Oi Ana tudo bem', 'Ana: Bom dia'])
})
