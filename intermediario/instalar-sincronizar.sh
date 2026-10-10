#!/bin/bash
# Instala (uma vez só) o vigia que deixa a VM coaching-tools igual à main do GitHub.
# Na VM: curl -fsSL https://raw.githubusercontent.com/Gravae-Tecnologia/transcritor-chamadas/main/intermediario/instalar-sincronizar.sh | sudo bash
set -euo pipefail
RAW=https://raw.githubusercontent.com/Gravae-Tecnologia/transcritor-chamadas/main/intermediario
curl -fsSL "$RAW/sincronizar.sh" -o /opt/gravae-copiloto/sincronizar.sh
chmod 755 /opt/gravae-copiloto/sincronizar.sh
curl -fsSL "$RAW/gravae-copiloto-sincronizar.service" -o /etc/systemd/system/gravae-copiloto-sincronizar.service
curl -fsSL "$RAW/gravae-copiloto-sincronizar.timer" -o /etc/systemd/system/gravae-copiloto-sincronizar.timer
systemctl daemon-reload
systemctl enable --now gravae-copiloto-sincronizar.timer
systemctl start gravae-copiloto-sincronizar.service || true
journalctl -u gravae-copiloto-sincronizar -n 15 --no-pager -o cat
systemctl list-timers gravae-copiloto-sincronizar.timer --no-pager | head -3
