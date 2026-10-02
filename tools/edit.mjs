#!/usr/bin/env node
// Local editor for the Living Archive.
// Serves the site at http://localhost:4321 and lets the page write to disk:
//   PUT  /api/manifest  saves archive-manifest.json (with rolling backups)
//   POST /api/upload    stores a file under files/week-NN/ (and a preview in posters/ for PDFs and video)
//   POST /api/publish   git add + commit + push, so Vercel redeploys
//   GET  /api/meta      reads a link's title and preview image
// The public site has no /api, so it stays read-only.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "archive-manifest.json");
const FILES = path.join(ROOT, "files");
const BACKUPS = path.join(ROOT, ".archive-backups");
const PORT = Number(process.env.PORT) || 4321;
const GIT_LIMIT = 95 * 1024 * 1024; // GitHub rejects files over 100 MB
const BACKUP_EVERY = 10 * 60 * 1000;
const KEEP_BACKUPS = 60;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".pdf": "application/pdf", ".mp4": "video/mp4", ".mov": "video/quicktime",
  ".webm": "video/webm", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8"
};

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

// Writes must come from this page: a custom header forces a CORS preflight that we never approve,
// and the Host check stops DNS-rebinding pages from reaching the API.
function trusted(req) {
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  if (!["localhost", "127.0.0.1"].includes(host)) return false;
  if (req.headers["x-archive"] !== "1") return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("Body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

let lastBackup = 0;
async function backup() {
  if (Date.now() - lastBackup < BACKUP_EVERY || !fs.existsSync(MANIFEST)) return;
  lastBackup = Date.now();
  await fsp.mkdir(BACKUPS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await fsp.copyFile(MANIFEST, path.join(BACKUPS, `manifest-${stamp}.json`));
  const old = (await fsp.readdir(BACKUPS)).filter(f => f.startsWith("manifest-")).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) await fsp.unlink(path.join(BACKUPS, f));
}

async function saveManifest(req, res) {
  const body = await readBody(req, 50 * 1024 * 1024);
  let data;
  try { data = JSON.parse(body.toString("utf8")); } catch { return json(res, 400, { error: "Invalid JSON" }); }
  if (!data || !Array.isArray(data.items) || !Array.isArray(data.weeks)) return json(res, 400, { error: "Not an archive manifest" });
  await backup();
  const tmp = MANIFEST + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 1) + "\n");
  await fsp.rename(tmp, MANIFEST);
  json(res, 200, { ok: true, items: data.items.length });
}

function safeName(name) {
  const base = path.basename(String(name || "file")).normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const ext = path.extname(base).toLowerCase().replace(/[^.a-z0-9]/g, "");
  const stem = base.slice(0, base.length - path.extname(base).length)
    .replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "file";
  return stem + ext;
}

async function upload(req, res, url) {
  const week = String(url.searchParams.get("week") || "").replace(/\D/g, "").padStart(2, "0") || "00";
  const dir = path.join(FILES, `week-${week}`);
  await fsp.mkdir(dir, { recursive: true });
  let name = safeName(url.searchParams.get("name"));
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${stem}-${n}${ext}`;
  const dest = path.join(dir, name);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    req.pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
    req.on("error", reject);
  });
  const size = (await fsp.stat(dest)).size;
  const rel = path.relative(ROOT, dest).split(path.sep).join("/");
  const poster = await makePoster(dest);
  json(res, 200, {
    path: rel, size, poster,
    warning: size > GIT_LIMIT ? `${name} is ${(size / 1048576).toFixed(0)} MB. GitHub rejects files over 100 MB, so compress it before publishing.` : ""
  });
}

// Reads a page's title and preview image so pasted links arrive with real names and thumbnails.
async function meta(res, url) {
  const target = url.searchParams.get("url") || "";
  if (!/^https?:\/\//i.test(target)) return json(res, 400, { error: "Bad url" });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(target, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (Macintosh) LivingArchive/1.0", "Accept": "text/html" } });
    if (!/text\/html/.test(r.headers.get("content-type") || "")) return json(res, 200, {});
    const html = (await r.text()).slice(0, 1_000_000);
    const tag = (attr, name) => {
      const re = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*>`, "i");
      const m = html.match(re);
      const c = m && m[0].match(/content=["']([^"']*)["']/i);
      return c ? decode(c[1]) : "";
    };
    const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
    const image = tag("property", "og:image") || tag("name", "twitter:image");
    json(res, 200, {
      title: (tag("property", "og:title") || tag("name", "twitter:title") || decode(titleTag)).trim(),
      site: tag("property", "og:site_name"),
      image: image ? new URL(image, r.url).href : ""
    });
  } catch {
    json(res, 200, {});
  } finally {
    clearTimeout(timer);
  }
}
function decode(s) {
  return String(s).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function run(cmd, args) {
  return new Promise(resolve => execFile(cmd, args, { timeout: 60000 }, err => resolve(!err)));
}

// First page of a PDF or a frame of a video, saved as files/week-NN/posters/<name>.jpg (macOS tools).
async function makePoster(file) {
  if (process.platform !== "darwin" || !/\.(pdf|mp4|mov|m4v|webm)$/i.test(file)) return "";
  const dir = path.join(path.dirname(file), "posters");
  const out = path.join(dir, path.basename(file, path.extname(file)) + ".jpg");
  await fsp.mkdir(dir, { recursive: true });
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "poster-"));
  try {
    let png = "";
    if (/\.pdf$/i.test(file) || !(await run("ffmpeg", ["-loglevel", "error", "-y", "-ss", "1", "-i", file, "-frames:v", "1", "-vf", "scale=1400:-2", path.join(tmp, "f.png")]))) {
      if (await run("qlmanage", ["-t", "-s", "1400", "-o", tmp, file])) png = path.join(tmp, path.basename(file) + ".png");
    } else png = path.join(tmp, "f.png");
    if (!png || !fs.existsSync(png)) return "";
    if (!(await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "82", png, "--out", out]))) return "";
    return path.relative(ROOT, out).split(path.sep).join("/");
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

function git(args) {
  return new Promise(resolve => {
    execFile("git", args, { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout + stderr).trim() }));
  });
}

async function publish(req, res) {
  const body = JSON.parse((await readBody(req, 10000)).toString("utf8") || "{}");
  const message = String(body.message || "Update living archive").slice(0, 200);
  const add = await git(["add", "--", "archive-manifest.json", "files"]);
  if (!add.ok) return json(res, 500, { ok: false, step: "add", out: add.out });
  const staged = await git(["diff", "--cached", "--quiet"]);
  if (staged.ok) return json(res, 200, { ok: true, out: "Nothing new to publish." });
  const commit = await git(["commit", "-m", message]);
  if (!commit.ok) return json(res, 500, { ok: false, step: "commit", out: commit.out });
  const push = await git(["push"]);
  json(res, push.ok ? 200 : 500, { ok: push.ok, step: "push", out: push.ok ? "Published. Vercel will redeploy in a minute." : push.out });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  if (rel.split("/").some(s => s.startsWith("."))) return json(res, 404, { error: "Not found" });
  let file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) return json(res, 403, { error: "Forbidden" });
  if (!path.extname(file) && fs.existsSync(file + ".html")) file += ".html";
  let stat;
  try { stat = await fsp.stat(file); } catch { return json(res, 404, { error: "Not found" }); }
  if (!stat.isFile()) return json(res, 404, { error: "Not found" });
  const headers = { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store", "Accept-Ranges": "bytes" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range) {
    const start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) { res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": stat.size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api/status") return json(res, 200, { edit: true });
    if (url.pathname.startsWith("/api/")) {
      if (!trusted(req)) return json(res, 403, { error: "Forbidden" });
      if (url.pathname === "/api/meta" && req.method === "GET") return await meta(res, url);
      if (url.pathname === "/api/manifest" && req.method === "PUT") return await saveManifest(req, res);
      if (url.pathname === "/api/upload" && req.method === "POST") return await upload(req, res, url);
      if (url.pathname === "/api/publish" && req.method === "POST") return await publish(req, res);
      return json(res, 404, { error: "Unknown endpoint" });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed" });
    await serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const link = `http://localhost:${PORT}`;
  console.log(`\n  Living Archive editor running at ${link}`);
  console.log("  Changes save to archive-manifest.json and files/. Press Ctrl+C to stop.\n");
  if (process.platform === "darwin" && !process.env.NO_OPEN && !process.argv.includes("--no-open")) execFile("open", [link]);
});
