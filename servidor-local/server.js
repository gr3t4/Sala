// Sala · servidor local de videos
// Recibe videos desde el panel de Sala, los convierte a HLS con ffmpeg y los entrega
// solo a miembros con sesión activa. Sin dependencias: requiere Node 18+ y ffmpeg.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

/* ---------- Configuración (.env junto a este archivo) ---------- */
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (_) {}
const CFG = {
  port: Number(process.env.PORT || 8787),
  data: path.resolve(process.env.DATA_DIR || path.join(__dirname, "data")),
  supabaseUrl: (process.env.SUPABASE_URL || "").replace(/\/$/, ""),
  supabaseKey: process.env.SUPABASE_KEY || "",
  secret: process.env.SALA_SECRET || "",
  modo: process.env.MODO || "auto",            // auto | copy | 720p | 480p
  conservarOriginal: process.env.CONSERVAR_ORIGINAL === "1",
  indexHtml: path.resolve(process.env.INDEX_HTML || path.join(__dirname, "..", "index.html")),
};
if (!CFG.supabaseUrl || !CFG.supabaseKey || !CFG.secret) {
  console.error("Falta configurar SUPABASE_URL, SUPABASE_KEY o SALA_SECRET en servidor-local/.env");
  process.exit(1);
}
const DIR_UP = path.join(CFG.data, "subidas");
const DIR_VID = path.join(CFG.data, "videos");
fs.mkdirSync(DIR_UP, { recursive: true });
fs.mkdirSync(DIR_VID, { recursive: true });

/* ---------- Utilidades ---------- */
const ID_RE = /^[a-f0-9]{24}$/;
const nuevoId = () => crypto.randomBytes(12).toString("hex");
const firmar = (id, exp) => crypto.createHmac("sha256", CFG.secret).update(`${id}.${exp}`).digest("hex").slice(0, 32);
const TIPOS = { ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t", ".jpg": "image/jpeg", ".html": "text/html; charset=utf-8" };

function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-offset");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
}
function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
async function leerJson(req, max = 64 * 1024) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > max) throw new Error("Cuerpo demasiado grande"); }
  try { return JSON.parse(s || "{}"); } catch (_) { return {}; }
}
const leerEstado = async (id) => JSON.parse(await fsp.readFile(path.join(DIR_VID, id, "estado.json"), "utf8"));
const guardarEstado = (id, e) => fsp.writeFile(path.join(DIR_VID, id, "estado.json"), JSON.stringify(e));

/* ---------- Autenticación con Supabase ---------- */
const cache = new Map();
async function rol(req, fn) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const k = fn + ":" + token, c = cache.get(k);
  if (c && c.t > Date.now()) return c.v;
  let v = false;
  try {
    const r = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: CFG.supabaseKey, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: "{}",
    });
    v = r.ok && (await r.json()) === true;
  } catch (_) {}
  cache.set(k, { v, t: Date.now() + 60_000 });
  if (cache.size > 2000) cache.clear();
  return v;
}
const esAdmin = (req) => rol(req, "st_es_admin");
const esMiembro = (req) => rol(req, "st_es_miembro");

/* ---------- Procesamiento con ffmpeg (uno a la vez) ---------- */
const cola = [];
let trabajando = false;
function encolar(id) { if (!cola.includes(id)) cola.push(id); siguiente(); }
async function siguiente() {
  if (trabajando || !cola.length) return;
  trabajando = true;
  const id = cola.shift();
  try { await procesar(id); } catch (err) {
    console.error(`[${id}] error:`, err.message);
    const e = await leerEstado(id).catch(() => ({}));
    await guardarEstado(id, { ...e, estado: "error", error: err.message }).catch(() => {});
  }
  trabajando = false;
  siguiente();
}
function ejecutar(cmd, args, onLine) {
  return new Promise((ok, mal) => {
    const p = spawn(cmd, args);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); onLine && onLine(String(d)); });
    p.on("error", mal);
    p.on("close", (c) => (c === 0 ? ok(out) : mal(new Error(`${cmd} terminó con código ${c}: ${err.slice(-400)}`))));
  });
}
async function procesar(id) {
  const dir = path.join(DIR_VID, id), hls = path.join(dir, "hls");
  const e = await leerEstado(id);
  const src = path.join(dir, e.archivo);
  const info = JSON.parse(await ejecutar("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", src]));
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  if (!v) throw new Error("El archivo no tiene pista de video");
  const dur = Number(info.format.duration) || 0;
  const copiable = v.codec_name === "h264" && /yuv420p/.test(v.pix_fmt || "") && (!a || a.codec_name === "aac");
  const copiar = CFG.modo === "copy" ? copiable : CFG.modo === "auto" ? copiable : false;
  const alto = CFG.modo === "480p" ? 480 : 720;
  await fsp.rm(hls, { recursive: true, force: true });
  await fsp.mkdir(hls, { recursive: true });
  await guardarEstado(id, { ...e, estado: "procesando", progreso: 0, duracion: Math.round(dur), modo: copiar ? "copia" : `${alto}p` });
  console.log(`[${id}] procesando (${copiar ? "copia directa" : "conversión a " + alto + "p"})…`);

  const args = ["-y", "-hide_banner", "-i", src];
  if (copiar) args.push("-map", "0:v:0", "-map", "0:a:0?", "-c", "copy");
  else args.push("-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-vf", `scale=-2:'min(${alto},ih)'`, "-pix_fmt", "yuv420p", "-g", "48", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2");
  args.push("-f", "hls", "-hls_time", "6", "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(hls, "seg_%05d.ts"), path.join(hls, "index.m3u8"));

  let ultimo = 0;
  await ejecutar("ffmpeg", args, (line) => {
    const m = line.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
    if (!m || !dur) return;
    const t = +m[1] * 3600 + +m[2] * 60 + +m[3];
    const p = Math.min(99, Math.floor((t / dur) * 100));
    if (p !== ultimo && Date.now()) { ultimo = p; guardarEstado(id, { ...e, estado: "procesando", progreso: p, duracion: Math.round(dur), modo: copiar ? "copia" : `${alto}p` }).catch(() => {}); }
  });
  const seg = Math.min(10, dur / 3 || 1).toFixed(2);
  await ejecutar("ffmpeg", ["-y", "-hide_banner", "-ss", seg, "-i", src, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", path.join(dir, "thumb.jpg")]).catch(() => {});
  if (!CFG.conservarOriginal) await fsp.rm(src, { force: true });
  await guardarEstado(id, { ...e, estado: "listo", progreso: 100, duracion: Math.round(dur), modo: copiar ? "copia" : `${alto}p` });
  console.log(`[${id}] listo`);
}

/* ---------- Archivos estáticos ---------- */
function servirArchivo(req, res, file, cache = "no-cache") {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: "No encontrado" });
    res.writeHead(200, { "Content-Type": TIPOS[path.extname(file)] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": cache });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
function servirIndex(res) {
  fs.readFile(CFG.indexHtml, "utf8", (err, html) => {
    if (err) return json(res, 404, { error: "No encontré index.html. Revisa INDEX_HTML en .env" });
    // Marca la página como servida desde el servidor local: los videos se piden a este mismo origen
    html = html.replace("<head>", "<head><script>window.__SALA_LOCAL=1</script>");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(html);
  });
}

/* ---------- Rutas ---------- */
const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://x");
  const p = url.pathname.split("/").filter(Boolean);
  try {
    // Página de Sala (para verla en la red local)
    if (url.pathname === "/" || url.pathname === "/index.html") return servirIndex(res);
    if (url.pathname === "/api/ping") return json(res, 200, { ok: true, servicio: "sala-local", version: 1 });

    // Miniaturas (públicas)
    if (p[0] === "thumb" && p.length === 2) {
      const id = p[1].replace(/\.jpg$/, "");
      if (!ID_RE.test(id)) return json(res, 400, { error: "ID inválido" });
      return servirArchivo(req, res, path.join(DIR_VID, id, "thumb.jpg"), "public, max-age=86400");
    }

    // Video HLS firmado: /hls/<exp>/<firma>/<id>/<archivo>
    if (p[0] === "hls" && p.length === 5) {
      const [, exp, sig, id, file] = p;
      if (!ID_RE.test(id) || !/^(index\.m3u8|seg_\d{5}\.ts)$/.test(file)) return json(res, 400, { error: "Ruta inválida" });
      if (Number(exp) < Date.now() / 1000) return json(res, 403, { error: "Enlace vencido" });
      const esperado = firmar(id, exp);
      if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return json(res, 403, { error: "Firma inválida" });
      return servirArchivo(req, res, path.join(DIR_VID, id, "hls", file), file.endsWith(".ts") ? "private, max-age=86400" : "no-cache");
    }

    if (p[0] !== "api") return json(res, 404, { error: "No encontrado" });

    // Firmar reproducción (miembros)
    if (p[1] === "firmar" && p[2] && req.method === "POST") {
      const id = p[2];
      if (!ID_RE.test(id)) return json(res, 400, { error: "ID inválido" });
      if (!(await esMiembro(req))) return json(res, 403, { error: "No tienes acceso a este video." });
      const e = await leerEstado(id).catch(() => null);
      if (!e) return json(res, 404, { error: "El video no existe en el servidor local." });
      if (e.estado !== "listo") return json(res, 409, { error: e.estado === "error" ? "El video falló al procesarse." : `El video se está procesando (${e.progreso || 0} %). Intenta en unos minutos.`, estado: e.estado, progreso: e.progreso || 0 });
      const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
      return json(res, 200, { url: `/hls/${exp}/${firmar(id, exp)}/${id}/index.m3u8`, duracion: e.duracion });
    }

    // Estado de un video (miembros)
    if (p[1] === "videos" && p[2] && req.method === "GET") {
      if (!ID_RE.test(p[2])) return json(res, 400, { error: "ID inválido" });
      if (!(await esMiembro(req))) return json(res, 403, { error: "Sin acceso" });
      const e = await leerEstado(p[2]).catch(() => null);
      return e ? json(res, 200, { estado: e.estado, progreso: e.progreso || 0, duracion: e.duracion || null, error: e.error }) : json(res, 404, { error: "No existe" });
    }

    // A partir de aquí, solo administradores
    if (!(await esAdmin(req))) return json(res, 403, { error: "Solo los administradores pueden hacer esto." });

    if (p[1] === "espacio" && req.method === "GET") {
      const st = await fsp.statfs(CFG.data);
      return json(res, 200, { libreGB: +(st.bavail * st.bsize / 1e9).toFixed(1), totalGB: +(st.blocks * st.bsize / 1e9).toFixed(1) });
    }

    // Subida por partes: POST /api/subidas -> PUT /api/subidas/:id (x-offset) -> POST /api/subidas/:id/terminar
    if (p[1] === "subidas") {
      if (req.method === "POST" && p.length === 2) {
        const b = await leerJson(req);
        const size = Number(b.size);
        if (!size || size <= 0) return json(res, 400, { error: "Tamaño inválido" });
        const st = await fsp.statfs(CFG.data);
        if (st.bavail * st.bsize < size * 2.2) return json(res, 507, { error: "No hay suficiente espacio en el disco del servidor." });
        const id = nuevoId();
        const ext = (path.extname(String(b.name || "")).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || [".mp4"])[0];
        await fsp.writeFile(path.join(DIR_UP, id + ".json"), JSON.stringify({ size, ext, nombre: String(b.name || "").slice(0, 200) }));
        await fsp.writeFile(path.join(DIR_UP, id + ".part"), "");
        return json(res, 200, { id, offset: 0 });
      }
      const id = p[2];
      if (!ID_RE.test(id || "")) return json(res, 400, { error: "ID inválido" });
      const metaFile = path.join(DIR_UP, id + ".json"), part = path.join(DIR_UP, id + ".part");
      const meta = JSON.parse(await fsp.readFile(metaFile, "utf8").catch(() => "null"));
      if (!meta) return json(res, 404, { error: "Subida no encontrada" });
      const actual = (await fsp.stat(part)).size;

      if (req.method === "GET" && p.length === 3) return json(res, 200, { offset: actual, size: meta.size });

      if (req.method === "PUT" && p.length === 3) {
        if (Number(req.headers["x-offset"]) !== actual) { req.resume(); return json(res, 409, { error: "Offset distinto", offset: actual }); }
        let recibido = 0;
        await new Promise((ok, mal) => {
          const w = fs.createWriteStream(part, { flags: "a" });
          req.on("data", (c) => { recibido += c.length; if (actual + recibido > meta.size) { req.destroy(); mal(new Error("Más datos de los esperados")); } });
          req.pipe(w);
          w.on("finish", ok); w.on("error", mal); req.on("error", mal);
        });
        return json(res, 200, { offset: actual + recibido });
      }

      if (req.method === "POST" && p[3] === "terminar") {
        if (actual !== meta.size) return json(res, 400, { error: `La subida está incompleta (${actual} de ${meta.size} bytes).` });
        const dir = path.join(DIR_VID, id);
        await fsp.mkdir(dir, { recursive: true });
        const archivo = "original" + meta.ext;
        await fsp.rename(part, path.join(dir, archivo));
        await fsp.rm(metaFile, { force: true });
        await guardarEstado(id, { estado: "en cola", progreso: 0, archivo, nombre: meta.nombre, creado: new Date().toISOString() });
        encolar(id);
        return json(res, 200, { id, estado: "en cola" });
      }
    }

    if (p[1] === "videos" && p[2] && req.method === "DELETE") {
      if (!ID_RE.test(p[2])) return json(res, 400, { error: "ID inválido" });
      await fsp.rm(path.join(DIR_VID, p[2]), { recursive: true, force: true });
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "Ruta no encontrada" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
});

/* ---------- Arranque ---------- */
(async () => {
  // Reanudar videos que quedaron a medias si se apagó el equipo
  for (const id of await fsp.readdir(DIR_VID)) {
    const e = await leerEstado(id).catch(() => null);
    if (e && (e.estado === "en cola" || e.estado === "procesando") && fs.existsSync(path.join(DIR_VID, id, e.archivo))) encolar(id);
  }
  // Limpiar subidas abandonadas (más de 2 días)
  for (const f of await fsp.readdir(DIR_UP)) {
    const st = await fsp.stat(path.join(DIR_UP, f)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 2 * 86400_000) await fsp.rm(path.join(DIR_UP, f), { force: true });
  }
  server.requestTimeout = 0;
  server.listen(CFG.port, "0.0.0.0", () => {
    console.log(`Sala · servidor local escuchando en el puerto ${CFG.port}`);
    console.log(`Videos en: ${CFG.data}  ·  modo: ${CFG.modo}`);
  });
})();
