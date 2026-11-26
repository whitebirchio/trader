import Link from "next/link";
import { add, positionsView } from "@trader/core";
import { ExitList } from "@/components/exits";
import { Info } from "@/components/info";
import { Card, Signed } from "@/components/ui";
import { signedIn } from "@/lib/auth";
import { formatPct, formatSignedUsd, formatUsd, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/** One line per symbol: how many sales at a loss, their total, and when the last window ends. */
function washSales(windows: { symbol: string; loss: string; windowEnds: string }[]) {
  const by = new Map<string, { symbol: string; sales: number; loss: string; windowEnds: string }>();
  for (const w of windows) {
    const g = by.get(w.symbol) ?? { symbol: w.symbol, sales: 0, loss: "0", windowEnds: w.windowEnds };
    by.set(w.symbol, { symbol: w.symbol, sales: g.sales + 1, loss: add(g.loss, w.loss), windowEnds: w.windowEnds > g.windowEnds ? w.windowEnds : g.windowEnds });
  }
  return [...by.values()].sort((a, b) => b.windowEnds.localeCompare(a.windowEnds));
}

/** Positions (SPEC-dashboard Amendment 3): each holding, why we hold it, how it's done, and when it would be sold. */
export default async function PositionsPage() {
  const { db } = await signedIn();
  const v = await positionsView(db, new Date());
  if (v.cards.length === 0) return <Card title="Positions"><p className="text-sm text-[var(--muted)]">Nothing held yet.</p></Card>;
  return (
    <div className="grid grid-cols-1 gap-4">
      {v.cards.map((c) => (
        <Card key={c.symbol}>
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold">{c.thesisId ? <Link href={`/theses/${c.thesisId}`}>{c.symbol}</Link> : c.symbol}</h2>
            <span className="text-right">
              <Signed value={c.pnl}>{formatSignedUsd(c.pnl)}</Signed>
              {c.returnPct && <span className="ml-1 text-sm text-[var(--muted)]">{formatPct(c.returnPct)}</span>}
            </span>
          </div>
          <p className="mt-1 text-sm">
            {c.headline ? (
              <>
                {c.headline.text}
                {c.headline.fallback && <span className="ml-1 text-[var(--muted)]">(summary)</span>}
                <Info term="headline" />
              </>
            ) : (
              <>
                Idle money, held in the index until a thesis needs it <Info term="idle" />
              </>
            )}
          </p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {formatUsd(c.value)} · {formatPct(c.weightPct, 1, false)} of the account{c.targetPct && <> (target {formatPct(c.targetPct, 0, false)})</>} <Info term="weight" />
            {c.vsVti && (
              <>
                {" "}
                · {formatSignedUsd(c.vsVti.excess)} {c.vsVti.excess.startsWith("-") ? "behind" : "ahead of"} the same dollars in VTI <Info term="vsVti" />
              </>
            )}
          </p>
          {c.exits && (
            <details className="mt-2">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm text-[var(--muted)] sm:min-h-0">
                When it sells: below {formatUsd(c.exits.stop.price)} ({formatPct(c.exits.stop.belowPct, 1, false)} down)
                {c.exits.review && <>, or by {shortDate(c.exits.review.date)}</>}
                {c.exits.flags.some((f) => f.flag !== "earnings_soon") ? " · flagged" : ""}
              </summary>
              <div className="mt-2">
                <ExitList exits={c.exits} />
              </div>
            </details>
          )}
        </Card>
      ))}
      {v.washSaleWindows.length > 0 && (
        <Card title="Open wash-sale windows">
          <p className="-mt-2 mb-2 text-xs text-[var(--muted)]">
            What they are <Info term="washSale" />
          </p>
          <ul className="grid gap-1 text-sm">
            {washSales(v.washSaleWindows).map((w) => (
              <li key={w.symbol}>
                {w.symbol}: {w.sales === 1 ? "a sale" : `${w.sales} sales`} at a loss ({formatUsd(w.loss)}); buying it back before {shortDate(w.windowEnds)} disallows {w.sales === 1 ? "the loss" : "the latest"}.
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
