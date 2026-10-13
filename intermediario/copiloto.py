"""O cérebro do copiloto de vendas, rodando no servidor.

Acompanha a conversa ao vivo contra um roteiro, em duas camadas, como o copiloto
do G4:
- o Jev (TypeSafe, pela OpenRouter) lê a conversa a cada poucas falas e decide o
  que é fechado: quais etapas do roteiro já foram feitas, qual objeção o cliente
  levantou e quais alertas dispararam (~US$ 0,0001 por leitura);
- o LLM só escreve: a próxima frase sugerida (uma por vez) e o resumo do fim.
A resposta a cada objeção vem pronta do roteiro, sem LLM.

Até a extensão 0.7 isto rodava dentro dela (extensao/lib/copiloto.js). No servidor,
mudar prompt, modelo ou gatilho vale na hora para todo mundo, sem atualizar a
extensão. Sem rede nem banco aqui: quem usa dá as falas e um `post(caminho, corpo)`.
"""
import json
import re
import time
from datetime import datetime
from zoneinfo import ZoneInfo

NIVEIS = ['Não abordada', 'Começou, mas incompleta', 'Coberta']
MODELOS = {'jev': 'typesafe/jev-1.13', 'sugestao': 'anthropic/claude-haiku-4.5', 'resumo': 'anthropic/claude-sonnet-5.5'}
DEBOUNCE_S = 2.5          # espera a fala assentar antes de ler
INTERVALO_JEV_S = 6       # no máximo uma leitura do Jev a cada 6 s
INTERVALO_SUGESTAO_S = 40
JANELA = 6000             # caracteres da conversa que o Jev lê
FUSO = ZoneInfo('America/Sao_Paulo')


def instante(iso):
    """ISO 8601 (com Z ou fuso) → segundos desde 1970; None se não der."""
    try:
        return datetime.fromisoformat(str(iso).replace('Z', '+00:00')).timestamp()
    except (TypeError, ValueError):
        return None


def turnos(falas, inicio):
    """As falas da extensão ({nome, eu, texto, hora}) viram turnos: falas seguidas
    da mesma pessoa, com menos de 30 s entre elas, numa linha só."""
    t0 = instante(inicio) or 0
    lista = []
    for f in falas:
        if not f or not f.get('texto'):
            continue
        h = instante(f.get('hora'))
        t = max(0.0, h - t0) if h and t0 else 0.0
        papel = 'vendedor' if f.get('eu') else 'cliente'
        ultimo = lista[-1] if lista else None
        if ultimo and ultimo['quem'] == f.get('nome') and t - ultimo['fim'] < 30:
            ultimo['texto'] += ' ' + f['texto']
            ultimo['fim'] = t
        else:
            lista.append({'t': t, 'fim': t, 'papel': papel, 'quem': f.get('nome') or '?', 'texto': f['texto']})
    return lista


class Copiloto:
    def __init__(self, roteiro, post, guardado=None, modelos=None):
        """`post(caminho, corpo, timeout)` chama a OpenRouter ('/systemone' ou
        '/chat/completions') e devolve o JSON; `guardado` é o `para_guardar()`
        de antes (o servidor pode ter reiniciado no meio da call)."""
        g = guardado or {}
        self.roteiro = roteiro
        self.post = post
        self.modelos = {**MODELOS, **(modelos or {})}
        self.ativo = bool(g.get('ativo'))
        self.status = {e['id']: 0 for e in roteiro['etapas']}
        self.status.update({k: v for k, v in (g.get('status') or {}).items() if k in self.status})
        self.objecao = g.get('objecao')
        self.objecoes_vistas = list(g.get('objecoesVistas') or [])
        self.alertas = dict(g.get('alertas') or {})
        self.sugestao = g.get('sugestao')
        self.resumo = g.get('resumo')
        self.custo = float(g.get('custo') or 0)
        self.leituras = int(g.get('leituras') or 0)
        self.inicio = g.get('inicio')
        self.erro = None
        self.falas = []
        self._assinatura = ''
        self._versao = 0
        self._versao_lida = -1
        self._ultima_mudanca = 0.0
        self._ultima_leitura = 0.0
        self._ultima_sugestao = 0.0
        self._pedir_sugestao = False

    # ---------- entrada ----------

    def atualizar(self, falas, inicio=None):
        if inicio:
            self.inicio = inicio
        self.falas = turnos(falas, self.inicio)
        ultimo = self.falas[-1]['texto'][-40:] if self.falas else ''
        assinatura = f'{len(self.falas)}:{sum(len(f["texto"]) for f in self.falas)}:{ultimo}'
        if assinatura != self._assinatura:
            self._assinatura = assinatura
            self._versao += 1
            self._ultima_mudanca = time.time()

    def ligar(self, ligado=True):
        self.ativo = bool(ligado)
        if ligado:
            # Lê a conversa acumulada na hora, em vez de esperar a próxima fala.
            self._versao_lida = -1
            self._ultima_leitura = 0.0
            self._ultima_mudanca = 0.0
            self._pedir_sugestao = True

    def pedir_sugestao(self):
        self._pedir_sugestao = True

    def duracao(self):
        t0 = instante(self.inicio)
        return max(0.0, time.time() - t0) if t0 else 0.0

    # ---------- o laço (chamado a cada segundo) ----------

    def passo(self, agora=None):
        """Devolve True se o estado mudou (para guardar e redesenhar)."""
        if not self.ativo:
            return False
        agora = time.time() if agora is None else agora
        mudou = False
        try:
            novas = self._versao != self._versao_lida
            if novas and agora - self._ultima_mudanca > DEBOUNCE_S and agora - self._ultima_leitura > INTERVALO_JEV_S:
                marcou = self.ler_com_jev()
                mudou = True
                if marcou or agora - self._ultima_sugestao > INTERVALO_SUGESTAO_S:
                    self.sugerir()
            if self._pedir_sugestao:
                self._pedir_sugestao = False
                self.sugerir()
                mudou = True
            if self.erro:
                mudou = True
            self.erro = None
        except Exception as e:  # rede, limite do dia, resposta estranha: aparece no painel
            self.erro = str(e)[:200]
            mudou = True
        return mudou

    # ---------- Jev ----------

    def conversa(self, limite=JANELA):
        linhas, total = [], 0
        for f in reversed(self.falas):
            linha = f'{"Vendedor" if f["papel"] == "vendedor" else "Cliente"}: {f["texto"]}'
            total += len(linha)
            if total > limite:
                break
            linhas.append(linha)
        return list(reversed(linhas))

    def perguntas(self):
        q = {}
        for e in self.roteiro['etapas']:
            q['etapa_' + e['id']] = {
                'type': 'score',
                'instructions': (f'Nesta call de vendas, a etapa "{e["nome"]}" já foi feita? Objetivo da etapa: '
                                 f'{e["objetivo"]} Conta como coberta quando: {e["coberto_quando"]}'),
                'criteria': NIVEIS,
            }
        q['objecao'] = {
            'type': 'choice',
            'instructions': ('Nas últimas falas do CLIENTE (as do fim da conversa), ele levantou uma objeção, ou seja, '
                             'uma RESISTÊNCIA a comprar? Motivação e contexto não são objeção: "o clube do lado já tem '
                             'replay" ou "os alunos pedem vídeo" são motivos para comprar.'),
            'criteria': {'nenhuma': 'Nenhuma resistência à compra nas últimas falas do cliente',
                         **{o['id']: f'{o["nome"]}: {o["sinais"]}' for o in self.roteiro['objecoes']}},
        }
        for a in self.roteiro['alertas']:
            q['alerta_' + a['id']] = {'type': 'noul', 'instructions': a['pergunta_jev'] + ' Considere só o fim da conversa.'}
        return q

    def ler_com_jev(self):
        conversa = self.conversa()
        self._versao_lida = self._versao
        self._ultima_leitura = time.time()
        if not conversa:
            return False
        r = self.post('/systemone', {'model': self.modelos['jev'], 'state': {'conversa': conversa},
                                     'questions': self.perguntas()}, 40)
        self.leituras += 1
        self.custo += float((r.get('usage') or {}).get('cost') or 0)
        respostas = r.get('answers') or {}
        agora = self.duracao()
        mudou = False
        for e in self.roteiro['etapas']:
            nivel = int(round(float((respostas.get('etapa_' + e['id']) or {}).get('score') or 0)))
            # Só sobe: uma etapa feita não "desfaz" porque a conversa andou.
            if nivel > self.status[e['id']]:
                self.status[e['id']] = min(nivel, 2)
                mudou = True
        obj = respostas.get('objecao') or {}
        if obj.get('choice') and obj['choice'] != 'nenhuma' and float(obj.get('confidence') or 0) >= 0.7:
            o = next((x for x in self.roteiro['objecoes'] if x['id'] == obj['choice']), None)
            if o and (not self.objecao or self.objecao.get('id') != o['id']):
                self.objecao = dict(o, t=agora)
                self.objecoes_vistas.append(o['id'])
                mudou = True
        elif self.objecao and agora - float(self.objecao.get('t') or 0) > 120:
            self.objecao = None
        for a in self.roteiro['alertas']:
            p = float((respostas.get('alerta_' + a['id']) or {}).get('noul') or 0)
            if p >= 0.7 and a['id'] not in self.alertas:
                self.alertas[a['id']] = {'texto': a['texto'], 't': agora}
                mudou = True
            elif p < 0.3 and a['id'] in self.alertas and agora - float(self.alertas[a['id']].get('t') or 0) > 30:
                del self.alertas[a['id']]
        return mudou

    # ---------- LLM ----------

    def roteiro_compacto(self):
        return '\n'.join(
            f'- [{NIVEIS[self.status[e["id"]]]}] {e["id"]} — {e["nome"]}: {e["objetivo"]} '
            f'Perguntas-modelo: {" / ".join(e["perguntas"])} Dica: {e["dica"]}'
            for e in self.roteiro['etapas'])

    def sugerir(self):
        conversa = self.conversa(4000)
        if not conversa:
            return
        self._ultima_sugestao = time.time()
        objecao = (f'\nObjeção aberta agora: {self.objecao["nome"]}. Resposta do roteiro: {self.objecao["resposta"]}'
                   if self.objecao else '')
        alertas = ''.join(f'\nAlerta: {a["texto"]}' for a in self.alertas.values())
        prompt = (
            f'Você é o copiloto de um vendedor numa call ao vivo. {self.roteiro["objetivo_da_call"]}\n\n'
            f'Roteiro, com o que já foi feito entre colchetes:\n{self.roteiro_compacto()}{objecao}{alertas}\n\n'
            'Conversa até agora (a última linha é a mais recente):\n' + '\n'.join(conversa) + '\n\n'
            'Diga a ÚNICA próxima coisa que o vendedor deve falar agora. Regras: responda ao que o cliente acabou '
            'de dizer antes de puxar outro assunto; se há objeção aberta, trate-a com a resposta do roteiro; senão, '
            'avance para a primeira etapa ainda não coberta que faça sentido agora; nunca repita pergunta já feita '
            'nem peça dado que o cliente já deu; nunca invente valor em reais, desconto ou condição (o número vem da '
            'proposta e da tabela); frase falada, natural, em português do Brasil, com no máximo 25 '
            'palavras. Responda só com JSON: {"etapa": "<id da etapa>", "frase": "...", "porque": "<até 10 palavras>"}'
        )
        r = self.post('/chat/completions', {'model': self.modelos['sugestao'], 'max_tokens': 200, 'temperature': 0.3,
                                            'messages': [{'role': 'user', 'content': prompt}]}, 40)
        self.custo += float((r.get('usage') or {}).get('cost') or 0)
        texto = r['choices'][0]['message'].get('content') or ''
        m = re.search(r'\{.*\}', texto, re.S)
        try:
            dados = json.loads(m.group(0)) if m else {'frase': texto.strip()[:200]}
        except ValueError:
            dados = {'frase': texto.strip()[:200]}
        self.sugestao = {'frase': dados.get('frase') or '', 'etapa': dados.get('etapa'),
                         'porque': dados.get('porque') or '', 't': self.duracao()}

    # ---------- fim da call ----------

    def fala_por_papel(self):
        palavras = {'vendedor': 0, 'cliente': 0}
        for f in self.falas:
            palavras[f['papel']] += len(f['texto'].split())
        total = sum(palavras.values()) or 1
        return {k: round(100 * v / total) for k, v in palavras.items()}

    def resumir(self, titulo):
        """Resumo do fim da call, em Markdown."""
        if not self.falas:
            return None
        fala = self.fala_por_papel()
        ao_vivo = ('\nEtapas marcadas ao vivo:\n' + '\n'.join(f'- {e["nome"]}: {NIVEIS[self.status[e["id"]]]}'
                                                               for e in self.roteiro['etapas']) + '\n') if self.leituras else ''
        prompt = (
            'Você analisa uma call de vendas da Gravaê (sistema de replays, transmissão e receita para arenas '
            'esportivas). Escreva em português do Brasil, em Markdown, curto e concreto, com estas seções:\n'
            '## Resumo (3 a 5 linhas: quem é o cliente, a arena, o que ele quer)\n'
            '## Dados da arena (cidade, esportes, quadras, sistema atual, torneios — só o que foi dito)\n'
            '## Dor e objetivo\n## Objeções e como foram tratadas\n'
            '## Promessas arriscadas (o que o vendedor prometeu que pode virar arrependimento; "nenhuma" se não houve)\n'
            '## Próximos passos (quem faz o quê e quando)\n'
            '## Roteiro (para cada etapa, feita ou não, e o que faltou)\n'
            '## Para a próxima call (2 ou 3 conselhos ao vendedor, baseados no roteiro)\n\n'
            f'Roteiro da call:\n{self.roteiro_compacto()}\n{ao_vivo}'
            f'Fala: vendedor {fala["vendedor"]}%, cliente {fala["cliente"]}% (por palavras).\n\n'
            'Transcrição (Vendedor = quem usa o sistema; Cliente = as outras vozes; as legendas automáticas '
            'erram palavras, interprete pelo sentido):\n' + '\n'.join(self.conversa(60000))
        )
        r = self.post('/chat/completions', {'model': self.modelos['resumo'], 'max_tokens': 4000, 'temperature': 0.2,
                                            'messages': [{'role': 'user', 'content': prompt}]}, 125)
        self.custo += float((r.get('usage') or {}).get('cost') or 0)
        feitas = sum(1 for v in self.status.values() if v == 2)
        t0 = instante(self.inicio) or time.time()
        quando = datetime.fromtimestamp(t0, FUSO).strftime('%Y-%m-%d %H:%M')
        self.resumo = (f'# Copiloto — {titulo}\n\n'
                       f'{quando} · roteiro {self.roteiro["nome"]} · {feitas}/{len(self.roteiro["etapas"])} etapas cobertas · '
                       f'fala: vendedor {fala["vendedor"]}%, cliente {fala["cliente"]}% · custo da IA: US$ {self.custo:.4f}\n\n'
                       + r['choices'][0]['message']['content'].strip() + '\n')
        return self.resumo

    # ---------- estado ----------

    def para_guardar(self):
        return {'ativo': self.ativo, 'status': self.status, 'objecao': self.objecao, 'objecoesVistas': self.objecoes_vistas,
                'alertas': self.alertas, 'sugestao': self.sugestao, 'resumo': self.resumo, 'custo': round(self.custo, 6),
                'leituras': self.leituras, 'inicio': self.inicio}

    def estado(self):
        """O que o painel e a agenda mostram (o mesmo formato da extensão 0.7)."""
        return {**self.para_guardar(),
                'roteiro': self.roteiro['nome'],
                'etapas': [{'id': e['id'], 'nome': e['nome'], 'status': self.status[e['id']], 'objetivo': e['objetivo'],
                            'perguntas': e['perguntas'], 'dica': e['dica']} for e in self.roteiro['etapas']],
                'alertas': list(self.alertas.values()),
                'fala': self.fala_por_papel(),
                'falas': [{k: f[k] for k in ('t', 'papel', 'quem', 'texto')} for f in self.falas[-40:]],
                'erro': self.erro}
