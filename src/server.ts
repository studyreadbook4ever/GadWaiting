#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const publicDir = join(projectRoot, "public");
const preferredPort = Number(process.env.PORT || readArg("--port") || 4173);

const server = createServer((request, response) => {
  void handle(request, response).catch((error) => {
    console.error(error);
    sendText(response, 500, "Internal Server Error");
  });
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === "/" || url.pathname === "/demo") {
    await sendFile(response, join(publicDir, "index.html"));
    return;
  }

  if (url.pathname === "/gadwaiting.js") {
    const output = await readBrowserBundle();
    send(response, 200, output, "application/javascript; charset=utf-8", "no-store");
    return;
  }

  if (url.pathname === "/demo-config.json") {
    const config = await createDemoConfig(url);
    send(response, 200, JSON.stringify(config, null, 2), "application/json; charset=utf-8", "no-store");
    return;
  }

  if (url.pathname === "/mock-ad-script.js") {
    sendMockProviderScript(response, url);
    return;
  }

  if (url.pathname.startsWith("/house-ads/")) {
    const filePath = safePublicPath(url.pathname);
    if (!filePath) {
      sendText(response, 403, "Forbidden");
      return;
    }
    await sendFile(response, filePath);
    return;
  }

  if (url.pathname === "/favicon.ico") {
    sendText(response, 204, "");
    return;
  }

  sendText(response, 404, "Not Found");
}

async function createDemoConfig(url: URL): Promise<unknown> {
  const raw = await readFile(join(projectRoot, "gadwaiting.config.json"), "utf8");
  const config = JSON.parse(raw);
  const mock = url.searchParams.get("mock") ?? "down";
  const down = mock === "down" ? "1" : "0";
  const fill = mock === "unfilled" ? "0" : "1";
  const mockScript = `/mock-ad-script.js?down=${down}&fill=${fill}&latency=220`;

  config.check = {
    ...(config.check ?? {}),
    endpoint: mockScript,
    intervalMs: url.searchParams.get("fast") === "1" ? 5000 : config.check?.intervalMs ?? 60000,
    timeoutMs: 1000
  };

  for (const slot of config.slots) {
    slot.provider.scriptUrl = mockScript;
    slot.provider.client = "ca-pub-1234567890123456";
    slot.provider.testMode = "on";
  }

  return config;
}

function sendMockProviderScript(response: ServerResponse, url: URL): void {
  if (url.searchParams.get("down") === "1") {
    sendText(response, 503, "mock ad network unavailable", "no-store");
    return;
  }

  const fill = url.searchParams.get("fill") !== "0";
  const latency = Number(url.searchParams.get("latency") ?? 220);
  const code = `(() => {
  const fill = ${JSON.stringify(fill)};
  const latency = ${JSON.stringify(Number.isFinite(latency) ? latency : 220)};
  const queue = window.adsbygoogle = window.adsbygoogle || [];
  const nativePush = Array.prototype.push;

  function renderPending() {
    document.querySelectorAll("ins.adsbygoogle:not([data-mock-provider-rendered])").forEach((ins) => {
      ins.setAttribute("data-mock-provider-rendered", "true");
      ins.setAttribute("data-adsbygoogle-status", "done");
      window.setTimeout(() => {
        if (!fill) {
          ins.setAttribute("data-ad-status", "unfilled");
          return;
        }

        ins.setAttribute("data-ad-status", "filled");
        const creative = document.createElement("div");
        creative.style.cssText = [
          "display:flex",
          "width:100%",
          "height:100%",
          "align-items:center",
          "justify-content:center",
          "background:#111827",
          "color:#fff",
          "font:700 14px/1.2 system-ui,sans-serif",
          "letter-spacing:0"
        ].join(";");
        creative.textContent = "MOCK NETWORK AD";
        ins.appendChild(creative);
      }, latency);
    });
  }

  queue.push = function pushMockProviderAd() {
    const result = nativePush.apply(queue, arguments);
    renderPending();
    return result;
  };

  renderPending();
})();`;

  send(response, 200, code, "application/javascript; charset=utf-8", "no-store");
}

async function sendFile(response: ServerResponse, path: string): Promise<void> {
  try {
    const body = await readFile(path);
    send(response, 200, body, contentType(path), "no-cache");
  } catch {
    sendText(response, 404, "Not Found");
  }
}

async function readBrowserBundle(): Promise<string> {
  const sourcePath = join(projectRoot, "src", "gadwaiting.ts");
  const builtPath = join(projectRoot, "dist", "gadwaiting.js");

  try {
    const [sourceInfo, builtInfo] = await Promise.all([stat(sourcePath), stat(builtPath)]);
    if (builtInfo.mtimeMs >= sourceInfo.mtimeMs) {
      return readFile(builtPath, "utf8");
    }
  } catch {
    // Fall back to on-demand stripping when dist has not been built yet.
  }

  const source = await readFile(sourcePath, "utf8");
  return stripTypeScriptTypes(source, {
    mode: "strip",
    sourceUrl: "gadwaiting.ts"
  });
}

function safePublicPath(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const normalized = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(publicDir, `.${normalized}`);
  return filePath.startsWith(publicDir) ? filePath : null;
}

function sendText(response: ServerResponse, status: number, text: string, cache = "no-cache"): void {
  send(response, status, text, "text/plain; charset=utf-8", cache);
}

function send(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  type: string,
  cache: string
): void {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": cache,
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

async function listen(port: number): Promise<number> {
  for (let candidate = port; candidate < port + 20; candidate += 1) {
    const opened = await tryListen(candidate);
    if (opened) {
      return candidate;
    }
  }

  throw new Error(`Could not bind any port from ${port} to ${port + 19}`);
}

function tryListen(port: number): Promise<boolean> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") {
        resolveListen(false);
        return;
      }
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = await listen(preferredPort);
console.log(`gadwaiting demo: http://127.0.0.1:${port}/?mock=down&fast=1`);
console.log(`healthy mock:          http://127.0.0.1:${port}/?mock=filled&fast=1`);
console.log(`unfilled mock:         http://127.0.0.1:${port}/?mock=unfilled&fast=1`);
