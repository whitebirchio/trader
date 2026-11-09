import { formatPct, sign } from "@/lib/format";

export function Card({ title, children, className = "" }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:p-4 ${className}`}>
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

/**
 * Phones show a list of compact rows instead of a wide table (SPEC-dashboard
 * Amendment 2): the table renders inside `TableOnWide`, the rows inside
 * `RowsOnPhone`, and exactly one of the two shows. Each table is written
 * twice, so a new column belongs in both. `TableOnWide`'s `-mx-4 px-4` lets
 * a wide table scroll to the card's edges: it must match `Card`'s `sm:p-4`.
 */
export function TableOnWide({ children }: { children: React.ReactNode }) {
  return <div className="-mx-4 hidden overflow-x-auto px-4 sm:block">{children}</div>;
}

export function RowsOnPhone({ children }: { children: React.ReactNode }) {
  return <ul className="divide-y divide-[var(--border)] sm:hidden">{children}</ul>;
}

/** One row on a phone: a title and its headline figure, then a detail line and a secondary figure, then an optional footnote. */
export function PhoneRow({ title, value, detail, secondary, foot }: { title: React.ReactNode; value?: React.ReactNode; detail?: React.ReactNode; secondary?: React.ReactNode; foot?: React.ReactNode }) {
  return (
    <li className="py-2.5 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2 font-medium">{title}</div>
        {value !== undefined && <div className="shrink-0 text-right font-medium">{value}</div>}
      </div>
      {(detail !== undefined || secondary !== undefined) && (
        <div className="mt-0.5 flex items-baseline justify-between gap-3 text-xs text-[var(--muted)]">
          <div className="min-w-0">{detail}</div>
          {secondary !== undefined && <div className="shrink-0 text-right">{secondary}</div>}
        </div>
      )}
      {foot !== undefined && <div className="mt-0.5 text-xs text-[var(--muted)] [overflow-wrap:anywhere]">{foot}</div>}
    </li>
  );
}
