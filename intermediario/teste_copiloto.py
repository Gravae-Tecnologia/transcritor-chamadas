"""O cérebro do copiloto (copiloto.py) com uma OpenRouter de mentira. Uso: python teste_copiloto.py"""
import json
import time

import copiloto
from copiloto import Copiloto, turnos

ROTEIRO = {
    'nome': 'Roteiro de teste',
    'objetivo_da_call': 'Sair com a proposta enviada.',
    'etapas': [
        {'id': 'abertura', 'nome': 'Abertura', 'objetivo': 'Saber o motivo.', 'coberto_quando': 'o motivo foi dito',
         'perguntas': ['O que te trouxe?'], 'dica': 'Ouça.'},
        {'id': 'arena', 'nome': 'A arena', 'objetivo': 'Cidade e quadras.', 'coberto_quando': 'cidade e quadras ditas',
         'perguntas': ['Onde fica?'], 'dica': 'Anote.'},
    ],
    'objecoes': [{'id': 'preco', 'nome': 'Está caro', 'sinais': 'achou caro', 'resposta': 'Pergunte o que pesou.', 'evitar': 'Baixar preço.'}],
    'alertas': [{'id': 'sinal_compra', 'texto': 'Sinal de compra: pergunte PJ ou PF.', 'pergunta_jev': 'O cliente deu sinal de compra?'}],
}
INICIO = '2026-10-07T17:00:00.000Z'


def hora(s):
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(1791392400 + s)) + '.000Z'


FALAS = [
    {'nome': 'João', 'eu': True, 'texto': 'Oi Carlos, o que te trouxe ao Gravaê?', 'hora': hora(5)},
    {'nome': 'Carlos', 'eu': False, 'texto': 'Os alunos pedem vídeo dos pontos.', 'hora': hora(9)},
    {'nome': 'Carlos', 'eu': False, 'texto': 'Mas achei caro o kit.', 'hora': hora(14)},
]
falhas = []


def ok(cond, o_que):
    print(('ok    ' if cond else 'FALHA ') + o_que)
    if not cond:
        falhas.append(o_que)


def openrouter_falsa():
    pedidos = []

    def post(caminho, corpo, timeout=40):
        pedidos.append((caminho, corpo))
        if caminho == '/systemone':
            return {'usage': {'cost': 0.0001}, 'answers': {
                'etapa_abertura': {'score': 2}, 'etapa_arena': {'score': 0},
                'objecao': {'choice': 'preco', 'confidence': 0.9}, 'alerta_sinal_compra': {'noul': 0.1}}}
        resumo = corpo['max_tokens'] > 1000
        return {'usage': {'cost': 0.03 if resumo else 0.001}, 'choices': [{'message': {'content': '## Resumo\nCarlos quer vídeo.' if resumo else
                '{"etapa":"arena","frase":"O que pesou mais, o kit ou a mensalidade?","porque":"objeção de preço"}'}}]}
    return post, pedidos


# turnos
t = turnos(FALAS, '2026-10-06T13:00:00Z')
inicio_real = hora(0)
t = turnos(FALAS, inicio_real)
ok(len(t) == 2 and [x['papel'] for x in t] == ['vendedor', 'cliente'] and round(t[1]['t']) == 9, 'turnos: falas seguidas da mesma pessoa viram uma linha, com papel')
ok(t[1]['texto'] == 'Os alunos pedem vídeo dos pontos. Mas achei caro o kit.', 'turnos: o texto emendado')

# desligado não chama
post, pedidos = openrouter_falsa()
c = Copiloto(ROTEIRO, post)
c.atualizar(FALAS, inicio_real)
ok(c.passo(time.time() + 10) is False and not pedidos, 'desligado: não chama a OpenRouter')

# ligado
post, pedidos = openrouter_falsa()
c = Copiloto(ROTEIRO, post)
c.atualizar(FALAS, inicio_real)
c.ligar()
ok(c.passo(time.time() + 10) is True, 'ligado: o passo muda o estado')
ok(c.status['abertura'] == 2 and c.objecao and c.objecao['id'] == 'preco', 'o Jev marca a etapa e a objeção')
ok('kit ou a mensalidade' in (c.sugestao or {}).get('frase', ''), 'o LLM sugere a frase')
ok(pedidos[0][1]['state']['conversa'] == ['Vendedor: Oi Carlos, o que te trouxe ao Gravaê?',
                                          'Cliente: Os alunos pedem vídeo dos pontos. Mas achei caro o kit.'], 'o Jev lê a conversa em turnos')
antes = len(pedidos)
c.passo(time.time() + 20)
ok(len(pedidos) == antes, 'sem fala nova, não lê de novo')

# erro aparece no estado
def post_quebrado(caminho, corpo, timeout=40):
    raise RuntimeError('limite de US$ 3.00 por dia atingido')
q = Copiloto(ROTEIRO, post_quebrado)
q.atualizar(FALAS, inicio_real)
q.ligar()
q.passo(time.time() + 10)
ok('limite' in (q.estado()['erro'] or ''), 'erro da OpenRouter aparece no estado')

# resumo e o estado guardado
md = c.resumir('Call com o Carlos')
ok(md.startswith('# Copiloto — Call com o Carlos'), 'o resumo tem o título')
ok('1/2 etapas cobertas' in md and 'custo da IA: US$ 0.03' in md, 'o resumo tem as etapas e o custo')
utc = time.strftime('%Y-%m-%d %H:%M', time.gmtime(1791392400))
brasilia = time.strftime('%Y-%m-%d %H:%M', time.gmtime(1791392400 - 3 * 3600))
ok(md.split('\n')[2].startswith(brasilia) and brasilia != utc, f'o horário do resumo é o de Brasília ({brasilia}, e não {utc} UTC)')
volta = Copiloto(ROTEIRO, post, json.loads(json.dumps(c.para_guardar())))
ok(volta.para_guardar() == c.para_guardar(), 'o estado guardado volta igual')
ok(set(c.estado()) >= {'etapas', 'alertas', 'fala', 'falas', 'roteiro', 'erro', 'sugestao', 'resumo'}, 'o estado tem o que o painel usa')

print(f'{len(falhas)} falha(s)')
raise SystemExit(1 if falhas else 0)
