"""Teste do intermediário sem rede: uma OpenRouter de mentira e uma porta própria."""
import json, os, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AQUI = os.path.dirname(os.path.abspath(__file__))
pedidos = []

emails = []
CUSTO = [1.2]  # o que cada chamada à OpenRouter de mentira "custa"

class Falsa(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        corpo = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path == '/sendgrid':
            emails.append(corpo)
            self.send_response(202); self.send_header('Content-Length', '0'); self.end_headers(); return
        pedidos.append((self.path, corpo, self.headers.get('Authorization')))
        r = json.dumps({'usage': {'cost': CUSTO[0]}, 'choices': [{'message': {'content': 'oi'}}], 'answers': {}}).encode()
        self.send_response(200); self.send_header('Content-Length', str(len(r))); self.end_headers(); self.wfile.write(r)

falsa = ThreadingHTTPServer(('127.0.0.1', 18891), Falsa)
threading.Thread(target=falsa.serve_forever, daemon=True).start()
pasta = tempfile.mkdtemp()
json.dump({'nome': 'Roteiro de teste', 'objetivo_da_call': 'Sair com proposta.', 'objecoes': [], 'alertas': [],
           'etapas': [{'id': 'abertura', 'nome': 'Abertura', 'objetivo': 'Motivo.', 'coberto_quando': 'motivo dito',
                       'perguntas': ['O que te trouxe?'], 'dica': 'Ouça.'}]}, open(os.path.join(pasta, 'roteiro.json'), 'w'))
os.makedirs(os.path.join(pasta, 'app'))
open(os.path.join(pasta, 'app', 'painel.html'), 'w', encoding='utf-8').write('<h1>Painel</h1>')
env = dict(os.environ, PORTA='18890', OPENROUTER_API_KEY='chave-de-mentira', OPENROUTER_URL='http://127.0.0.1:18891/api/v1',
           GOOGLE_CLIENT_ID='cliente.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET='x', SEGREDO='segredo-de-teste',
           EXTENSOES='abcdefghijklmnopabcdefghijklmnop', LIMITE_DIA_USD='2', ROTEIRO=os.path.join(pasta, 'roteiro.json'),
           ARQUIVO_USO=os.path.join(pasta, 'uso.json'), BASE_URL='https://intake.gravae.io/copiloto',
           SENDGRID_API_KEY='sg-de-mentira', SENDGRID_URL='http://127.0.0.1:18891/sendgrid',
           PAGINA=os.path.join(pasta, 'pagina'), BAIXAR=os.path.join(pasta, 'baixar'),
           BANCO=os.path.join(pasta, 'calls.db'), APP=os.path.join(pasta, 'app'))
os.makedirs(os.path.join(pasta, 'pagina'))
os.makedirs(os.path.join(pasta, 'baixar'))
open(os.path.join(pasta, 'pagina', 'index.html'), 'w', encoding='utf-8').write('<h1>Instalar</h1>')
open(os.path.join(pasta, 'baixar', 'transcritor-gravae.zip'), 'wb').write(b'PK zip de mentira')
json.dump({'versao': '0.7.3', 'commit': 'abc1234'}, open(os.path.join(pasta, 'baixar', 'versao.json'), 'w'))
srv = subprocess.Popen([sys.executable, os.path.join(AQUI, 'servico.py')], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(1.2)
token = subprocess.check_output([sys.executable, os.path.join(AQUI, 'servico.py'), 'token', 'Vendedor@gravae.io'], env=env, text=True).strip()
B = 'http://127.0.0.1:18890'
falhas = []
def ok(c, o):
    print(('ok    ' if c else 'FALHA ') + o)
    if not c: falhas.append(o)
def pedir(caminho, corpo=None, tok=token, metodo=None):
    h = {'Content-Type': 'application/json'}
    if tok: h['Authorization'] = 'Bearer ' + tok
    req = urllib.request.Request(B + caminho, json.dumps(corpo).encode() if corpo is not None else None, h, method=metodo)
    try:
        with urllib.request.urlopen(req) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()

class SemSeguir(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
abrir = urllib.request.build_opener(SemSeguir)
try:
    ok(pedir('/saude', tok=None)[0] == 200, 'saúde sem login')
    ok(pedir('/v1/eu', tok=None)[0] == 401, 'sem sessão: 401')
    ok(pedir('/v1/eu', tok=token[:-2] + 'xx')[0] == 401, 'sessão adulterada: 401')
    s, c = pedir('/v1/eu'); ok(s == 200 and json.loads(c)['email'] == 'vendedor@gravae.io', 'quem sou eu')
    s, c = pedir('/v1/roteiro'); ok(s == 200 and json.loads(c)['nome'] == 'Roteiro de teste', 'roteiro com login')
    ok(pedir('/v1/chat', {'model': 'openai/gpt-5', 'messages': []})[0] == 400, 'modelo fora da lista: 400')
    s, c = pedir('/v1/chat', {'model': 'anthropic/claude-haiku-4.5', 'messages': [{'role': 'user', 'content': 'oi'}], 'max_tokens': 99999, 'tools': ['x']})
    ok(s == 200 and pedidos[-1][0] == '/api/v1/chat/completions', 'chat repassado')
    ok(pedidos[-1][1]['max_tokens'] == 4000 and 'tools' not in pedidos[-1][1] and pedidos[-1][1]['user'] == 'vendedor@gravae.io', 'chat limpo: teto de tokens, sem campos extras, com o usuário')
    ok(pedidos[-1][2] == 'Bearer chave-de-mentira', 'a chave vai só do servidor para a OpenRouter')
    s, c = pedir('/v1/jev', {'model': 'typesafe/jev-1.13', 'state': {'conversa': []}, 'questions': {}})
    ok(s == 200 and pedidos[-1][0] == '/api/v1/systemone', 'Jev repassado')
    s, c = pedir('/v1/chat', {'model': 'anthropic/claude-haiku-4.5', 'messages': []})
    ok(s == 429, f'limite do dia (US$ 2, gasto 2,4): {s}')
    try:
        abrir.open(B + '/entrar?volta=' + urllib.parse.quote('https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/copiloto', safe=''))
    except urllib.error.HTTPError as e:
        loc = e.headers.get('Location', '')
        ok(e.code == 302 and 'accounts.google.com' in loc and 'hd=gravae.io' in loc and 'redirect_uri=https%3A%2F%2Fintake.gravae.io%2Fcopiloto%2Fcallback' in loc, 'entrar manda ao Google com hd e o retorno certo')
    try:
        abrir.open(B + '/entrar?volta=' + urllib.parse.quote('https://evil.example.com/', safe=''))
    except urllib.error.HTTPError as e:
        ok(e.code == 400, 'volta para fora da extensão: recusada')
    try:
        abrir.open(B + '/entrar?volta=' + urllib.parse.quote('https://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.chromiumapp.org/x', safe=''))
    except urllib.error.HTTPError as e:
        ok(e.code == 400, 'outra extensão: recusada')
    s, c = pedir('/v1/renovar', {})
    renovada = json.loads(c).get('token') if s == 200 else None
    import base64 as _b64
    validade = lambda t: json.loads(_b64.urlsafe_b64decode(t.split('.')[0] + '=' * (-len(t.split('.')[0]) % 4)))['exp']
    ok(bool(renovada) and validade(renovada) >= validade(token) and pedir('/v1/eu', tok=renovada)[0] == 200, 'renovar devolve uma sessão que funciona, valendo pelo menos até a antiga')
    ok(pedir('/v1/renovar', {}, tok=None)[0] == 401, 'renovar sem sessão: 401')
    # Página, download e versão: públicos, sem login
    s, c = pedir('/instalar/', tok=None); ok(s == 200 and b'Instalar' in c, 'página de instalação sem login')
    s, c = pedir('/baixar/transcritor-gravae.zip', tok=None); ok(s == 200 and c.startswith(b'PK'), 'download sem login')
    s, c = pedir('/versao', tok=None); ok(s == 200 and json.loads(c)['versao'] == '0.7.3', 'versão publicada')
    ok(pedir('/instalar/../servico.py', tok=None)[0] == 404 and pedir('/baixar/..%2Fpagina%2Findex.html', tok=None)[0] == 404, 'não sai da pasta')
    # Login por código no e-mail
    ok(pedir('/codigo', {'email': 'alguem@gmail.com'}, tok=None)[0] == 400, 'código para e-mail de fora: recusado')
    s, c = pedir('/codigo', {'email': ' Vendedor@Gravae.io '}, tok=None)
    ok(s == 200 and len(emails) == 1 and emails[0]['personalizations'][0]['to'][0]['email'] == 'vendedor@gravae.io', 'código mandado ao e-mail certo')
    import re as _re
    codigo = _re.search(r'(\d{6})', emails[0]['subject']).group(1)
    ok(pedir('/verificar', {'email': 'vendedor@gravae.io', 'codigo': '000000' if codigo != '000000' else '111111'}, tok=None)[0] == 400, 'código errado: recusado')
    s, c = pedir('/verificar', {'email': 'vendedor@gravae.io', 'codigo': codigo}, tok=None)
    sessao = json.loads(c).get('token') if s == 200 else None
    ok(bool(sessao) and pedir('/v1/eu', tok=sessao)[0] == 200, 'código certo: sessão que funciona')
    ok(pedir('/verificar', {'email': 'vendedor@gravae.io', 'codigo': codigo}, tok=None)[0] == 400, 'o mesmo código não serve duas vezes')
    pedir('/codigo', {'email': 'outro@gravae.io'}, tok=None); pedir('/codigo', {'email': 'outro@gravae.io'}, tok=None); pedir('/codigo', {'email': 'outro@gravae.io'}, tok=None)
    ok(pedir('/codigo', {'email': 'outro@gravae.io'}, tok=None)[0] == 429, 'quarto código em 10 min: espera')
    for _ in range(5): pedir('/verificar', {'email': 'outro@gravae.io', 'codigo': '123'}, tok=None)
    ultimo = _re.search(r'(\d{6})', emails[-1]['subject']).group(1)
    ok(pedir('/verificar', {'email': 'outro@gravae.io', 'codigo': ultimo}, tok=None)[0] == 400, 'depois de 5 erros, nem o certo vale')
    # ---------- as calls no servidor: cada um só as suas ----------
    CUSTO[0] = 0.001
    ana = subprocess.check_output([sys.executable, os.path.join(AQUI, 'servico.py'), 'token', 'ana@gravae.io'], env=env, text=True).strip()
    beto = subprocess.check_output([sys.executable, os.path.join(AQUI, 'servico.py'), 'token', 'beto@gravae.io'], env=env, text=True).strip()
    from datetime import datetime, timedelta, timezone
    inicio = datetime.now(timezone.utc) - timedelta(minutes=1)
    h = lambda s: (inicio + timedelta(seconds=s)).isoformat()
    meta = {'codigo': 'abc-defg-hij', 'titulo': 'Call com a Arena', 'url': 'https://meet.google.com/abc-defg-hij',
            'inicio': inicio.isoformat(), 'versao': '0.8.0', 'copiloto_auto': True}
    falas = [{'i': 0, 'nome': 'Ana Souza', 'eu': True, 'texto': 'Oi Carlos, o que te trouxe?', 'hora': h(5)},
             {'i': 1, 'nome': 'Carlos', 'eu': False, 'texto': 'Os alunos pedem vídeo e achei caro', 'hora': h(9)}]
    s, c = pedir('/v1/calls/abc-1/sincronizar', {'meta': meta, 'falas': falas}, tok=ana)
    ok(s == 200 and json.loads(c)['recebidas'] == 2, 'sincronizar guarda a call e as falas')
    s, c = pedir('/v1/calls/abc-1', tok=ana)
    call = json.loads(c) if s == 200 else {}
    ok(call.get('titulo') == 'Call com a Arena' and len(call.get('falas', [])) == 2 and call.get('participantes') == ['Ana Souza', 'Carlos']
       and call.get('versao_extensao') == '0.8.0' and call.get('palavras') == 13, 'metadados: título, falas, pessoas, palavras e versão')
    ok(pedir('/v1/calls/abc-1', tok=beto)[0] == 404, 'outra pessoa não vê a call (404)')
    ok(json.loads(pedir('/v1/calls', tok=beto)[1])['calls'] == [], 'outra pessoa não vê nada na lista')
    ok(pedir('/v1/calls/abc-1', tok=beto, metodo='DELETE')[0] == 404 and pedir('/v1/calls/abc-1', tok=ana)[0] == 200, 'outra pessoa não apaga')
    ok(pedir('/v1/calls/abc-1/copiloto', {'ativo': False}, tok=beto)[0] == 404, 'outra pessoa não mexe no copiloto')
    ok(json.loads(pedir('/v1/calls/busca?q=caro', tok=beto)[1])['resultados'] == [], 'outra pessoa não acha na busca')
    time.sleep(4.5)
    s, c = pedir('/v1/calls/abc-1/estado', tok=ana)
    est = json.loads(c)
    cop = est.get('copiloto') or {}
    ok(cop.get('ativo') and cop.get('leituras', 0) >= 1 and (cop.get('sugestao') or {}).get('frase') == 'oi', 'o copiloto roda no servidor: leu com o Jev e sugeriu')
    ok(json.loads(pedir('/v1/calls/abc-1/estado?v=' + urllib.parse.quote(est['versao']), tok=ana)[1]).get('igual') is True, 'estado sem mudança responde "igual"')
    pedir('/v1/calls/abc-1/copiloto', {'ativo': False}, tok=ana)
    ok(json.loads(pedir('/v1/calls/abc-1/estado', tok=ana)[1])['copiloto']['ativo'] is False, 'desligar o copiloto')
    pedir('/v1/calls/abc-1/copiloto', {'ativo': True}, tok=ana)
    falas[1]['texto'] = 'Os alunos pedem vídeo e achei caro o kit'
    pedir('/v1/calls/abc-1/sincronizar', {'meta': meta, 'falas': [falas[1]]}, tok=ana)
    call = json.loads(pedir('/v1/calls/abc-1', tok=ana)[1])
    ok(call['n_falas'] == 2 and call['falas'][1]['texto'].endswith('o kit'), 'correção de fala atualiza no lugar')
    pedir('/v1/calls/abc-1/sincronizar', {'meta': dict(meta, fim=h(60)), 'falas': []}, tok=ana)
    for _ in range(20):
        time.sleep(0.5)
        call = json.loads(pedir('/v1/calls/abc-1', tok=ana)[1])
        if call.get('tem_resumo'):
            break
    ok(call.get('fim') and call.get('tem_resumo') and call['copiloto']['resumo'].startswith('# Copiloto — Call com a Arena'), 'fim da call: o resumo sai sozinho')
    r = json.loads(pedir('/v1/calls/busca?q=caro', tok=ana)[1])['resultados']
    ok(len(r) == 1 and r[0]['id'] == 'abc-1' and 'caro' in r[0]['texto'], 'busca nas transcrições de quem pede')
    s, c = pedir('/v1/calls/importar', {'reuniao': {'id': 'old-1', 'codigo': 'xyz', 'titulo': 'Call antiga', 'inicio': h(-86400),
                 'fim': h(-84600), 'falas': [{'nome': 'Ana Souza', 'eu': True, 'texto': 'oi', 'hora': h(-86000)}]},
                 'copiloto': {'guardado': {'ativo': True, 'resumo': '# Resumo antigo'}, 'estado': {'resumo': '# Resumo antigo'}}}, tok=ana)
    lista = json.loads(pedir('/v1/calls', tok=ana)[1])['calls']
    ok(s == 200 and [x['id'] for x in lista] == ['old-1', 'abc-1'] and lista[0]['tem_resumo'], 'importar o histórico do navegador')
    ok([x['id'] for x in json.loads(pedir('/v1/calls?de=' + urllib.parse.quote(h(-3600)), tok=ana)[1])['calls']] == ['abc-1'], 'lista por período')
    ok(pedir('/v1/calls/abc-1', tok=ana, metodo='DELETE')[0] == 200 and pedir('/v1/calls/abc-1', tok=ana)[0] == 404, 'apagar a própria call')
    ok(pedir('/v1/calls/..%2Fx', tok=ana)[0] == 404 and pedir('/v1/calls/a%20b', tok=ana)[0] == 404, 'id estranho não passa')
    req = urllib.request.Request(B + '/app/painel.html')
    with urllib.request.urlopen(req) as r:
        ok(r.status == 200 and 'frame-ancestors chrome-extension:' in r.headers.get('Content-Security-Policy', ''), 'o painel só abre dentro da extensão')
finally:
    srv.terminate()
print(f'{len(falhas)} falha(s)')
