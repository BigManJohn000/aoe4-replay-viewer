// Zero-dependency static file server for the replay viewer.
// ES modules and GLTFLoader fetches do not work from file://, so open the viewer through this.
//   node serve.mjs [port]      ->  http://127.0.0.1:8080/
// It listens on this PC only (127.0.0.1) and answers only requests addressed to 127.0.0.1:<port> or localhost:<port>,
// so neither other devices on the network nor other websites (by DNS tricks) can reach it.
// The 2D viewer folder is served read-only under /shared/: the recordings (data/, notes/) and the scripts both pages
// run (units.js, model.js, ...), so the 3D page reads the same model and the Trends page and 2D viewer open from it.
// Its folder defaults to ../viewer (the Fusion root's 2D viewer); set RV_2D_VIEWER to move it.
// /api/* is passed through to the 2D project's Replay Recorder (tools/recorder_app.py, 127.0.0.1:47811), so the 3D
// page can add aoe4world matches, follow their recording and open the game ("Watch in game") on its own address.
// /tweaks.json holds the inspector's per-blueprint model tweaks (scale, Y offset): GET reads it ({} when absent), PUT
// from this page replaces it (validated, written atomically), so the tweaks survive reloads and other browsers.
// /shared/notes.json lists the recordings that have key-moment notes (notes/<name>.js).
import { createServer, request } from "node:http";
import { createReadStream, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const VIEWER_2D = resolve(process.env.RV_2D_VIEWER || join(ROOT, "..", "viewer"));
const MOUNTS = [ // URL prefix → folder (prefix ending in /) or file
  ["/shared/", VIEWER_2D],
];
const HOST = "127.0.0.1";
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const SELF = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]); // Host headers this server answers
const RECORDER = { host: "127.0.0.1", port: 47811 };              // Replay Recorder (it answers only its own Host)
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".ktx2": "image/ktx2",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** URL path → file under its mount (else ROOT), or null when it escapes that folder. */
function fileFor(pathname) {
  let base = ROOT, rest = pathname;
  for (const [prefix, target] of MOUNTS) {
    if (pathname === prefix) return target;
    if (prefix.endsWith("/") && pathname.startsWith(prefix)) { base = target; rest = pathname.slice(prefix.length); break; }
  }
  const path = normalize(join(base, rest));
  return path === base || path.startsWith(base + sep) ? path : null;
}

/**
 * /api/* → Replay Recorder, addressed as itself. Requests from other websites are refused here (a browser names the
 * page's origin on cross-site requests), on top of the Recorder's own rule that commands are JSON. Recorder not
 * running → 502 {offline: true}.
 */
function passToRecorder(req, res, url) {
  const origin = req.headers.origin;
  if (origin && !SELF.has(origin.replace(/^http:\/\//, ""))) {
    res.writeHead(403).end();
    return;
  }
  const headers = { host: `${RECORDER.host}:${RECORDER.port}` };
  for (const h of ["content-type", "content-length", "accept"]) if (req.headers[h]) headers[h] = req.headers[h];
  const up = request({ ...RECORDER, method: req.method, path: url.pathname + url.search, headers }, (r) => {
    const out = { "Content-Type": r.headers["content-type"] || "text/plain; charset=utf-8", "Cache-Control": "no-store" };
    if (r.headers["content-length"]) out["Content-Length"] = r.headers["content-length"];
    res.writeHead(r.statusCode, out);
    r.pipe(res);
  });
  up.setTimeout(60000, () => up.destroy(new Error("Replay Recorder did not answer")));
  up.on("error", () => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
      .end(JSON.stringify({ offline: true, error: "Replay Recorder is not running. Double-click “Replay Recorder.bat” in the 2D project folder." }));
  });
  req.pipe(up);
}

const TWEAKS = join(ROOT, "tweaks.json");
const TWEAK_MAX = 256 * 1024; // bytes a PUT may carry
/** A tweak map as the page sends it: { key: { scale: 0.25–3, y: −2–2 } }, key a blueprint or `#replay/entityId`; else null. */
function validTweaks(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  for (const [bp, t] of Object.entries(v)) {
    if (!/^(?:[\w.-]{1,160}|#[\w.-]{1,160}\/\d{1,16})$/.test(bp) || !t || typeof t !== "object") return null;
    const { scale, y } = t;
    if (!Number.isFinite(scale) || scale < 0.25 || scale > 3 || !Number.isFinite(y) || y < -2 || y > 2) return null;
    out[bp] = { scale, y };
  }
  return out;
}
/** GET /tweaks.json → the saved map ({} when none); PUT (this page only, JSON) → replace it. */
function tweaks(req, res) {
  const json = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  if (req.method === "GET") {
    res.writeHead(200, json).end(existsSync(TWEAKS) ? readFileSync(TWEAKS) : "{}");
    return;
  }
  const origin = req.headers.origin;
  if (req.method !== "PUT" || (origin && !SELF.has(origin.replace(/^http:\/\//, ""))) || !/^application\/json\b/.test(req.headers["content-type"] || "")) {
    res.writeHead(403).end();
    return;
  }
  const parts = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > TWEAK_MAX) { res.writeHead(413).end(); req.destroy(); } else parts.push(c);
  });
  req.on("end", () => {
    if (res.headersSent) return;
    let v = null;
    try { v = validTweaks(JSON.parse(Buffer.concat(parts).toString("utf8"))); } catch { /* not JSON */ }
    if (!v) { res.writeHead(400, json).end('{"error":"bad tweaks"}'); return; }
    writeFileSync(TWEAKS + ".tmp", JSON.stringify(v, null, 1));
    renameSync(TWEAKS + ".tmp", TWEAKS);
    res.writeHead(200, json).end(JSON.stringify({ saved: Object.keys(v).length }));
  });
}

const server = createServer((req, res) => {
  if (!SELF.has(req.headers.host || "")) {
    res.writeHead(403).end();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    passToRecorder(req, res, url);
    return;
  }
  if (url.pathname === "/shared/notes.json") { // which recordings have key-moment notes (a probe for a missing one would 404 in the console)
    let names = [];
    try { names = readdirSync(join(VIEWER_2D, "notes")).filter((n) => n.endsWith(".js")).map((n) => n.slice(0, -3)); } catch { /* none */ }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" }).end(JSON.stringify(names));
    return;
  }
  if (url.pathname === "/tweaks.json") {
    tweaks(req, res);
    return;
  }
  let path = fileFor(decodeURIComponent(url.pathname));
  if (!path) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (statSync(path).isDirectory()) path = join(path, "index.html");
    const size = statSync(path).size;
    res.writeHead(200, {
      "Content-Type": TYPES[extname(path).toLowerCase()] || "application/octet-stream",
      "Content-Length": size,
      "Cache-Control": "no-cache",
    });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("404 " + url.pathname);
  }
});
server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is already in use (is the viewer already running?)` : e.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`Replay viewer: http://127.0.0.1:${PORT}/  (this PC only)`);
  console.log(`Shared recordings: ${VIEWER_2D}${existsSync(join(VIEWER_2D, "units.js")) ? "" : "  (NOT FOUND: set RV_2D_VIEWER)"}`);
  console.log(`Replay Recorder pass-through: /api/ → http://${RECORDER.host}:${RECORDER.port}/`);
});
