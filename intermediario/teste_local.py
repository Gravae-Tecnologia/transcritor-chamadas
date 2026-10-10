"""Teste do intermediário sem rede: uma OpenRouter de mentira e uma porta própria."""
import json, os, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AQUI = os.path.dirname(os.path.abspath(__file__))
pedidos = []

emails = []

class Falsa(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        corpo = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path == '/sendgrid':
            emails.append(corpo)
            self.send_response(202); self.send_header('Content-Length', '0'); self.end_headers(); return
        pedidos.append((self.path, corpo, self.headers.get('Authorization')))
        r = json.dumps({'usage': {'cost': 1.2}, 'choices': [{'message': {'content': 'oi'}}], 'answers': {}}).encode()
        self.send_response(200); self.send_header('Content-Length', str(len(r))); self.end_headers(); self.wfile.write(r)

falsa = ThreadingHTTPServer(('127.0.0.1', 18891), Falsa)
threading.Thread(target=falsa.serve_forever, daemon=True).start()
pasta = tempfile.mkdtemp()
json.dump({'nome': 'Roteiro de teste', 'etapas': []}, open(os.path.join(pasta, 'roteiro.json'), 'w'))
env = dict(os.environ, PORTA='18890', OPENROUTER_API_KEY='chave-de-mentira', OPENROUTER_URL='http://127.0.0.1:18891/api/v1',
           GOOGLE_CLIENT_ID='cliente.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET='x', SEGREDO='segredo-de-teste',
           EXTENSOES='abcdefghijklmnopabcdefghijklmnop', LIMITE_DIA_USD='2', ROTEIRO=os.path.join(pasta, 'roteiro.json'),
           ARQUIVO_USO=os.path.join(pasta, 'uso.json'), BASE_URL='https://intake.gravae.io/copiloto',
           SENDGRID_API_KEY='sg-de-mentira', SENDGRID_URL='http://127.0.0.1:18891/sendgrid',
           PAGINA=os.path.join(pasta, 'pagina'), BAIXAR=os.path.join(pasta, 'baixar'))
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
finally:
    srv.terminate()
print(f'{len(falhas)} falha(s)')
