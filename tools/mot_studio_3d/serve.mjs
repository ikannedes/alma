#!/usr/bin/env node
// Sirve el visor ya armado (dist/) y, solo para leer, la carpeta de .mot, para abrirlo desde el celular por Tailscale.
//   node serve.mjs [carpeta_mot] [puerto] [modelo.glb]
// Escucha solo en 127.0.0.1: desde fuera se llega únicamente con `tailscale serve` (tailnet, nunca funnel).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, 'dist');
const MOT = path.resolve(process.argv[2] ?? 'C:/Users/ikann/emo_backup/spiffs/mot');
const PORT = +(process.argv[3] ?? 4310);
// modelo CAD articulado (emo_tools/step2glb/articular.mjs): es de su autor, no va al repo
const MODEL = path.resolve(process.argv[4] ?? 'C:/Users/ikann/emo_tools/step2glb/emo_articulado.glb');
const isMot = (n) => /\.(mot|mo|m)$/i.test(n);

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

http.createServer((req, res) => {
  if (req.method !== 'GET') return send(res, 405, 'text/plain', 'solo lectura');
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (url === '/' || url === '/index.html') return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(DIST, 'index.html')));
  if (url === '/modelo.glb' && fs.existsSync(MODEL)) return send(res, 200, 'model/gltf-binary', fs.readFileSync(MODEL));
  if (url === '/mot/index.json') {
    const list = fs.existsSync(MOT) ? fs.readdirSync(MOT).filter(isMot).sort() : [];
    return send(res, 200, 'application/json', JSON.stringify(list));
  }
  const m = /^\/mot\/([^/\\]+)$/.exec(url);
  if (m && isMot(m[1]) && fs.existsSync(path.join(MOT, m[1]))) return send(res, 200, 'application/octet-stream', fs.readFileSync(path.join(MOT, m[1])));
  send(res, 404, 'text/plain', 'no existe');
}).listen(PORT, '127.0.0.1', () => console.log(`mot-studio 3D en http://127.0.0.1:${PORT} (.mot de ${MOT})`));
