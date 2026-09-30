// Gera os ícones da extensão (balão de fala azul com três linhas brancas),
// sem dependência: desenha pixel a pixel e grava o PNG com o zlib do Node.
// Uso: node testes/gerar-icones.js
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

function crc32(buf) {
  let c, crc = 0xffffffff
  for (const b of buf) {
    c = (crc ^ b) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pedaco(tipo, dados) {
  const tam = Buffer.alloc(4)
  tam.writeUInt32BE(dados.length)
  const corpo = Buffer.concat([Buffer.from(tipo), dados])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(corpo))
  return Buffer.concat([tam, corpo, crc])
}

function png(lado, cor) {
  const linhas = []
  for (let y = 0; y < lado; y++) {
    const linha = Buffer.alloc(1 + lado * 4)
    for (let x = 0; x < lado; x++) linha.set(cor(x + 0.5, y + 0.5, lado), 1 + x * 4)
    linhas.push(linha)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(lado, 0)
  ihdr.writeUInt32BE(lado, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pedaco('IHDR', ihdr),
    pedaco('IDAT', zlib.deflateSync(Buffer.concat(linhas))),
    pedaco('IEND', Buffer.alloc(0))
  ])
}

// Retângulo arredondado em coordenadas de 0 a 1.
function dentroArredondado(u, v, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(u, x0 + r), x1 - r)
  const cy = Math.min(Math.max(v, y0 + r), y1 - r)
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r && u >= x0 && u <= x1 && v >= y0 && v <= y1
}

function desenho(x, y, lado) {
  const u = x / lado, v = y / lado
  const azul = [26, 115, 232, 255], branco = [255, 255, 255, 255], nada = [0, 0, 0, 0]
  const balao = dentroArredondado(u, v, 0.06, 0.1, 0.94, 0.74, 0.16)
  // Rabinho do balão, embaixo à esquerda.
  const rabo = v >= 0.7 && v <= 0.92 && u >= 0.2 && u <= 0.42 && (u - 0.2) <= (0.92 - v) * 1.0
  if (!balao && !rabo) return nada
  const grossura = lado <= 16 ? 0.1 : 0.075
  const traco = (y0, x1) => v >= y0 && v <= y0 + grossura && u >= 0.22 && u <= x1
  if (traco(0.24, 0.78) || traco(0.38, 0.7) || (lado > 16 && traco(0.52, 0.58))) return branco
  return azul
}

const destino = path.join(__dirname, '..', 'extensao', 'icones')
for (const lado of [16, 48, 128]) fs.writeFileSync(path.join(destino, `${lado}.png`), png(lado, desenho))
console.log('ícones gravados em', destino)
