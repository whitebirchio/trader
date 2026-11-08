import Link from "next/link";
import type { Strategy, Thesis } from "@trader/core";
import { Badge, Card } from "@/components/ui";
import { formatPct, safeHref } from "@/lib/format";

type ThesisState = { id: string; state: "active" | "stopped" | "stale" | "overdue"; reason?: string };

export function StrategyDocument({ document, states }: { document: Strategy; states?: ThesisState[] }) {
  const stateOf = new Map(states?.map((s) => [s.id, s]));
  const s = document.systematic;
  return (
    <div className="grid grid-cols-1 gap-4">
      <Card title="Summary"><p className="whitespace-pre-line text-sm leading-relaxed [overflow-wrap:anywhere]">{document.summary}</p></Card>
      <section className="grid grid-cols-1 gap-3">
        <h2 className="text-sm font-semibold text-[var(--muted)]">Conviction theses ({document.conviction.length})</h2>
        {document.conviction.length === 0 && <p className="text-sm text-[var(--muted)]">None. Everything is in the systematic sleeve.</p>}
        {document.conviction.map((t) => {
          const st = stateOf.get(t.id);
          return (
            <Card key={t.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold">
                  <Link href={`/theses/${t.id}`} className="underline decoration-[var(--border)] underline-offset-2 hover:decoration-current">{t.symbol}</Link>{" "}
                  <span className="font-normal text-[var(--muted)]">· {t.id}</span>
                </h3>
                <div className="flex flex-wrap gap-2">
                  <Badge>{formatPct(t.targetWeightPct, 1, false)} target</Badge>
                  <Badge>stop {formatPct(t.stopLossPct, 0, false)}</Badge>
                  {t.reviewBy && <Badge>review by {t.reviewBy}</Badge>}
                  {st && <Badge>{st.state === "active" ? "● active" : `▲ ${st.state}`}</Badge>}
                </div>
              </div>
              {st?.reason && <p className="mt-1 text-xs text-[var(--warn)]">{st.reason}</p>}
              <ThesisBody thesis={t} />
            </Card>
          );
        })}
      </section>
      <Card title="Systematic sleeve">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-3">
          <div><dt className="text-xs text-[var(--muted)]">Universe</dt><dd>{s.universe.join(", ")}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">Pick</dt><dd>top {s.topN}, {s.weighting.replace("_", " ")}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">Momentum</dt><dd>{s.lookbackDays} days, skipping {s.skipRecentDays}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">Trend filter</dt><dd>{s.trendFilterDays ? `${s.trendFilterDays}-day average` : "off"}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">Defensive</dt><dd>{s.defensive ?? "VTI"}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">Drift band</dt><dd>{document.drift.relativePct}% (min ${document.drift.minTradeUsd})</dd></div>
        </dl>
      </Card>
    </div>
  );
}

/** A thesis's reasoning and its evidence, with source links. */
export function ThesisBody({ thesis: t }: { thesis: Thesis }) {
  return (
    <>
      <p className="mt-2 whitespace-pre-line text-sm leading-relaxed [overflow-wrap:anywhere]">{t.thesis}</p>
      <ul className="mt-3 grid gap-1.5 text-sm">
        {t.evidence.map((e, i) => {
          const href = safeHref(e.source);
          return (
            <li key={i} className="flex min-w-0 gap-2">
              <Badge>{e.kind}</Badge>
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {e.summary}
                {e.asOf && <span className="text-[var(--muted)]"> ({e.asOf})</span>}
                {href && (
                  <> · <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="underline decoration-[var(--border)] underline-offset-2 hover:decoration-current">{new URL(href).hostname}</a></>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
