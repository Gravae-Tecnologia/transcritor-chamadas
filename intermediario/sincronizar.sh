#!/bin/bash
# Deixa a VM igual à main do GitHub: roda a cada 2 min (gravae-copiloto-sincronizar.timer).
# Commit novo na main → atualiza o servidor (só reinicia se o servico.py mudou,
# e volta o anterior se o novo não subir), a página de instalação e o .zip da
# extensão. Reiniciar o serviço não desloga ninguém (as sessões são assinadas com
# o SEGREDO do /etc/gravae-copiloto.env, que este script nunca toca).
#
# Variáveis (para testar fora da VM): REPO_URL, BASE, ESTADO, REINICIAR, SAUDE.
set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/Gravae-Tecnologia/transcritor-chamadas.git}
BASE=${BASE:-/opt/gravae-copiloto}
ESTADO=${ESTADO:-/var/lib/gravae-copiloto-sincronizar}
REINICIAR=${REINICIAR:-systemctl restart gravae-copiloto}
SAUDE=${SAUDE:-http://127.0.0.1:8006/saude}
REPO=$BASE/repo

mkdir -p "$ESTADO" "$BASE/pagina" "$BASE/baixar"
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

# 1) O servidor: só se mudou, conferido antes e com volta se não subir.
if ! cmp -s "$REPO/intermediario/servico.py" "$BASE/servico.py"; then
  python3 -m py_compile "$REPO/intermediario/servico.py"
  cp -p "$BASE/servico.py" "$ESTADO/servico.py.anterior" 2>/dev/null || true
  install -m 644 "$REPO/intermediario/servico.py" "$BASE/servico.py"
  $REINICIAR
  ok=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if curl -fsS -m 3 "$SAUDE" > /dev/null 2>&1; then ok=1; break; fi
  done
  if [ "$ok" != 1 ]; then
    echo "o servidor novo não subiu: voltando o anterior (o commit ${CURTO} fica de fora até o próximo)"
    install -m 644 "$ESTADO/servico.py.anterior" "$BASE/servico.py"
    $REINICIAR
    echo "$NOVO" > "$ESTADO/recusado"
    exit 1
  fi
  echo "servidor atualizado"
fi

# 2) A página de instalação.
rm -rf "$BASE/pagina.novo"
cp -r "$REPO/intermediario/pagina" "$BASE/pagina.novo"
chmod -R a+rX "$BASE/pagina.novo"
rm -rf "$BASE/pagina.velho"
mv "$BASE/pagina" "$BASE/pagina.velho" && mv "$BASE/pagina.novo" "$BASE/pagina" && rm -rf "$BASE/pagina.velho"

# 3) O pacote da extensão e a versão publicada (troca atômica: quem baixa no meio pega o inteiro).
VERSAO=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1], encoding='utf-8'))['version'])" "$REPO/extensao/manifest.json")
git -C "$REPO" archive --format=zip -o "$BASE/baixar/.novo.zip" "$NOVO:extensao"
chmod 644 "$BASE/baixar/.novo.zip"
mv "$BASE/baixar/.novo.zip" "$BASE/baixar/transcritor-gravae.zip"
DATA=$(git -C "$REPO" log -1 --format=%cI "$NOVO")
printf '{"versao": "%s", "commit": "%s", "data": "%s"}\n' "$VERSAO" "$CURTO" "$DATA" > "$BASE/baixar/.versao.json"
chmod 644 "$BASE/baixar/.versao.json"
mv "$BASE/baixar/.versao.json" "$BASE/baixar/versao.json"

echo "$NOVO" > "$ESTADO/commit"
echo "pronto: extensão $VERSAO ($CURTO)"
