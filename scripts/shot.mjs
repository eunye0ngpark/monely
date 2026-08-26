#!/usr/bin/env node
/* shot.mjs — 真实时间渲染的 CDP 截图(不依赖 --virtual-time-budget)。
   用法: node scripts/shot.mjs <url> <outfile> [width] [height] [waitMs] */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";

const [url, outfile, width = "1440", height = "2000", waitMs = "4000"] = process.argv.slice(2);
if (!url || !outfile) { console.error("usage: node scripts/shot.mjs <url> <outfile> [w] [h] [waitMs]"); process.exit(2); }
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res(b)); }).on("error", rej));

let ws, msgId = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => { const id = ++msgId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });

const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  `--window-size=${width},${height}`, "--hide-scrollbars", `--user-data-dir=/tmp/fd-shot-profile-${Date.now()}`, "about:blank"], { stdio: "ignore" });
try {
  let targets;
  for (let i = 0; i < 30; i++) { await sleep(400); try { targets = JSON.parse(await get(`http://127.0.0.1:${PORT}/json`)); break; } catch {} }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || {}); pending.delete(m.id); } };
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: +width, height: +height, deviceScaleFactor: 1, mobile: +width < 500 });
  await send("Page.navigate", { url });
  await sleep(+waitMs);
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  fs.writeFileSync(outfile, Buffer.from(shot.data, "base64"));
  console.log("OK", outfile, fs.statSync(outfile).size, "bytes");
} finally {
  chrome.kill("SIGKILL");
}
