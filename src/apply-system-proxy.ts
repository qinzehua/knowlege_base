/**
 * 让 Node 的 fetch / undici 走代理。
 *
 * 优先级：
 * 1. 已有 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY
 * 2. Windows 系统代理（IE / WinINET，v2rayN「系统代理」写的就是这个）
 *
 * 在任何出网请求之前调用一次即可。localhost 默认不走代理。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Logger } from "@nestjs/common";
import {
  EnvHttpProxyAgent,
  Socks5ProxyAgent,
  setGlobalDispatcher,
} from "undici";

const logger = new Logger("SystemProxy");
const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";

function loadDotEnvIfPresent(): void {
  const filePath = resolve(process.cwd(), ".env");
  if (!existsSync(filePath)) return;
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function queryWinReg(valueName: string): string | null {
  try {
    const out = execFileSync(
      "reg",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        "/v",
        valueName,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const match = out.match(new RegExp(`${valueName}\\s+REG_\\w+\\s+(\\S.+)`));
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** `127.0.0.1:10808` / `http=...;https=...` / `socks=...` → 代理 URL */
function parseWindowsProxyServer(raw: string): string | null {
  const parts = raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  let httpUri: string | null = null;
  let socksUri: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      httpUri ??= part.includes("://") ? part : `http://${part}`;
      continue;
    }
    const scheme = part.slice(0, eq).toLowerCase();
    const host = part.slice(eq + 1).replace(/^\/\//, "");
    if (scheme === "socks" || scheme === "socks5") {
      socksUri ??= `socks5://${host}`;
    } else if (scheme === "https" || scheme === "http") {
      httpUri ??= host.includes("://") ? host : `http://${host}`;
    }
  }
  return httpUri ?? socksUri;
}

function readWindowsSystemProxy(): string | null {
  if (process.platform !== "win32") return null;
  const enabled = queryWinReg("ProxyEnable");
  if (!enabled) return null;
  const on = enabled === "1" || /^0x0*1$/i.test(enabled);
  if (!on) return null;
  const server = queryWinReg("ProxyServer");
  if (!server) return null;
  return parseWindowsProxyServer(server);
}

function envProxyUrl(): string | null {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    null
  );
}

export function applySystemProxy(): string | null {
  loadDotEnvIfPresent();

  const fromEnv = envProxyUrl();
  const fromWin = fromEnv ? null : readWindowsSystemProxy();
  const proxyUrl = fromEnv || fromWin;
  if (!proxyUrl) return null;

  if (!process.env.NO_PROXY && !process.env.no_proxy) {
    const override =
      process.platform === "win32" ? queryWinReg("ProxyOverride") : null;
    const extra = override
      ? override
          .split(";")
          .map((s) => s.trim())
          .filter((s) => s && s !== "<local>")
          .join(",")
      : "";
    process.env.NO_PROXY = extra
      ? `${DEFAULT_NO_PROXY},${extra}`
      : DEFAULT_NO_PROXY;
  }

  if (!fromEnv) {
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
  }

  if (/^socks5?:\/\//i.test(proxyUrl)) {
    setGlobalDispatcher(new Socks5ProxyAgent(proxyUrl));
  } else {
    setGlobalDispatcher(
      new EnvHttpProxyAgent({
        httpProxy: process.env.HTTP_PROXY || proxyUrl,
        httpsProxy: process.env.HTTPS_PROXY || proxyUrl,
        noProxy: process.env.NO_PROXY,
      }),
    );
  }

  const src = fromEnv ? "环境变量" : "Windows 系统代理";
  logger.log(`已启用（${src}）：${proxyUrl}`);
  return proxyUrl;
}
