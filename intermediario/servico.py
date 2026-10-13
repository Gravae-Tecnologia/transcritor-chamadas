"""Intermediário do copiloto: a extensão fala com ele, e só ele fala com a OpenRouter.

Por que existe: a chave da OpenRouter não pode ir dentro da extensão (o código
de uma extensão é público). Aqui ela fica guardada no servidor, e quem usa o
copiloto entra com o e-mail da Gravaê.

- POST /codigo     {email}                               manda um código de 6 dígitos ao e-mail @gravae.io
- POST /verificar  {email, codigo}                       confere e devolve a sessão (30 dias)
- POST /v1/renovar (Bearer <sessão>)                     troca a sessão por uma nova (mais 30 dias)
- GET  /entrar e /callback                               login Google (só funciona com o endereço
                                                         BASE_URL/callback cadastrado no cliente OAuth)
- POST /v1/calls/<id>/sincronizar {meta, falas}         a extensão manda a call (metadados e falas novas);
                                                         o servidor guarda e roda o copiloto (copiloto.py)
- GET  /v1/calls?de=&ate= · /v1/calls/busca?q= · /v1/calls/<id> · /v1/calls/<id>/estado
- POST /v1/calls/<id>/copiloto {ativo, sugerir} · /v1/calls/<id>/resumir · /v1/calls/importar
- DELETE /v1/calls/<id>                                  sempre só as calls de quem pede (calls.py)
- GET  /app/painel.html · /app/agenda.html               o painel do copiloto e a agenda (abertos dentro da extensão)
- GET  /app/meet-seletores.json                          onde ler as legendas do Meet (a extensão busca)
- POST /v1/jev e /v1/chat (Bearer <sessão>)              o Jev e o LLM direto (extensão 0.7, que rodava o copiloto)
- GET  /v1/roteiro (Bearer <sessão>)                     o roteiro de vendas da Gravaê
- GET  /v1/eu    (Bearer <sessão>)                       quem é e quanto gastou hoje
- GET  /instalar                                         a página de instalação (intermediario/pagina/)
- GET  /baixar/transcritor-gravae.zip                    a extensão, montada da main pelo sincronizar.sh
- GET  /versao                                           a versão publicada ({versao, commit, data})
- GET  /saude

Só a biblioteca padrão do Python. Configuração por variáveis de ambiente (ver
gravae-copiloto.env.exemplo). Para criar uma sessão na mão (teste, suporte):
    python3 servico.py token alguem@gravae.io
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import calls

CFG = {
    'porta': int(os.environ.get('PORTA', '8006')),
    'base': os.environ.get('BASE_URL', 'https://intake.gravae.io/copiloto').rstrip('/'),
    'chave': os.environ.get('OPENROUTER_API_KEY', ''),
    'openrouter': os.environ.get('OPENROUTER_URL', 'https://openrouter.ai/api/v1').rstrip('/'),
    'client_id': os.environ.get('GOOGLE_CLIENT_ID', ''),
    'client_secret': os.environ.get('GOOGLE_CLIENT_SECRET', ''),
    'dominio': os.environ.get('DOMINIO', 'gravae.io'),
    'segredo': os.environ.get('SEGREDO', '').encode(),
    'extensoes': [x for x in os.environ.get('EXTENSOES', '').split(',') if x],
    'modelos_chat': [x for x in os.environ.get('MODELOS_CHAT', 'anthropic/claude-haiku-4.5,anthropic/claude-sonnet-5.5').split(',') if x],
    'modelo_jev': os.environ.get('MODELO_JEV', 'typesafe/jev-1.13'),
    'max_tokens': int(os.environ.get('MAX_TOKENS', '4000')),
    'limite_dia': float(os.environ.get('LIMITE_DIA_USD', '3')),
    'sessao_dias': int(os.environ.get('SESSAO_DIAS', '30')),
    'roteiro': os.environ.get('ROTEIRO', '/opt/gravae-copiloto/roteiro.json'),
    'pagina': os.environ.get('PAGINA', '/opt/gravae-copiloto/pagina'),
    'baixar': os.environ.get('BAIXAR', '/opt/gravae-copiloto/baixar'),
    'sendgrid': os.environ.get('SENDGRID_API_KEY', ''),
    'sendgrid_url': os.environ.get('SENDGRID_URL', 'https://api.sendgrid.com/v3/mail/send'),
    'remetente': os.environ.get('EMAIL_FROM', 'noreply@gravae.io'),
    'uso': os.environ.get('ARQUIVO_USO', '/var/lib/gravae-copiloto/uso.json'),
    'banco': os.environ.get('BANCO', '/var/lib/gravae-copiloto/calls.db'),
    'app': os.environ.get('APP', '/opt/gravae-copiloto/app'),
}
ID_VALIDO = re.compile(r'[A-Za-z0-9._:-]{1,160}')
BANCO = None
GERENTE = None
VOLTA_VALIDA = re.compile(r'^https://([a-p]{32})\.chromiumapp\.org/')

# ---------- sessões assinadas (HMAC), sem banco ----------


def _b64(dados):
    return base64.urlsafe_b64encode(dados).rstrip(b'=').decode()


def _de_b64(texto):
    return base64.urlsafe_b64decode(texto + '=' * (-len(texto) % 4))


def assinar(dados):
    corpo = _b64(json.dumps(dados, separators=(',', ':')).encode())
    return corpo + '.' + _b64(hmac.new(CFG['segredo'], corpo.encode(), hashlib.sha256).digest())


def conferir(token):
    try:
        corpo, assinatura = token.split('.')
        certa = _b64(hmac.new(CFG['segredo'], corpo.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(assinatura, certa):
            return None
        dados = json.loads(_de_b64(corpo))
        return dados if dados.get('exp', 0) > time.time() else None
    except (ValueError, json.JSONDecodeError):
        return None


def nova_sessao(email):
    return assinar({'email': email, 'exp': int(time.time()) + CFG['sessao_dias'] * 86400, 'tipo': 'sessao'})


# ---------- código por e-mail ----------

CODIGO_MIN = 10
_codigos = {}  # email -> {hash, exp, tentativas}
_envios = {}  # email -> [instantes dos últimos envios]
_trava_codigos = threading.Lock()


def _hash_codigo(email, codigo):
    return hmac.new(CFG['segredo'], f'{email}:{codigo}'.encode(), hashlib.sha256).hexdigest()


def email_valido(email):
    return bool(re.fullmatch(r'[a-z0-9._%+-]+@' + re.escape(CFG['dominio']), email))


def mandar_email(email, codigo):
    corpo = {
        'personalizations': [{'to': [{'email': email}]}],
        'from': {'email': CFG['remetente'], 'name': 'Copiloto Gravaê'},
        'subject': f'Seu código do Copiloto Gravaê: {codigo}',
        'content': [
            {'type': 'text/plain', 'value': f'Seu código para entrar no Copiloto da Gravaê é {codigo}. Ele vale por {CODIGO_MIN} minutos.\n\nSe não foi você que pediu, ignore este e-mail.'},
            {'type': 'text/html', 'value': (
                '<div style="font:15px/1.5 Arial,sans-serif;color:#18181b">'
                '<p>Seu código para entrar no <b>Copiloto da Gravaê</b>:</p>'
                f'<p style="font:700 30px/1.2 Arial,sans-serif;letter-spacing:6px;color:#d30404">{codigo}</p>'
                f'<p style="color:#52525b">Vale por {CODIGO_MIN} minutos. Se não foi você que pediu, ignore este e-mail.</p></div>')},
        ],
    }
    pedido = urllib.request.Request(CFG['sendgrid_url'], json.dumps(corpo).encode(),
                                    {'Authorization': 'Bearer ' + CFG['sendgrid'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(pedido, timeout=20) as r:
        return r.status


def pedir_codigo(email):
    agora = time.time()
    with _trava_codigos:
        recentes = [t for t in _envios.get(email, []) if agora - t < CODIGO_MIN * 60]
        if len(recentes) >= 3:
            return 'já foram 3 códigos nos últimos 10 minutos; espere um pouco'
        codigo = f'{secrets.randbelow(1000000):06d}'
        _codigos[email] = {'hash': _hash_codigo(email, codigo), 'exp': agora + CODIGO_MIN * 60, 'tentativas': 0}
        _envios[email] = recentes + [agora]
    mandar_email(email, codigo)
    return None


def conferir_codigo(email, codigo):
    with _trava_codigos:
        pendente = _codigos.get(email)
        if not pendente or pendente['exp'] < time.time() or pendente['tentativas'] >= 5:
            _codigos.pop(email, None)
            return 'código vencido: peça outro'
        if not hmac.compare_digest(pendente['hash'], _hash_codigo(email, codigo)):
            pendente['tentativas'] += 1
            return 'código errado'
        del _codigos[email]
    return None


# ---------- gasto por pessoa, por dia ----------

_trava_uso = threading.Lock()


def _ler_uso():
    try:
        with open(CFG['uso'], encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def gasto_hoje(email):
    with _trava_uso:
        return _ler_uso().get(time.strftime('%Y-%m-%d'), {}).get(email, 0.0)


def somar_gasto(email, custo):
    if not custo:
        return
    with _trava_uso:
        uso = _ler_uso()
        dia = time.strftime('%Y-%m-%d')
        # Guarda só os últimos 60 dias.
        for velho in sorted(uso)[:-60]:
            del uso[velho]
        uso.setdefault(dia, {})
        uso[dia][email] = round(uso[dia].get(email, 0.0) + float(custo), 6)
        os.makedirs(os.path.dirname(CFG['uso']), exist_ok=True)
        temporario = CFG['uso'] + '.tmp'
        with open(temporario, 'w', encoding='utf-8') as f:
            json.dump(uso, f)
        os.replace(temporario, CFG['uso'])


# ---------- OpenRouter ----------


def openrouter(caminho, corpo, email, timeout=125):
    pedido = urllib.request.Request(
        CFG['openrouter'] + caminho, json.dumps(corpo).encode(),
        {'Authorization': 'Bearer ' + CFG['chave'], 'Content-Type': 'application/json',
         'X-Title': 'Copiloto Gravae (extensao)'},
    )
    for tentativa in range(3):
        try:
            with urllib.request.urlopen(pedido, timeout=timeout) as r:
                status, texto = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, texto = e.code, e.read()
        if status in (429, 502, 503, 529) and tentativa < 2:
            time.sleep(1.5 * (tentativa + 1))
            continue
        break
    try:
        somar_gasto(email, (json.loads(texto).get('usage') or {}).get('cost'))
    except (ValueError, AttributeError):
        pass
    return status, texto


def post_para(email):
    """O `post` do cérebro do copiloto (copiloto.py), com o teto de gasto da pessoa."""
    def post(caminho, corpo, timeout=40):
        if gasto_hoje(email) >= CFG['limite_dia']:
            raise RuntimeError(f'limite de US$ {CFG["limite_dia"]:.2f} por dia atingido')
        corpo = dict(corpo, user=email) if caminho == '/chat/completions' else corpo
        status, texto = openrouter(caminho, corpo, email, timeout)
        if status != 200:
            raise RuntimeError(f'HTTP {status}: {texto[:160].decode("utf-8", "replace")}')
        return json.loads(texto)
    return post


_roteiro = {'mtime': None, 'dados': None}


def ler_roteiro():
    try:
        mtime = os.path.getmtime(CFG['roteiro'])
        if mtime != _roteiro['mtime']:
            with open(CFG['roteiro'], encoding='utf-8') as f:
                _roteiro.update(mtime=mtime, dados=json.load(f))
    except (OSError, ValueError):
        pass
    return _roteiro['dados']


# ---------- arquivos públicos (página, download, versão) ----------

TIPOS = {'.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8',
         '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.zip': 'application/zip',
         '.woff2': 'font/woff2', '.ico': 'image/x-icon'}


def arquivo_publico(pasta, nome):
    """O caminho do arquivo dentro da pasta, ou None (sem subir de pasta)."""
    nome = nome.strip('/') or 'index.html'
    if not re.fullmatch(r'[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*', nome) or '..' in nome:
        return None
    caminho = os.path.join(pasta, *nome.split('/'))
    return caminho if os.path.isfile(caminho) else None


def com_versoes(pasta, html):
    """Põe ?v=<hash do arquivo> nos .js, .css e .png que a página chama. O
    Cloudflare manda o navegador guardar esses arquivos por 4 h; com o hash no
    endereço, a página nova nunca roda com o script ou o estilo de antes."""
    def versao(m):
        caminho = arquivo_publico(pasta, m.group(2))
        if not caminho:
            return m.group(0)
        with open(caminho, 'rb') as f:
            return f'{m.group(1)}="{m.group(2)}?v={hashlib.sha1(f.read()).hexdigest()[:10]}"'
    return re.sub(r'\b(src|href)="([A-Za-z0-9._-]+\.(?:js|css|png))"', versao, html)


# ---------- HTTP ----------

PAGINA = '''<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Copiloto · Gravaê</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#f2f2fa;font:15px/1.5 system-ui,sans-serif">
<div style="max-width:420px;padding:24px;background:#18181b;border:1px solid #ffffff14;border-radius:12px"><h1 style="font-size:18px;margin:0 0 8px">{titulo}</h1><p style="margin:0;color:#a8a8b3">{texto}</p></div></body></html>'''


class Servico(BaseHTTPRequestHandler):
    server_version = 'gravae-copiloto'

    def log_message(self, formato, *args):
        sys.stderr.write('%s %s\n' % (self.address_string(), formato % args))

    def _json(self, status, dados):
        corpo = json.dumps(dados, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def _pagina(self, status, titulo, texto):
        corpo = PAGINA.format(titulo=titulo, texto=texto).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def _ir(self, url):
        self.send_response(302)
        self.send_header('Location', url)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _arquivo(self, caminho, cache='no-cache', baixar=False, extras=None, versoes=False):
        if not caminho:
            return self._json(404, {'erro': 'não existe'})
        with open(caminho, 'rb') as f:
            corpo = f.read()
        if versoes and caminho.endswith('.html'):
            corpo = com_versoes(os.path.dirname(caminho), corpo.decode('utf-8')).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', TIPOS.get(os.path.splitext(caminho)[1].lower(), 'application/octet-stream'))
        self.send_header('Content-Length', str(len(corpo)))
        self.send_header('Cache-Control', cache)
        self.send_header('Access-Control-Allow-Origin', '*')
        if baixar:
            self.send_header('Content-Disposition', f'attachment; filename="{os.path.basename(caminho)}"')
        for nome, valor in (extras or {}).items():
            self.send_header(nome, valor)
        self.end_headers()
        self.wfile.write(corpo)

    def _quem(self):
        cabecalho = self.headers.get('Authorization', '')
        dados = conferir(cabecalho[7:]) if cabecalho.startswith('Bearer ') else None
        return dados['email'] if dados and dados.get('tipo') == 'sessao' else None

    def _corpo(self, limite=4 * 1024 * 1024):
        tamanho = int(self.headers.get('Content-Length') or 0)
        if tamanho > limite:
            raise ValueError('pedido grande demais')
        return json.loads(self.rfile.read(tamanho) or b'{}')

    # ----- GET -----

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        consulta = dict(urllib.parse.parse_qsl(url.query))
        if url.path == '/saude':
            return self._json(200, {'ok': True})
        if url.path == '/entrar':
            return self._entrar(consulta.get('volta', ''))
        if url.path == '/callback':
            return self._callback(consulta)
        if url.path == '/instalar':
            return self._ir(CFG['base'] + '/instalar/')
        if url.path.startswith('/instalar/'):
            return self._arquivo(arquivo_publico(CFG['pagina'], url.path[len('/instalar/'):]), cache='no-cache')
        if url.path.startswith('/baixar/'):
            return self._arquivo(arquivo_publico(CFG['baixar'], url.path[len('/baixar/'):]), cache='no-cache', baixar=True)
        if url.path == '/versao':
            return self._arquivo(arquivo_publico(CFG['baixar'], 'versao.json'), cache='no-cache')
        if url.path.startswith('/app/'):
            # Só abre dentro da extensão (frame-ancestors): ninguém embute o painel num site.
            return self._arquivo(arquivo_publico(CFG['app'], url.path[len('/app/'):]), cache='no-cache', versoes=True,
                                 extras={'Content-Security-Policy': "frame-ancestors chrome-extension: 'self'"})
        email = self._quem()
        if not email:
            return self._json(401, {'erro': 'entre com a conta da Gravaê'})
        if url.path == '/v1/eu':
            return self._json(200, {'email': email, 'gasto_hoje': gasto_hoje(email), 'limite_dia': CFG['limite_dia']})
        if url.path.startswith('/v1/calls'):
            return self._calls_get(email, url.path, consulta)
        if url.path == '/v1/roteiro':
            try:
                with open(CFG['roteiro'], encoding='utf-8') as f:
                    return self._json(200, json.load(f))
            except OSError:
                return self._json(404, {'erro': 'sem roteiro no servidor'})
        return self._json(404, {'erro': 'não existe'})

    def _entrar(self, volta):
        m = VOLTA_VALIDA.match(volta)
        if not m or (CFG['extensoes'] and m.group(1) not in CFG['extensoes']):
            return self._pagina(400, 'Endereço de volta inválido', 'Abra o login pela extensão do Transcritor.')
        estado = assinar({'volta': volta, 'exp': int(time.time()) + 600, 'n': secrets.token_hex(8), 'tipo': 'estado'})
        q = urllib.parse.urlencode({
            'client_id': CFG['client_id'], 'redirect_uri': CFG['base'] + '/callback', 'response_type': 'code',
            'scope': 'openid email profile', 'hd': CFG['dominio'], 'prompt': 'select_account', 'state': estado,
        })
        self._ir('https://accounts.google.com/o/oauth2/v2/auth?' + q)

    def _callback(self, consulta):
        estado = conferir(consulta.get('state', ''))
        if not estado or estado.get('tipo') != 'estado':
            return self._pagina(400, 'Login expirou', 'Volte à extensão e clique em Entrar com Google de novo.')
        if 'code' not in consulta:
            return self._pagina(400, 'Login cancelado', 'Volte à extensão e tente de novo.')
        corpo = urllib.parse.urlencode({
            'code': consulta['code'], 'client_id': CFG['client_id'], 'client_secret': CFG['client_secret'],
            'redirect_uri': CFG['base'] + '/callback', 'grant_type': 'authorization_code',
        }).encode()
        try:
            with urllib.request.urlopen('https://oauth2.googleapis.com/token', corpo, timeout=20) as r:
                resposta = json.load(r)
            # O id_token veio direto do Google por HTTPS: não precisa conferir a assinatura.
            dados = json.loads(_de_b64(resposta['id_token'].split('.')[1]))
        except (urllib.error.URLError, KeyError, ValueError) as e:
            return self._pagina(502, 'Não deu para falar com o Google', str(e)[:200])
        ok = (dados.get('iss') in ('accounts.google.com', 'https://accounts.google.com')
              and dados.get('aud') == CFG['client_id'] and dados.get('exp', 0) > time.time()
              and dados.get('email_verified') and dados.get('hd') == CFG['dominio']
              and str(dados.get('email', '')).lower().endswith('@' + CFG['dominio']))
        if not ok:
            return self._pagina(403, 'Só contas da Gravaê', f'Entre com o seu e-mail @{CFG["dominio"]}.')
        email = dados['email'].lower()
        self.log_message('login %s', email)
        fragmento = urllib.parse.urlencode({'token': nova_sessao(email), 'email': email})
        self._ir(estado['volta'] + '#' + fragmento)

    # ----- POST -----

    def do_POST(self):
        caminho = urllib.parse.urlsplit(self.path).path
        if caminho in ('/codigo', '/verificar'):
            return self._login_por_codigo(caminho)
        email = self._quem()
        if not email:
            return self._json(401, {'erro': 'entre com a conta da Gravaê'})
        if caminho == '/v1/renovar':
            # Quem usa não precisa entrar de novo: a extensão renova antes de vencer.
            return self._json(200, {'token': nova_sessao(email), 'email': email})
        try:
            corpo = self._corpo(32 * 1024 * 1024 if caminho.startswith('/v1/calls') else 4 * 1024 * 1024)
        except ValueError as e:
            return self._json(400, {'erro': str(e)})
        if caminho.startswith('/v1/calls'):
            return self._calls_post(email, caminho, corpo)
        if gasto_hoje(email) >= CFG['limite_dia']:
            return self._json(429, {'erro': f'limite de US$ {CFG["limite_dia"]:.2f} por dia atingido'})
        if caminho == '/v1/jev':
            if corpo.get('model') != CFG['modelo_jev']:
                return self._json(400, {'erro': 'modelo não permitido'})
            limpo = {'model': corpo['model'], 'state': corpo.get('state'), 'questions': corpo.get('questions')}
            status, texto = openrouter('/systemone', limpo, email)
        elif caminho == '/v1/chat':
            if corpo.get('model') not in CFG['modelos_chat']:
                return self._json(400, {'erro': 'modelo não permitido'})
            limpo = {'model': corpo['model'], 'messages': corpo.get('messages', []), 'user': email,
                     'max_tokens': min(int(corpo.get('max_tokens') or 1000), CFG['max_tokens'])}
            if 'temperature' in corpo:
                limpo['temperature'] = corpo['temperature']
            status, texto = openrouter('/chat/completions', limpo, email)
        else:
            return self._json(404, {'erro': 'não existe'})
        self.log_message('%s %s %s', email, caminho, status)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(texto)))
        self.end_headers()
        self.wfile.write(texto)


# ---------- as calls (calls.py): cada um só as suas ----------


def _id_da_call(caminho, sufixo=''):
    """'/v1/calls/<id>' + sufixo → id válido, ou None."""
    resto = caminho[len('/v1/calls/'):]
    if sufixo:
        if not resto.endswith(sufixo):
            return None
        resto = resto[: -len(sufixo)]
    resto = urllib.parse.unquote(resto)
    return resto if ID_VALIDO.fullmatch(resto) else None


def _calls_get(self, email, caminho, consulta):
    if caminho == '/v1/calls':
        return self._json(200, {'calls': BANCO.listar(email, consulta.get('de'), consulta.get('ate'))})
    if caminho == '/v1/calls/busca':
        termo = (consulta.get('q') or '').strip()
        return self._json(200, {'resultados': BANCO.buscar(email, termo) if len(termo) >= 2 else []})
    id_ = _id_da_call(caminho, '/estado')
    if id_:
        call = BANCO.obter(email, id_, com_falas=False)
        if not call:
            return self._json(404, {'erro': 'call não encontrada'})
        versao, estado = GERENTE.estado(email, id_)
        versao = f'{versao}:{call["atualizado"]}'
        if consulta.get('v') == versao:
            return self._json(200, {'igual': True, 'versao': versao})
        call.pop('guardado', None)
        call.pop('copiloto', None)
        return self._json(200, {'versao': versao, 'call': call, 'copiloto': estado})
    id_ = _id_da_call(caminho)
    call = BANCO.obter(email, id_) if id_ else None
    if not call:
        return self._json(404, {'erro': 'call não encontrada'})
    call.pop('guardado', None)
    return self._json(200, call)


def _calls_post(self, email, caminho, corpo):
    if caminho == '/v1/calls/importar':
        # O histórico que estava só no navegador (extensão até a 0.7) vem para o servidor.
        r = corpo.get('reuniao') or {}
        id_ = str(r.get('id') or '')
        if not ID_VALIDO.fullmatch(id_):
            return self._json(400, {'erro': 'call sem id'})
        ja = BANCO.obter(email, id_, com_falas=False)
        BANCO.guardar_meta(email, id_, {k: r.get(k) for k in ('codigo', 'titulo', 'url', 'inicio', 'fim')})
        falas = [dict(f, i=i) for i, f in enumerate(r.get('falas') or []) if f and f.get('texto')]
        if falas:
            BANCO.guardar_falas(email, id_, falas)
        cop = corpo.get('copiloto') or {}
        if cop.get('guardado') and not (ja and ja.get('guardado')):
            BANCO.guardar_copiloto(email, id_, cop['guardado'], cop.get('estado') or {})
        return self._json(200, {'ok': True, 'falas': len(falas)})
    id_ = _id_da_call(caminho, '/sincronizar')
    if id_:
        meta = corpo.get('meta') or {}
        nova = not BANCO.obter(email, id_, com_falas=False)
        BANCO.guardar_meta(email, id_, {k: meta.get(k) for k in ('codigo', 'titulo', 'url', 'inicio', 'fim')}
                           | {'versao_extensao': meta.get('versao')})
        falas = [f for f in (corpo.get('falas') or []) if isinstance(f, dict) and 'i' in f]
        if falas:
            BANCO.guardar_falas(email, id_, falas)
        if nova and not meta.get('fim'):
            GERENTE.comecar(email, id_, bool(meta.get('copiloto_auto', True)))
        GERENTE.falas_novas(email, id_, falas, titulo=meta.get('titulo'), fim=meta.get('fim'))
        return self._json(200, {'ok': True, 'recebidas': len(falas)})
    id_ = _id_da_call(caminho, '/copiloto')
    if id_:
        if not BANCO.obter(email, id_, com_falas=False):
            return self._json(404, {'erro': 'call não encontrada'})
        ok = GERENTE.comando(email, id_, ativo=corpo.get('ativo'), sugerir=bool(corpo.get('sugerir')))
        return self._json(200 if ok else 409, {'ok': ok} if ok else {'erro': 'sem roteiro no servidor'})
    id_ = _id_da_call(caminho, '/resumir')
    if id_:
        if not BANCO.obter(email, id_, com_falas=False):
            return self._json(404, {'erro': 'call não encontrada'})
        try:
            erro = GERENTE.resumir_agora(email, id_)
        except Exception as e:
            erro = str(e)[:200]
        return self._json(400 if erro else 200, {'erro': erro} if erro else {'ok': True})
    return self._json(404, {'erro': 'não existe'})


def do_DELETE(self):
    caminho = urllib.parse.urlsplit(self.path).path
    email = self._quem()
    if not email:
        return self._json(401, {'erro': 'entre com a conta da Gravaê'})
    id_ = _id_da_call(caminho) if caminho.startswith('/v1/calls/') else None
    if not id_:
        return self._json(404, {'erro': 'não existe'})
    return self._json(200 if BANCO.apagar(email, id_) else 404, {'ok': True})


Servico._calls_get = _calls_get
Servico._calls_post = _calls_post
Servico.do_DELETE = do_DELETE


def _login_por_codigo(self, caminho):
    try:
        corpo = self._corpo()
    except ValueError as e:
        return self._json(400, {'erro': str(e)})
    email = str(corpo.get('email', '')).strip().lower()
    if not email_valido(email):
        return self._json(400, {'erro': f'use o seu e-mail @{CFG["dominio"]}'})
    if caminho == '/codigo':
        try:
            erro = pedir_codigo(email)
        except (urllib.error.URLError, OSError) as e:
            self.log_message('envio falhou para %s: %s', email, e)
            return self._json(502, {'erro': 'não deu para mandar o e-mail agora'})
        if erro:
            return self._json(429, {'erro': erro})
        self.log_message('código enviado a %s', email)
        return self._json(200, {'ok': True, 'minutos': CODIGO_MIN})
    codigo = re.sub(r'\D', '', str(corpo.get('codigo', '')))
    erro = conferir_codigo(email, codigo)
    if erro:
        return self._json(400, {'erro': erro})
    self.log_message('login por código %s', email)
    return self._json(200, {'token': nova_sessao(email), 'email': email})


Servico._login_por_codigo = _login_por_codigo


def main():
    if len(sys.argv) == 3 and sys.argv[1] == 'token':
        print(nova_sessao(sys.argv[2].lower()))
        return
    faltando = [k for k in ('chave', 'sendgrid', 'segredo') if not CFG[k]]
    if faltando:
        sys.exit('faltam variáveis: ' + ', '.join(faltando))
    global BANCO, GERENTE
    os.makedirs(os.path.dirname(CFG['banco']), exist_ok=True)
    BANCO = calls.Banco(CFG['banco'])
    GERENTE = calls.Gerente(BANCO, ler_roteiro, post_para)
    servidor = ThreadingHTTPServer(('127.0.0.1', CFG['porta']), Servico)
    print(f'gravae-copiloto em 127.0.0.1:{CFG["porta"]} ({CFG["base"]})', flush=True)
    servidor.serve_forever()


if __name__ == '__main__':
    main()
