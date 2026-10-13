"""As calls guardadas no servidor, por usuário, e o copiloto de cada call ao vivo.

Cada call pertence a um e-mail (quem gravou), e toda leitura filtra por ele: uma
pessoa nunca vê a call de outra. A tabela tem os metadados para o painel geral
(dia, horário, duração, pessoas, título, falas, palavras, quanto cada lado falou,
custo da IA, versão da extensão); o painel do gerente, quando existir, lê daqui.

SQLite da biblioteca padrão, em /var/lib/gravae-copiloto/calls.db (o
StateDirectory do serviço).
"""
import json
import sqlite3
import threading
import time
from datetime import datetime, timezone

from copiloto import Copiloto

ESQUEMA = '''
CREATE TABLE IF NOT EXISTS calls (
  email TEXT NOT NULL,
  id TEXT NOT NULL,
  codigo TEXT, titulo TEXT, url TEXT,
  inicio TEXT, fim TEXT, atualizado TEXT, criado TEXT,
  participantes TEXT DEFAULT '[]',
  n_falas INTEGER DEFAULT 0,
  palavras INTEGER DEFAULT 0,
  fala_vendedor INTEGER, fala_cliente INTEGER,
  versao_extensao TEXT,
  copiloto TEXT,
  resumo TEXT,
  custo REAL DEFAULT 0,
  PRIMARY KEY (email, id)
);
CREATE INDEX IF NOT EXISTS calls_por_inicio ON calls (email, inicio);
CREATE TABLE IF NOT EXISTS falas (
  email TEXT NOT NULL, call_id TEXT NOT NULL, i INTEGER NOT NULL,
  nome TEXT, eu INTEGER DEFAULT 0, texto TEXT, hora TEXT,
  PRIMARY KEY (email, call_id, i)
);
'''

META = ('id', 'codigo', 'titulo', 'url', 'inicio', 'fim', 'atualizado', 'criado', 'participantes', 'n_falas', 'palavras',
        'fala_vendedor', 'fala_cliente', 'versao_extensao', 'custo')


def agora_iso():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


class Banco:
    def __init__(self, caminho):
        self.con = sqlite3.connect(caminho, check_same_thread=False, isolation_level=None)
        self.con.row_factory = sqlite3.Row
        self.trava = threading.RLock()
        with self.trava:
            self.con.execute('PRAGMA journal_mode=WAL')
            self.con.executescript(ESQUEMA)

    def _x(self, sql, args=()):
        with self.trava:
            return self.con.execute(sql, args)

    # ---------- escrita ----------

    def guardar_meta(self, email, id_, meta):
        """Cria a call ou atualiza os campos que vieram (sem apagar o que não veio)."""
        agora = agora_iso()
        with self.trava:
            existe = self._x('SELECT 1 FROM calls WHERE email=? AND id=?', (email, id_)).fetchone()
            if not existe:
                self._x('INSERT INTO calls (email, id, criado, atualizado) VALUES (?, ?, ?, ?)', (email, id_, agora, agora))
            campos = {k: meta[k] for k in ('codigo', 'titulo', 'url', 'inicio', 'fim', 'versao_extensao') if meta.get(k)}
            campos['atualizado'] = agora
            self._x(f'UPDATE calls SET {", ".join(k + "=?" for k in campos)} WHERE email=? AND id=?',
                    (*campos.values(), email, id_))

    def guardar_falas(self, email, id_, falas):
        with self.trava:
            self.con.execute('BEGIN')
            try:
                for f in falas:
                    self.con.execute(
                        'INSERT INTO falas (email, call_id, i, nome, eu, texto, hora) VALUES (?, ?, ?, ?, ?, ?, ?) '
                        'ON CONFLICT (email, call_id, i) DO UPDATE SET nome=excluded.nome, eu=excluded.eu, '
                        'texto=excluded.texto, hora=excluded.hora',
                        (email, id_, int(f['i']), str(f.get('nome') or '?')[:120], 1 if f.get('eu') else 0,
                         str(f.get('texto') or ''), f.get('hora')))
                self.con.execute('COMMIT')
            except Exception:
                self.con.execute('ROLLBACK')
                raise
            self._resumir_falas(email, id_)

    def _resumir_falas(self, email, id_):
        """Os metadados que saem das falas: pessoas, quantas falas e palavras."""
        linhas = self._x('SELECT nome, texto FROM falas WHERE email=? AND call_id=? ORDER BY i', (email, id_)).fetchall()
        pessoas = list(dict.fromkeys(r['nome'] for r in linhas if r['nome']))
        palavras = sum(len((r['texto'] or '').split()) for r in linhas)
        self._x('UPDATE calls SET participantes=?, n_falas=?, palavras=?, atualizado=? WHERE email=? AND id=?',
                (json.dumps(pessoas, ensure_ascii=False), len(linhas), palavras, agora_iso(), email, id_))

    def guardar_copiloto(self, email, id_, guardado, estado):
        fala = (estado or {}).get('fala') or {}
        self._x('UPDATE calls SET copiloto=?, resumo=?, custo=?, fala_vendedor=?, fala_cliente=?, atualizado=? '
                'WHERE email=? AND id=?',
                (json.dumps({'guardado': guardado, 'estado': estado}, ensure_ascii=False), guardado.get('resumo'),
                 float(guardado.get('custo') or 0), fala.get('vendedor'), fala.get('cliente'), agora_iso(), email, id_))

    def apagar(self, email, id_):
        with self.trava:
            self._x('DELETE FROM falas WHERE email=? AND call_id=?', (email, id_))
            return self._x('DELETE FROM calls WHERE email=? AND id=?', (email, id_)).rowcount > 0

    # ---------- leitura (sempre só as calls de quem pede) ----------

    @staticmethod
    def _meta(r):
        m = {k: r[k] for k in META}
        m['participantes'] = json.loads(r['participantes'] or '[]')
        m['tem_resumo'] = bool(r['resumo'])
        return m

    def listar(self, email, de=None, ate=None):
        sql, args = 'SELECT * FROM calls WHERE email=?', [email]
        if de:
            sql += ' AND inicio >= ?'
            args.append(de)
        if ate:
            sql += ' AND inicio < ?'
            args.append(ate)
        return [self._meta(r) for r in self._x(sql + ' ORDER BY inicio', args).fetchall()]

    def buscar(self, email, termo, limite=30):
        like = '%' + termo.replace('%', '').replace('_', '') + '%'
        linhas = self._x(
            'SELECT c.id, c.titulo, c.inicio, f.nome, f.texto FROM calls c LEFT JOIN falas f '
            'ON f.email=c.email AND f.call_id=c.id AND (f.texto LIKE ? OR f.nome LIKE ?) '
            'WHERE c.email=? AND (c.titulo LIKE ? OR f.i IS NOT NULL) ORDER BY c.inicio DESC, f.i LIMIT 400',
            (like, like, email, like)).fetchall()
        vistos, achados = set(), []
        for r in linhas:
            if r['id'] in vistos:
                continue
            vistos.add(r['id'])
            achados.append({'id': r['id'], 'titulo': r['titulo'], 'inicio': r['inicio'], 'nome': r['nome'], 'texto': r['texto']})
            if len(achados) >= limite:
                break
        return achados

    def obter(self, email, id_, com_falas=True):
        r = self._x('SELECT * FROM calls WHERE email=? AND id=?', (email, id_)).fetchone()
        if not r:
            return None
        call = self._meta(r)
        cop = json.loads(r['copiloto']) if r['copiloto'] else {}
        call['copiloto'] = cop.get('estado')
        call['guardado'] = cop.get('guardado')
        if com_falas:
            call['falas'] = self.falas(email, id_)
        return call

    def falas(self, email, id_):
        return [{'i': f['i'], 'nome': f['nome'], 'eu': bool(f['eu']), 'texto': f['texto'], 'hora': f['hora']}
                for f in self._x('SELECT * FROM falas WHERE email=? AND call_id=? ORDER BY i', (email, id_)).fetchall()]


class Gerente:
    """Um copiloto vivo por call em andamento, cada um no seu fio. Sem falas por
    15 min, o fio para (o estado já está no banco); se a call voltar, ele volta."""

    OCIOSO_S = 15 * 60

    def __init__(self, banco, roteiro, post_para):
        self.banco = banco
        self.roteiro = roteiro          # função: devolve o roteiro atual (ou None)
        self.post_para = post_para      # função: email -> post(caminho, corpo, timeout)
        self.vivos = {}
        self.trava = threading.Lock()

    def _item(self, email, id_, criar=True):
        chave = (email, id_)
        with self.trava:
            item = self.vivos.get(chave)
            if item or not criar:
                return item
            roteiro = self.roteiro()
            if not roteiro:
                return None
            call = self.banco.obter(email, id_)
            if not call:
                return None
            guardado = call.get('guardado') or {'ativo': False}
            cop = Copiloto(roteiro, self.post_para(email), guardado)
            falas = {f['i']: f for f in call['falas']}
            cop.atualizar([falas[i] for i in sorted(falas)], call.get('inicio'))
            item = {'email': email, 'id': id_, 'cop': cop, 'falas': falas, 'titulo': call.get('titulo') or 'Google Meet',
                    'encerrar': False, 'trava': threading.Lock(), 'versao': 1, 'visto': time.time()}
            self.vivos[chave] = item
            threading.Thread(target=self._rodar, args=(item,), daemon=True, name=f'copiloto-{id_[:20]}').start()
            return item

    def comecar(self, email, id_, ativo_padrao):
        """Call nova: o copiloto nasce ligado ou não, conforme a preferência da pessoa."""
        call = self.banco.obter(email, id_, com_falas=False)
        if call and not call.get('guardado'):
            self.banco.guardar_copiloto(email, id_, {'ativo': bool(ativo_padrao), 'inicio': call.get('inicio')},
                                        {'ativo': bool(ativo_padrao)})
        return self._item(email, id_)

    def falas_novas(self, email, id_, falas, titulo=None, fim=None):
        # Call que já acabou não reabre o copiloto por uma fala atrasada; mas, se ele
        # estava ligado e o resumo ainda não saiu (o servidor reiniciou), sai agora.
        item = self._item(email, id_, criar=not fim)
        if not item and fim:
            g = (self.banco.obter(email, id_, com_falas=False) or {}).get('guardado') or {}
            if g.get('ativo') and not g.get('resumo'):
                item = self._item(email, id_)
        if not item:
            return
        with item['trava']:
            for f in falas:
                item['falas'][int(f['i'])] = f
            if titulo:
                item['titulo'] = titulo
            item['cop'].atualizar([item['falas'][i] for i in sorted(item['falas'])])
            item['versao'] += 1
            item['visto'] = time.time()
            if fim:
                item['encerrar'] = True

    def comando(self, email, id_, ativo=None, sugerir=False):
        item = self._item(email, id_)
        if not item:
            return False
        with item['trava']:
            if ativo is not None:
                item['cop'].ligar(bool(ativo))
            if sugerir:
                item['cop'].pedir_sugestao()
            item['versao'] += 1
            item['visto'] = time.time()
        self._guardar(item)
        return True

    def estado(self, email, id_):
        """(versão, estado do copiloto): o vivo, se houver; senão, o do banco."""
        item = self._item(email, id_, criar=False)
        if item:
            with item['trava']:
                return item['versao'], item['cop'].estado()
        call = self.banco.obter(email, id_, com_falas=False)
        return (call['atualizado'] if call else None), (call or {}).get('copiloto')

    def resumir_agora(self, email, id_):
        """Resumo pedido depois (na agenda), de uma call que acabou sem ele."""
        roteiro = self.roteiro()
        call = self.banco.obter(email, id_)
        if not roteiro or not call or not call['falas']:
            return 'sem falas ou sem roteiro'
        cop = Copiloto(roteiro, self.post_para(email), dict(call.get('guardado') or {}, ativo=True, resumo=None))
        cop.atualizar(call['falas'], call.get('inicio'))
        cop.resumir(call.get('titulo') or 'Google Meet')
        self.banco.guardar_copiloto(email, id_, cop.para_guardar(), cop.estado())
        return None

    def _guardar(self, item):
        with item['trava']:
            guardado, estado = item['cop'].para_guardar(), item['cop'].estado()
        self.banco.guardar_copiloto(item['email'], item['id'], guardado, estado)

    def _rodar(self, item):
        cop = item['cop']
        while True:
            time.sleep(1)
            if item['encerrar']:
                break
            if time.time() - item['visto'] > self.OCIOSO_S:
                break
            # Fora da trava: o Jev e o LLM levam segundos, e as falas continuam chegando.
            if cop.passo():
                with item['trava']:
                    item['versao'] += 1
                self._guardar(item)
        if item['encerrar'] and cop.ativo and not cop.resumo and cop.falas:
            try:
                cop.resumir(item['titulo'])
            except Exception as e:
                cop.erro = 'Resumo: ' + str(e)[:160]
            with item['trava']:
                item['versao'] += 1
        self._guardar(item)
        with self.trava:
            self.vivos.pop((item['email'], item['id']), None)
