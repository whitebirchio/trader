import { ideasView } from "@trader/core";
import { Info } from "@/components/info";
import { SankeyChart } from "@/components/sankey";
import { Badge, Card } from "@/components/ui";
import { signedIn } from "@/lib/auth";
import { formatDays, formatPts, safeHref, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Ideas (SPEC-dashboard Amendment 3): what the routine is watching, what would make each a buy, and how ideas have turned out. */
export default async function IdeasPage() {
  const { db } = await signedIn();
  const v = await ideasView(db, new Date());
  const when = (days: number, due: boolean) => (due ? "due now" : days === 0 ? "today" : `in ${formatDays(days)}`);
  return (
    <div className="grid grid-cols-1 gap-4">
      <Card title={`Watching (${v.open.length})`}>
        {v.open.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Nothing on the watchlist.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {v.open.map((c) => (
              <li key={c.symbol} className="py-3 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-semibold">{c.symbol}</span>
                  <span className="shrink-0 text-xs text-[var(--muted)]">
                    next look {shortDate(c.revisitBy)} ({when(c.daysToRevisit, c.due)})
                  </span>
                </div>
                <p className="mt-1">
                  {c.headline.text}
                  {c.headline.fallback && <span className="ml-1 text-[var(--muted)]">(summary)</span>}
                </p>
                <p className="mt-1">
                  <span className="text-[var(--muted)]">Buys if:</span> {c.trigger} <Info term="trigger" />
                </p>
                {c.forecast && (
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Forecast: {c.forecast.beatVtiPct}% chance it beats VTI by {shortDate(c.forecast.horizon)} (expected {formatPts(c.forecast.expectedExcessPct)}) <Info term="forecast" />
                  </p>
                )}
                <details className="mt-1">
                  <summary className="flex min-h-11 cursor-pointer items-center text-xs text-[var(--muted)] sm:min-h-0">
                    Why it's interesting{c.filings.length > 0 ? ` · ${c.filings.length} new filing${c.filings.length === 1 ? "" : "s"}` : ""}
                  </summary>
                  <p className="mt-1 [overflow-wrap:anywhere]">{c.why}</p>
                  {c.filings.length > 0 && (
                    <ul className="mt-2 space-y-1 text-xs">
                      {c.filings.map((f) => {
                        const href = safeHref(f.url);
                        return (
                          <li key={`${f.form}-${f.filedOn}-${f.summary}`} className="flex gap-2">
                            <Badge>{f.form}</Badge>
                            <span className="[overflow-wrap:anywhere]">
                              {shortDate(f.filedOn)}: {href ? <a href={href} className="underline" target="_blank" rel="noreferrer">{f.summary}</a> : f.summary}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="How ideas have turned out">
        <SankeyChart data={v.funnel} unit="count" label={`${v.funnel.total} ideas: watched or found directly, through to what happened`} />
      </Card>
    </div>
  );
}
