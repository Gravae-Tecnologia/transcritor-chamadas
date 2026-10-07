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

test('bloco que não para de crescer: muda o nome em cima, abre fala nova a partir dali', () => {
  const t = new Transcricao()
  const b = {}
  t.atualizar(b, 'Ana', 'Bom dia pessoal', t0)
  t.atualizar(b, 'Ana', 'Bom dia pessoal, vamos começar.', t0)
  t.atualizar(b, 'Beto', 'Bom dia pessoal, vamos começar. Pode ir', t0)
  t.atualizar(b, 'Beto', 'Bom dia pessoal, vamos começar. Pode ir, Ana.', t0)
  t.atualizar(b, 'Ana', 'Bom dia pessoal, vamos começar. Pode ir, Ana. Obrigada', t0)
  assert.deepStrictEqual(t.falas.map((f) => `${f.nome}: ${f.texto}`),
    ['Ana: Bom dia pessoal, vamos começar.', 'Beto: Pode ir, Ana.', 'Ana: Obrigada'])
})

test('fala longa demais é cortada no fim de uma frase, sem perder texto', () => {
  const t = new Transcricao()
  const b = {}
  const frase = 'Esta é uma frase de teste com umas palavras a mais. '
  let texto = ''
  for (let i = 0; i < 60; i++) {
    texto += frase
    t.atualizar(b, 'Ana', texto, t0)
  }
  assert.ok(t.falas.length >= 3, 'virou várias falas')
  assert.ok(t.falas.every((f) => f.texto.length <= 1000), 'nenhuma passa de 1000')
  assert.ok(t.falas.slice(0, -1).every((f) => f.texto.endsWith('.')), 'cortes no fim de frase')
  assert.strictEqual(t.falas.map((f) => f.texto).join(' '), texto.trim())
})

test('correção no fim do bloco continua valendo na fala atual', () => {
  const t = new Transcricao()
  const b = {}
  t.atualizar(b, 'Ana', 'Vamos ver o contato', t0)
  t.atualizar(b, 'Beto', 'Vamos ver o contato. Tá bom', t0)
  t.atualizar(b, 'Beto', 'Vamos ver o contrato. Tá bom', t0) // o Meet corrigiu antes do corte
  t.atualizar(b, 'Beto', 'Vamos ver o contrato. Tá bom, combinado', t0)
  assert.strictEqual(t.falas[1].nome, 'Beto')
  assert.match(t.falas[1].texto, /Tá bom, combinado$/)
})

// A aula de 06/10: uma pessoa falando sem parar, e o Meet tirando o começo do
// bloco aos pedaços. Antes, cada pedaço tirado repetia a janela inteira.
function aula(t, bloco, nome, frases, janela = 2500, tira = 700) {
  let tela = ''
  for (const frase of frases) {
    for (const palavra of frase.split(' ')) {
      tela = (tela + ' ' + palavra).trim()
      if (tela.length > janela) tela = tela.slice(tela.indexOf(' ', tira) + 1)
      t.atualizar(bloco, nome, tela, t0)
    }
  }
}

test('bloco que corre como janela (aula longa): nada repete, nada se perde', () => {
  const t = new Transcricao()
  const frases = Array.from({ length: 300 }, (_, i) => `Esta é a frase número ${i} da aula sobre produtores e fazendas.`)
  aula(t, {}, 'Rita', frases)
  const tudo = t.falas.map((f) => f.texto).join(' ')
  assert.strictEqual(tudo, frases.join(' '))
  assert.ok(t.falas.every((f) => f.texto.length <= 1000 && f.nome === 'Rita'))
})

test('aula com o Meet corrigindo palavras no fim enquanto corre', () => {
  const t = new Transcricao()
  const b = {}
  const frases = Array.from({ length: 120 }, (_, i) => `Frase ${i} com o contrato da fazenda.`)
  let tela = ''
  for (const frase of frases) {
    // aparece errado e o Meet corrige na hora seguinte
    t.atualizar(b, 'Rita', (tela + ' ' + frase.replace('contrato', 'contato')).trim(), t0)
    tela = (tela + ' ' + frase).trim()
    if (tela.length > 1800) tela = tela.slice(tela.indexOf(' ', 500) + 1)
    t.atualizar(b, 'Rita', tela, t0)
  }
  assert.strictEqual(t.falas.map((f) => f.texto).join(' '), frases.join(' '))
})

test('retomada no meio da aula: a tela só mostra o fim da fala guardada', () => {
  const guardadas = [{ nome: 'Rita', texto: 'Começo da fala que já saiu da tela. E aqui o fim que ainda aparece', hora: t0.toISOString() }]
  const t = new Transcricao(guardadas)
  t.retomar()
  const b = {}
  t.atualizar(b, 'Rita', 'E aqui o fim que ainda aparece', t0)
  t.atualizar(b, 'Rita', 'E aqui o fim que ainda aparece na tela, e segue.', t0)
  assert.strictEqual(t.falas.length, 1)
  assert.strictEqual(t.falas[0].texto, 'Começo da fala que já saiu da tela. E aqui o fim que ainda aparece na tela, e segue.')
})
