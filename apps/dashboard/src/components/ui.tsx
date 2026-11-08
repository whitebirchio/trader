import { formatPct, sign } from "@/lib/format";

export function Card({ title, children, className = "" }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 ${className}`}>
      {title && <h2 className="mb-3 text-sm font-semibold text-[var(--muted)]">{title}</h2>}
      {children}
    </section>
  );
}

export function StatTile({ label, value, detail }: { label: string; value: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="text-xs font-medium text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {detail && <div className="mt-1 text-xs text-[var(--muted)]">{detail}</div>}
    </div>
  );
}

/** A signed figure in text ink, with a colored arrow beside it (identity never by color alone). `value` decides the arrow. */
export function Signed({ value, children }: { value: string; children: React.ReactNode }) {
  const s = sign(value);
  return (
    <span className="whitespace-nowrap">
      {s !== 0 && (
        <span aria-hidden className={s > 0 ? "text-[var(--good)]" : "text-[var(--bad)]"}>
          {s > 0 ? "▲ " : "▼ "}
        </span>
      )}
      {children}
    </span>
  );
}

/** A signed percentage with its arrow. */
export function Change({ pct }: { pct: string }) {
  return <Signed value={pct}>{formatPct(pct)}</Signed>;
}

/** Status with icon + label, never color alone. */
export function Status({ level, children }: { level: "good" | "warn" | "bad"; children: React.ReactNode }) {
  const icon = level === "good" ? "●" : level === "warn" ? "▲" : "■";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={`text-[var(--${level})]`}>{icon}</span>
      {children}
    </span>
  );
}

export function Badge({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 self-start whitespace-nowrap rounded-md border border-[var(--border)] px-1.5 py-0.5 text-xs text-[var(--muted)]">{children}</span>;
}
