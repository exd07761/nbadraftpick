import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./config.mjs";

const PROJECT_URL = "https://xrorluukmizmhizftjwx.supabase.co";
const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const port = Number(process.env.DRAFTP_AUTH_PORT || 4173);
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".mjs": "text/javascript; charset=utf-8" };

await loadLocalEnv(resolve(root, ".env"));

const server = createServer(async (req, res) => {
  if (req.url === "/runtime-config.json") {
    const projectUrl = process.env.DRAFTP_DEV_SUPABASE_URL ?? "";
    const anonKey = process.env.DRAFTP_DEV_SUPABASE_ANON_KEY ?? "";
    if (projectUrl !== PROJECT_URL || !anonKey) {
      res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "Development Supabase configuration is unavailable or points to the wrong project." }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ url: PROJECT_URL, anonKey, projectRef: "xrorluukmizmhizftjwx" }));
    return;
  }

  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const target = resolve(root, requested);
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, { "Content-Type": mime[extname(target)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`DraftP isolated Supabase Auth prototype: http://localhost:${port}`);
  console.log(`Pinned development project: ${PROJECT_URL}`);
});
