#!/bin/bash
# Deixa a VM igual à main do GitHub: roda a cada 2 min (gravae-copiloto-sincronizar.timer).
# Commit novo na main → atualiza o servidor (os .py de intermediario/, menos os
# testes; só reinicia se algum mudou, e volta os anteriores se o novo não subir),
# as telas do painel e da agenda (app/), a página de instalação e o .zip da
# extensão. Reiniciar o serviço não desloga ninguém (as sessões são assinadas com
# o SEGREDO do /etc/gravae-copiloto.env, que este script nunca toca).
# Este script e as unidades do systemd também se atualizam: a versão nova vale
# a partir da rodada seguinte.
#
# Variáveis (para testar fora da VM): REPO_URL, BASE, ESTADO, REINICIAR, SAUDE, UNIDADES.
set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/Gravae-Tecnologia/transcritor-chamadas.git}
BASE=${BASE:-/opt/gravae-copiloto}
ESTADO=${ESTADO:-/var/lib/gravae-copiloto-sincronizar}
REINICIAR=${REINICIAR:-systemctl restart gravae-copiloto}
SAUDE=${SAUDE:-http://127.0.0.1:8006/saude}
UNIDADES=${UNIDADES:-/etc/systemd/system}
REPO=$BASE/repo
FONTE=$REPO/intermediario

mkdir -p "$ESTADO" "$BASE/pagina" "$BASE/app" "$BASE/baixar"
if [ ! -d "$REPO/.git" ]; then
  git clone -q --depth 20 --branch main "$REPO_URL" "$REPO"
fi
git -C "$REPO" fetch -q --depth 20 origin main
NOVO=$(git -C "$REPO" rev-parse origin/main)
VELHO=$(cat "$ESTADO/commit" 2>/dev/null || true)
[ "$NOVO" = "$VELHO" ] && exit 0
# Um commit cujo servidor não subiu fica de fora até chegar o próximo (sem reiniciar a cada 2 min).
[ "$NOVO" = "$(cat "$ESTADO/recusado" 2>/dev/null || true)" ] && exit 0
git -C "$REPO" reset -q --hard "$NOVO"
CURTO=${NOVO:0:7}
echo "sincronizando $CURTO"

# 1) O servidor: todos os .py juntos, só se algum mudou, conferidos antes e com volta se não subir.
PYS=$(cd "$FONTE" && ls *.py | grep -v '^teste_')
mudou=0
for f in $PYS; do cmp -s "$FONTE/$f" "$BASE/$f" || mudou=1; done
if [ "$mudou" = 1 ]; then
  for f in $PYS; do python3 -m py_compile "$FONTE/$f"; done
  rm -rf "$ESTADO/anterior" && mkdir -p "$ESTADO/anterior"
  for f in $PYS; do [ -f "$BASE/$f" ] && cp -p "$BASE/$f" "$ESTADO/anterior/$f"; done
  for f in $PYS; do install -m 644 "$FONTE/$f" "$BASE/$f"; done
  $REINICIAR
  ok=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if curl -fsS -m 3 "$SAUDE" > /dev/null 2>&1; then ok=1; break; fi
  done
  if [ "$ok" != 1 ]; then
    echo "o servidor novo não subiu: voltando o anterior (o commit ${CURTO} fica de fora até o próximo)"
    for f in $PYS; do
      if [ -f "$ESTADO/anterior/$f" ]; then install -m 644 "$ESTADO/anterior/$f" "$BASE/$f"; else rm -f "$BASE/$f"; fi
    done
    $REINICIAR
    echo "$NOVO" > "$ESTADO/recusado"
    exit 1
  fi
  echo "servidor atualizado"
fi

# 2) As pastas servidas: a página de instalação e as telas do painel e da agenda (troca atômica).
publicar_pasta() {
  local origem=$1 destino=$2
  [ -d "$origem" ] || return 0
  rm -rf "$destino.novo" "$destino.velho"
  cp -r "$origem" "$destino.novo"
  chmod -R a+rX "$destino.novo"
  mv "$destino" "$destino.velho" && mv "$destino.novo" "$destino" && rm -rf "$destino.velho"
}
publicar_pasta "$FONTE/pagina" "$BASE/pagina"
publicar_pasta "$FONTE/app" "$BASE/app"

# 3) O pacote da extensão e a versão publicada (troca atômica: quem baixa no meio pega o inteiro).
VERSAO=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1], encoding='utf-8'))['version'])" "$REPO/extensao/manifest.json")
git -C "$REPO" archive --format=zip -o "$BASE/baixar/.novo.zip" "$NOVO:extensao"
chmod 644 "$BASE/baixar/.novo.zip"
mv "$BASE/baixar/.novo.zip" "$BASE/baixar/transcritor-gravae.zip"
DATA=$(git -C "$REPO" log -1 --format=%cI "$NOVO")
printf '{"versao": "%s", "commit": "%s", "data": "%s"}\n' "$VERSAO" "$CURTO" "$DATA" > "$BASE/baixar/.versao.json"
chmod 644 "$BASE/baixar/.versao.json"
mv "$BASE/baixar/.versao.json" "$BASE/baixar/versao.json"

# 4) Este script e as unidades do systemd (valem a partir da próxima rodada).
if ! cmp -s "$FONTE/sincronizar.sh" "$BASE/sincronizar.sh"; then
  install -m 755 "$FONTE/sincronizar.sh" "$BASE/sincronizar.sh.novo" && mv "$BASE/sincronizar.sh.novo" "$BASE/sincronizar.sh"
  echo "sincronizar.sh atualizado"
fi
recarregar=0
for u in gravae-copiloto.service gravae-copiloto-sincronizar.service gravae-copiloto-sincronizar.timer; do
  if [ -f "$FONTE/$u" ] && ! cmp -s "$FONTE/$u" "$UNIDADES/$u"; then
    install -m 644 "$FONTE/$u" "$UNIDADES/$u"
    recarregar=1
  fi
done
[ "$recarregar" = 1 ] && command -v systemctl > /dev/null && systemctl daemon-reload && echo "unidades do systemd atualizadas"

echo "$NOVO" > "$ESTADO/commit"
echo "pronto: extensão $VERSAO ($CURTO)"
