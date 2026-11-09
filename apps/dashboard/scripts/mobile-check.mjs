#!/usr/bin/env node
// The phone check (SPEC-dashboard Amendment 2): start `next dev` against
// staging's read-only data with the dev sign-in bypass, then visit every page
// as an iPhone 15 (WebKit) and at 1280 px (Chromium). Reports sideways scroll
// (with the elements that cause it), tables that scroll inside their card, tap
// targets under 44 px, text inputs under 16 px and browser console errors;
// writes screenshots (dark mode, as the app runs on Scott's phone) to .mobile/. The app loads its own secrets
// from SSM (SECRETS_PATH), so none pass through this script.
//
//   AWS_PROFILE=whitebirch npm run mobile:check -w trader-dashboard [-- --only /holdings]
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "playwright";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(APP, ".mobile");
const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const OWNER_EMAIL = "scott.schmalz@gmail.com"; // infra/lib/config.ts
const GOOGLE_CLIENT_ID = "944410438267-6jg5ik0qpm9t0q4430ja1kv6l3ncs7g9.apps.googleusercontent.com"; // infra/lib/config.ts (not secret)
const MIN_TAP = 44;
const MIN_INPUT_FONT = 16;
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;

const VIEWPORTS = [
  { name: "iphone15", engine: webkit, options: { ...devices["iPhone 15"], colorScheme: "dark" }, phone: true },
  { name: "desktop", engine: chromium, options: { viewport: { width: 1280, height: 800 }, colorScheme: "dark" }, phone: false },
];

function startServer() {
  const server = spawn("npx", ["next", "dev", "--webpack", "-p", String(PORT)], {
    cwd: APP,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
      SECRETS_PATH: "/trader/staging/",
      TRADING_ENV: "staging",
      DASHBOARD_URL: BASE,
      OWNER_EMAIL,
      GOOGLE_CLIENT_ID,
      DASHBOARD_DEV_EMAIL: OWNER_EMAIL,
    },
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  return { server, log: () => log };
}

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${url} didn't come up in ${ms / 1000}s`);
}

/** Visit a page, retrying when dev mode's first compile reloads it mid-navigation. */
async function visit(page, path) {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
      return;
    } catch (e) {
      if (attempt >= 4 || !/interrupted|ERR_ABORTED|frame was detached/i.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

/** Compile each route once (dev mode compiles on first request), so the browser pass sees settled pages. */
async function warm(paths) {
  for (const path of paths) await fetch(`${BASE}${path}`).catch(() => {});
}

/** Everything wrong with the current page at this viewport. */
async function audit(page, phone) {
  return page.evaluate(
    ({ phone, MIN_TAP, MIN_INPUT_FONT }) => {
      const problems = [];
      const width = document.documentElement.clientWidth;
      const scrollWidth = document.documentElement.scrollWidth;
      const describe = (el) => {
        const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".") : "";
        const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
        return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${text ? ` "${text}"` : ""}`;
      };
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      // An element is clipped (fine) if any ancestor scrolls or clips horizontally.
      const clippedByAncestor = (el) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true;
        }
        return false;
      };
      if (scrollWidth > width + 1) {
        const culprits = [...document.body.querySelectorAll("*")]
          .filter((el) => visible(el) && el.getBoundingClientRect().right > width + 1 && !clippedByAncestor(el))
          .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
          .slice(0, 3)
          .map((el) => `${describe(el)} (right edge ${Math.round(el.getBoundingClientRect().right)})`);
        problems.push(`page scrolls sideways: ${scrollWidth}px content on a ${width}px screen; widest: ${culprits.join("; ") || "unknown"}`);
      }
      // Tables that scroll sideways inside their card (phones should get cards instead).
      if (phone) {
        for (const t of document.querySelectorAll("table")) {
          const box = t.parentElement;
          if (visible(t) && box && box.scrollWidth > box.clientWidth + 1) problems.push(`table scrolls sideways (${t.scrollWidth}px in ${box.clientWidth}px): ${describe(t.querySelector("th") ?? t)}`);
        }
        // Controls (not links inside prose): menu links, buttons, toggles, and anything marked as a tap target.
        const small = [...document.querySelectorAll("nav a, button, summary, [data-tap-target]")]
          .filter(visible)
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.height < MIN_TAP || r.width < MIN_TAP;
          })
          .map((el) => {
            const r = el.getBoundingClientRect();
            return `${describe(el)} ${Math.round(r.width)}×${Math.round(r.height)}`;
          });
        if (small.length) problems.push(`${small.length} tap target(s) under ${MIN_TAP}px: ${small.slice(0, 4).join("; ")}${small.length > 4 ? "; …" : ""}`);
        // Charts need room to read: at least 280 px of plot (the grid's width).
        for (const grid of document.querySelectorAll(".recharts-cartesian-grid")) {
          const w = grid.getBoundingClientRect().width;
          if (w > 0 && w < 280) problems.push(`chart plot only ${Math.round(w)}px wide (want 280+)`);
        }
        for (const input of document.querySelectorAll("input:not([type=hidden]), textarea, select")) {
          const size = parseFloat(getComputedStyle(input).fontSize);
          if (visible(input) && size < MIN_INPUT_FONT) problems.push(`input under ${MIN_INPUT_FONT}px (${size}px, iOS zooms on focus): ${describe(input)}`);
        }
      }
      return problems;
    },
    { phone, MIN_TAP, MIN_INPUT_FONT },
  );
}

/** The pages to check, including one strategy version and one thesis found from the app itself. */
async function pageList(browser) {
  const page = await browser.newPage();
  const href = async (path, pattern) => {
    await visit(page, path);
    const links = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
    return links.find((h) => h && pattern.test(h)) ?? null;
  };
  const version = await href("/strategy", /^\/strategy\/\d+$/);
  const thesis = await href("/track-record", /^\/theses\/[a-z0-9-]+$/);
  await page.close();
  return [
    "/",
    "/holdings",
    "/money",
    // The confirmation step only renders on a GET; nothing is queued without its POST form.
    "/money/confirm?kind=cancel",
    "/money/confirm?kind=request&amount=500",
    "/strategy",
    ...(version ? [version] : []),
    "/track-record",
    "/activity",
    ...(thesis ? [thesis, `${thesis}?range=1y`] : []),
    "/login",
  ];
}

const { server, log } = startServer();
let failed = 0;
try {
  console.error(`starting next dev on :${PORT} (staging data, dev sign-in)…`);
  await waitFor(`${BASE}/login`, 120_000);
  await warm(["/", "/holdings", "/money", "/strategy", "/track-record", "/activity", "/login"]);
  rmSync(OUT, { recursive: true, force: true });
  let pages = null;
  for (const vp of VIEWPORTS) {
    const browser = await vp.engine.launch();
    const context = await browser.newContext(vp.options);
    pages ??= await pageList(context);
    const list = only ? pages.filter((p) => p.startsWith(only)) : pages;
    await warm(list);
    mkdirSync(join(OUT, vp.name), { recursive: true });
    console.log(`\n${vp.name} (${vp.options.viewport.width}×${vp.options.viewport.height})`);
    for (const path of list) {
      const page = await context.newPage();
      const errors = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text().replace(/\s+/g, " ").slice(0, 200)));
      page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
      await visit(page, path);
      const problems = [...(await audit(page, vp.phone)), ...[...new Set(errors)].map((e) => `console error: ${e}`)];
      const file = `${path.replace(/^\//, "").replace(/[/?=]/g, "_") || "overview"}.png`;
      await page.screenshot({ path: join(OUT, vp.name, file), fullPage: true });
      await page.close();
      failed += problems.length;
      console.log(`  ${problems.length ? "FAIL" : "ok  "} ${path}`);
      for (const p of problems) console.log(`         - ${p}`);
    }
    await browser.close();
  }
  console.log(`\n${failed ? `${failed} problem(s)` : "all clear"}; screenshots in ${OUT}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  console.error(log().split("\n").slice(-20).join("\n"));
  failed ||= 1;
} finally {
  server.kill("SIGTERM");
}
process.exit(failed ? 1 : 0);
