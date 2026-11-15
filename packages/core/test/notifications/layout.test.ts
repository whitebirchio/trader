import { describe, expect, it } from "vitest";
import { composeUrgent } from "../../src/notifications/compose.js";
import { type Block, type EmailDoc, render } from "../../src/notifications/layout.js";
import { SAMPLES } from "../../src/notifications/samples.js";

const doc = (blocks: Block[], extra: Partial<EmailDoc> = {}): EmailDoc => ({ preheader: "Preview line", title: "Title", blocks, footer: "— Trader", ...extra });

const every: Block[] = [
  { type: "heading", text: "Heading <h>" },
  { type: "paragraph", text: "Body & more", label: "Label:" },
  { type: "list", items: ["first <i>", "second"] },
  { type: "stats", items: [{ label: "In theses", value: "33%" }, { label: "In VTI", value: "67%", detail: "idle money" }] },
  { type: "table", columns: [{ label: "Symbol" }, { label: "Value", align: "right" }], rows: [["VTI", "$310.00"]] },
  { type: "card", title: "TTMI", href: "https://trader.whitebirch.io/theses/ttmi", badges: ["8%"], tag: "New", blocks: [{ type: "paragraph", text: "Circuit boards" }], meta: "Stop 25% below cost" },
  { type: "callout", tone: "bad", text: "Trading is halted" },
  { type: "section", title: "Stop-loss: selling INTC", tone: "warn", subtitle: "10:30 AM ET", blocks: [{ type: "paragraph", text: "Inside a section" }] },
];

/** Every string a block carries, for the parity check. */
function strings(b: Block): string[] {
  switch (b.type) {
    case "heading":
    case "callout":
      return [b.text];
    case "paragraph":
      return [b.text, ...(b.label ? [b.label] : [])];
    case "list":
      return b.items;
    case "stats":
      return b.items.flatMap((s) => [s.label, s.value, ...(s.detail ? [s.detail] : [])]);
    case "table":
      return [...b.columns.map((c) => c.label), ...b.rows.flat()];
    case "card":
      return [b.title, ...(b.badges ?? []), ...(b.tag ? [b.tag] : []), ...(b.meta ? [b.meta] : []), ...b.blocks.flatMap(strings)];
    case "section":
      return [b.title, ...(b.subtitle ? [b.subtitle] : []), ...b.blocks.flatMap(strings)];
  }
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

describe("render (SPEC-notifications § Email design)", () => {
  it("puts every string in both parts, escaped in the HTML", () => {
    const { html, text } = render(doc(every));
    for (const s of every.flatMap(strings)) {
      expect(text, s).toContain(s === "Heading <h>" ? s.toUpperCase() : s);
      expect(html, s).toContain(escape(s));
    }
    expect(html).not.toContain("<i>");
    expect(html).not.toContain("<h>");
  });

  it("escapes untrusted text everywhere, and drops links that aren't http(s)", () => {
    const evil = `<script>alert("x")</script>`;
    const { html } = render(doc([{ type: "card", title: evil, href: "javascript:alert(1)", blocks: [{ type: "paragraph", text: evil }], meta: evil }], { title: evil, preheader: evil, footer: evil, action: { text: evil, href: "javascript:x" } }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
  });

  it("sets the inbox preview, and links the action and the card", () => {
    const { html, text } = render(doc(every, { action: { text: "Open the strategy", href: "https://trader.whitebirch.io/strategy" } }));
    expect(html).toMatch(/<div style="display:none;[^"]*">Preview line/);
    expect(html).toContain('href="https://trader.whitebirch.io/strategy"');
    expect(html).toContain('href="https://trader.whitebirch.io/theses/ttmi"');
    expect(text).toContain("Open the strategy: https://trader.whitebirch.io/strategy");
  });

  it("shows status as an icon beside the words, never colour alone", () => {
    const { html, text } = render(doc([], { title: "Trading HALTED", tone: "bad" }));
    expect(text.startsWith("■ Trading HALTED")).toBe(true);
    expect(html).toMatch(/■<\/span>&nbsp;Trading HALTED<\/h1>/);
  });

  it("never starts a list item or paragraph with its own bullet (the v21 double bullets)", () => {
    for (const [name, sample] of Object.entries(SAMPLES)) {
      const { html, text } = composeUrgent(sample(), "production");
      expect(html, name).not.toMatch(/<li[^>]*>\s*[•\-*]/);
      expect(html, name).not.toMatch(/<p[^>]*>\s*•/);
      expect(text, name).not.toMatch(/^\s*- [•\-*] /m);
      expect(text, name).not.toContain("•");
    }
  });

  it("stays far below Gmail's 102KB clipping limit", () => {
    for (const [name, sample] of Object.entries(SAMPLES)) expect(Buffer.byteLength(composeUrgent(sample(), "production").html), name).toBeLessThan(60_000);
  });

  it("uses tables, not flex or grid, for anything side by side", () => {
    const { html } = composeUrgent(SAMPLES["strategy-v21-reaffirmed"]!(), "production");
    expect(html).not.toMatch(/display:\s*(flex|grid)/);
  });
});
