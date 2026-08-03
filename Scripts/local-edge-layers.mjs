#!/usr/bin/env node
/**
 * Local stand-in for flora-s.net edge layers:
 *   - CDN/nginx: reject PUT with HTML 405 (Selectel-style)
 *   - nginx ?b= build-id gate on / and /login (VPS remote-bootstrap)
 *
 * Usage:
 *   node Scripts/local-edge-layers.mjs
 *   FLORA_EDGE_PORT=8080 FLORA_EDGE_UPSTREAM=http://127.0.0.1:3000 \
 *     FLORA_EDGE_BUILD_ID=local-edge-1 node Scripts/local-edge-layers.mjs
 *
 * FLORA_EDGE_BLOCK_PUT=0  — disable PUT block
 * FLORA_EDGE_BUILD_ID=    — disable ?b= redirects (default empty)
 */
import http from "node:http";
import { URL } from "node:url";

const port = Number(process.env.FLORA_EDGE_PORT || 8080);
const upstreamRaw = (process.env.FLORA_EDGE_UPSTREAM || "http://127.0.0.1:3000").replace(/\/+$/, "");
const buildId = (process.env.FLORA_EDGE_BUILD_ID || "").trim();
const blockPut = process.env.FLORA_EDGE_BLOCK_PUT !== "0";

const upstream = new URL(upstreamRaw);

function nginx405(res) {
  const body =
    "<html>\r\n<head><title>405 Not Allowed</title></head>\r\n" +
    "<body>\r\n<center><h1>405 Not Allowed</h1></center>\r\n" +
    "<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";
  res.writeHead(405, {
    "Content-Type": "text/html",
    "Content-Length": Buffer.byteLength(body),
    Allow: "GET, HEAD, POST, PATCH, DELETE, OPTIONS",
    Server: "nginx",
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    "Content-Length": 0,
  });
  res.end();
}

function maybeBuildBust(req, res) {
  if (!buildId) return false;
  const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (u.pathname === "/") {
    redirect(res, `/login?b=${encodeURIComponent(buildId)}`);
    return true;
  }
  if (u.pathname === "/login" && u.searchParams.get("b") !== buildId) {
    redirect(res, `/login?b=${encodeURIComponent(buildId)}`);
    return true;
  }
  return false;
}

function proxyRequest(req, res) {
  const headers = { ...req.headers, host: upstream.host };
  delete headers["accept-encoding"];

  const opts = {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
    path: req.url,
    method: req.method,
    headers,
  };

  const upstreamReq = http.request(opts, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstreamReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end(`edge upstream error: ${err.message}`);
  });
  req.pipe(upstreamReq);
}

const server = http.createServer((req, res) => {
  if (blockPut && (req.method || "").toUpperCase() === "PUT") {
    nginx405(res);
    return;
  }
  if (maybeBuildBust(req, res)) return;
  proxyRequest(req, res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[local-edge] http://127.0.0.1:${port} → ${upstreamRaw}`);
  console.log(`[local-edge] PUT block: ${blockPut ? "on (405 nginx)" : "off"}`);
  console.log(`[local-edge] ?b= gate: ${buildId ? buildId : "off"}`);
});
