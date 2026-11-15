/**
 * The one email layout (SPEC-notifications § Email design). Compose functions
 * describe an email as blocks; `render` turns them into both the HTML and the
 * text part, so the two can't drift and no content string carries its own
 * bullet. Pure: no I/O, no dependencies.
 *
 * The HTML is written for Gmail first: inline styles on every element, tables
 * for anything side by side (no flex or grid), one centered column at most
 * 600px wide, and no images, web fonts or tracking. A `<style>` block adds
 * only extras a client may ignore: tighter padding on phones, and the
 * dashboard's dark palette where `prefers-color-scheme` is honoured (Apple
 * Mail; Gmail inverts on its own). The look follows the dashboard
 * (apps/dashboard/src/app/globals.css, components/ui.tsx).
 */

export type Tone = "bad" | "warn" | "good" | "neutral";

export type Block =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string; label?: string; size?: "lead" | "body" | "small"; muted?: boolean }
  | { type: "list"; items: string[] }
  | { type: "stats"; items: { label: string; value: string; detail?: string }[] }
  | { type: "table"; columns: { label: string; align?: "left" | "right" }[]; rows: string[][] }
  | { type: "card"; title: string; href?: string; badges?: string[]; tag?: string; blocks: Block[]; meta?: string }
  | { type: "callout"; tone: Tone; text: string }
  | { type: "section"; title: string; tone?: Tone; subtitle?: string; blocks: Block[] };

export interface EmailDoc {
  /** Gmail's inbox preview, under the subject. */
  preheader: string;
  title: string;
  tone?: Tone;
  subtitle?: string;
  blocks: Block[];
  /** One link to the dashboard page this email is about. */
  action?: { text: string; href: string };
  /** The last line: who wrote it and when. */
  footer: string;
}

/** The dashboard's palette (light, then dark). */
export const PALETTE = {
  page: "#f6f6f4",
  surface: "#fcfcfb",
  border: "#e3e2de",
  text: "#0b0b0b",
  muted: "#6b6a66",
  good: "#0c8a0c",
  bad: "#c43535",
  warn: "#b77400",
  dark: { page: "#131312", surface: "#1b1b1a", border: "#2e2d2b", text: "#f4f3f0", muted: "#9b9a95", good: "#3fbf5a", bad: "#e46161", warn: "#e0a33a" },
} as const;

/** Status as an icon plus a label, never colour alone (the dashboard's `Status`). */
export const TONE_ICON: Record<Tone, string> = { bad: "■", warn: "▲", good: "●", neutral: "" };

const FONT = "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Only http(s) links are rendered; anything else is dropped. */
function safeHref(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- HTML

const S = {
  text: `color:${PALETTE.text};`,
  muted: `color:${PALETTE.muted};`,
  font: `font-family:${FONT};`,
};

const toneColor = (tone: Tone) => (tone === "neutral" ? PALETTE.muted : PALETTE[tone]);
const toneClass = (tone: Tone) => (tone === "neutral" ? "t-muted" : `t-${tone}`);

function icon(tone: Tone | undefined): string {
  if (!tone || tone === "neutral") return "";
  return `<span class="${toneClass(tone)}" style="color:${toneColor(tone)};" aria-hidden="true">${TONE_ICON[tone]}</span>&nbsp;`;
}

function paragraphHtml(b: Extract<Block, { type: "paragraph" }>): string {
  const size = b.size === "lead" ? "font-size:17px;line-height:1.45;font-weight:500;" : b.size === "small" ? "font-size:13px;line-height:1.5;" : "font-size:15px;line-height:1.55;";
  const color = b.muted ? S.muted : S.text;
  const cls = b.muted ? "t-muted" : "t-text";
  const label = b.label ? `<strong style="font-weight:600;">${escapeHtml(b.label)}</strong> ` : "";
  return `<p class="${cls}" style="margin:0 0 10px;${size}${color}">${label}${escapeHtml(b.text)}</p>`;
}

function statsHtml(items: Extract<Block, { type: "stats" }>["items"]): string {
  // Three tiles to a row at most, so they fit a phone without media queries; four become two rows of two.
  const perRow = items.length === 4 ? 2 : 3;
  const rows: (typeof items)[] = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  const width = `${Math.floor(100 / Math.min(perRow, items.length))}%`;
  return rows
    .map(
      (row) =>
        `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0;margin:0 0 8px;"><tr>${row
          .map(
            (s, i) =>
              `<td width="${width}" valign="top" style="padding:0 ${i < row.length - 1 ? "8px" : "0"} 0 0;"><div class="t-inner" style="background:${PALETTE.page};border:1px solid ${PALETTE.border};border-radius:10px;padding:10px 12px;"><div class="t-muted" style="font-size:12px;line-height:1.3;font-weight:500;${S.muted}">${escapeHtml(s.label)}</div><div class="t-text" style="font-size:20px;line-height:1.3;font-weight:600;${S.text}">${escapeHtml(s.value)}</div>${s.detail ? `<div class="t-muted" style="font-size:12px;line-height:1.3;${S.muted}">${escapeHtml(s.detail)}</div>` : ""}</div></td>`,
          )
          .join("")}</tr></table>`,
    )
    .join("");
}

function tableHtml(b: Extract<Block, { type: "table" }>): string {
  const cell = (align: string | undefined, header: boolean) =>
    `padding:6px ${header ? "8px" : "8px"} 6px 0;text-align:${align ?? "left"};border-bottom:1px solid ${PALETTE.border};${header ? `font-size:12px;font-weight:500;${S.muted}` : `font-size:14px;${S.text}`}`;
  const head = b.columns.map((c) => `<th class="t-muted t-border" style="${cell(c.align, true)}">${escapeHtml(c.label)}</th>`).join("");
  const body = b.rows.map((r) => `<tr>${r.map((v, i) => `<td class="t-text t-border" style="${cell(b.columns[i]?.align, false)}">${escapeHtml(v)}</td>`).join("")}</tr>`).join("");
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:0 0 12px;font-variant-numeric:tabular-nums;"><tr>${head}</tr>${body}</table>`;
}

function badgeHtml(text: string, ink = false): string {
  return `<span class="${ink ? "t-text" : "t-muted"} t-border" style="display:inline-block;white-space:nowrap;border:1px solid ${PALETTE.border};border-radius:6px;padding:1px 6px;margin:0 0 0 6px;font-size:12px;line-height:1.5;font-weight:${ink ? 600 : 500};${ink ? S.text : S.muted}">${escapeHtml(text)}</span>`;
}

function blockHtml(b: Block): string {
  switch (b.type) {
    case "heading":
      return `<h2 class="t-muted" style="margin:18px 0 8px;font-size:14px;line-height:1.4;font-weight:600;${S.muted}">${escapeHtml(b.text)}</h2>`;
    case "paragraph":
      return paragraphHtml(b);
    case "list":
      return `<ul class="t-text" style="margin:0 0 12px;padding:0 0 0 20px;font-size:15px;line-height:1.55;${S.text}">${b.items.map((i) => `<li style="margin:0 0 4px;">${escapeHtml(i)}</li>`).join("")}</ul>`;
    case "stats":
      return statsHtml(b.items);
    case "table":
      return tableHtml(b);
    case "callout":
      return `<div class="t-inner" style="background:${PALETTE.page};border:1px solid ${PALETTE.border};border-left:3px solid ${toneColor(b.tone)};border-radius:8px;padding:10px 12px;margin:0 0 12px;font-size:15px;line-height:1.5;${S.text}">${icon(b.tone)}<span class="t-text">${escapeHtml(b.text)}</span></div>`;
    case "card": {
      const href = safeHref(b.href);
      const title = href
        ? `<a href="${escapeHtml(href)}" class="t-text" style="${S.text}text-decoration:underline;text-decoration-color:${PALETTE.border};text-underline-offset:2px;">${escapeHtml(b.title)}</a>`
        : escapeHtml(b.title);
      const badges = [...(b.badges ?? []).map((x) => badgeHtml(x, true)), ...(b.tag ? [badgeHtml(b.tag)] : [])].join("");
      const meta = b.meta ? `<p class="t-muted" style="margin:2px 0 0;font-size:13px;line-height:1.5;${S.muted}">${escapeHtml(b.meta)}</p>` : "";
      return `<div class="t-inner" style="background:${PALETTE.page};border:1px solid ${PALETTE.border};border-radius:10px;padding:12px 14px;margin:0 0 10px;"><div class="t-text" style="margin:0 0 6px;font-size:16px;line-height:1.4;font-weight:600;${S.text}">${title}${badges}</div>${b.blocks.map(blockHtml).join("")}${meta}</div>`;
    }
    case "section":
      return `<div class="t-border" style="border-top:1px solid ${PALETTE.border};margin:16px 0 0;padding:16px 0 0;"><h2 class="t-text" style="margin:0 0 2px;font-size:17px;line-height:1.35;font-weight:600;${S.text}">${icon(b.tone)}${escapeHtml(b.title)}</h2>${b.subtitle ? `<p class="t-muted" style="margin:0 0 10px;font-size:13px;line-height:1.4;${S.muted}">${escapeHtml(b.subtitle)}</p>` : ""}${b.blocks.map(blockHtml).join("")}</div>`;
  }
}

const DARK_CSS = (() => {
  const d = PALETTE.dark;
  return [
    `.t-page{background:${d.page}!important}`,
    `.t-card{background:${d.surface}!important;border-color:${d.border}!important}`,
    `.t-inner{background:${d.page}!important;border-color:${d.border}!important}`,
    `.t-border{border-color:${d.border}!important}`,
    `.t-text,.t-text a{color:${d.text}!important}`,
    `.t-muted{color:${d.muted}!important}`,
    `.t-good{color:${d.good}!important}`,
    `.t-bad{color:${d.bad}!important}`,
    `.t-warn{color:${d.warn}!important}`,
  ].join("");
})();

const STYLE = `:root{color-scheme:light dark;supported-color-schemes:light dark}@media (max-width:480px){.t-outer{padding:12px 8px!important}.t-pad{padding:16px 14px!important}}@media (prefers-color-scheme:dark){${DARK_CSS}}`;

/** Invisible filler after the preheader, so Gmail doesn't pull body text into the inbox preview. */
const PREHEADER_FILL = "&#847;&zwnj;&nbsp;".repeat(60);

export function renderHtml(doc: EmailDoc): string {
  const action = doc.action && safeHref(doc.action.href);
  return [
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(doc.title)}</title><style>${STYLE}</style></head>`,
    `<body class="t-page" style="margin:0;padding:0;background:${PALETTE.page};">`,
    `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;">${escapeHtml(doc.preheader)}${PREHEADER_FILL}</div>`,
    `<table role="presentation" class="t-page" width="100%" cellspacing="0" cellpadding="0" style="background:${PALETTE.page};${S.font}font-variant-numeric:tabular-nums;"><tr><td class="t-outer" align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;">`,
    `<tr><td class="t-muted" style="padding:0 4px 10px;font-size:13px;line-height:1.4;font-weight:600;${S.muted}">Trader</td></tr>`,
    `<tr><td class="t-card t-pad" style="background:${PALETTE.surface};border:1px solid ${PALETTE.border};border-radius:12px;padding:20px 22px;">`,
    `<h1 class="t-text" style="margin:0 0 2px;font-size:21px;line-height:1.3;font-weight:600;${S.text}">${icon(doc.tone)}${escapeHtml(doc.title)}</h1>`,
    doc.subtitle ? `<p class="t-muted" style="margin:0 0 6px;font-size:13px;line-height:1.4;${S.muted}">${escapeHtml(doc.subtitle)}</p>` : "",
    `<div style="height:8px;line-height:8px;font-size:8px;">&nbsp;</div>`,
    doc.blocks.map(blockHtml).join(""),
    action
      ? `<p style="margin:16px 0 0;"><a href="${escapeHtml(action)}" class="t-text t-border" style="display:inline-block;border:1px solid ${PALETTE.border};border-radius:8px;padding:8px 12px;font-size:14px;font-weight:600;text-decoration:none;${S.text}">${escapeHtml(doc.action!.text)} →</a></p>`
      : "",
    `</td></tr>`,
    `<tr><td class="t-muted" style="padding:12px 4px 0;font-size:12px;line-height:1.5;${S.muted}">${escapeHtml(doc.footer)}</td></tr>`,
    `</table></td></tr></table></body></html>`,
  ].join("");
}

// ---------------------------------------------------------------- text

function blockText(b: Block, indent = ""): string {
  const ind = (s: string) => s.split("\n").map((l) => (l ? indent + l : l)).join("\n");
  switch (b.type) {
    case "heading":
      return ind(b.text.toUpperCase());
    case "paragraph":
      return ind(`${b.label ? `${b.label} ` : ""}${b.text}`);
    case "list":
      return ind(b.items.map((i) => `- ${i}`).join("\n"));
    case "stats":
      return ind(b.items.map((s) => `${s.label}: ${s.value}${s.detail ? ` (${s.detail})` : ""}`).join("\n"));
    case "table": {
      const all = [b.columns.map((c) => c.label), ...b.rows];
      const widths = b.columns.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
      const line = (r: string[]) =>
        r
          .map((v, i) => (b.columns[i]?.align === "right" ? v.padStart(widths[i]!) : v.padEnd(widths[i]!)))
          .join("  ")
          .trimEnd();
      return ind(all.map(line).join("\n"));
    }
    case "callout":
      return ind(`${TONE_ICON[b.tone] ? `${TONE_ICON[b.tone]} ` : ""}${b.text}`);
    case "card": {
      const head = [b.title, ...(b.badges ?? []), ...(b.tag ? [b.tag] : [])].join(" · ");
      const body = [...b.blocks.map((x) => blockText(x, "  ")), ...(b.meta ? [`  ${b.meta}`] : []), ...(safeHref(b.href) ? [`  ${safeHref(b.href)}`] : [])];
      return ind([head, ...body].join("\n"));
    }
    case "section": {
      const head = `${b.tone && TONE_ICON[b.tone] ? `${TONE_ICON[b.tone]} ` : ""}${b.title}${b.subtitle ? ` (${b.subtitle})` : ""}`;
      return ind([head, ...b.blocks.map((x) => blockText(x))].join("\n\n"));
    }
  }
}

export function renderText(doc: EmailDoc): string {
  const action = doc.action && safeHref(doc.action.href);
  const head = `${doc.tone && TONE_ICON[doc.tone] ? `${TONE_ICON[doc.tone]} ` : ""}${doc.title}`;
  return [
    [head, ...(doc.subtitle ? [doc.subtitle] : [])].join("\n"),
    ...doc.blocks.map((b) => blockText(b)),
    ...(action ? [`${doc.action!.text}: ${action}`] : []),
    doc.footer,
  ].join("\n\n").concat("\n");
}

export function render(doc: EmailDoc): { html: string; text: string } {
  return { html: renderHtml(doc), text: renderText(doc) };
}
