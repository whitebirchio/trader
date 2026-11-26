import Link from "next/link";
import { positionsView } from "@trader/core";
import { ExitList } from "@/components/exits";
import { Card, Signed } from "@/components/ui";
import { signedIn } from "@/lib/auth";
import { formatPct, formatSignedUsd, formatUsd, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

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
              </>
            ) : (
              "Idle money, held in the index until a thesis needs it"
            )}
          </p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {formatUsd(c.value)} · {formatPct(c.weightPct, 1, false)} of the account{c.targetPct && <> (target {formatPct(c.targetPct, 0, false)})</>}
            {c.vsVti && (
              <>
                {" "}
                · {formatSignedUsd(c.vsVti.excess)} {c.vsVti.excess.startsWith("-") ? "behind" : "ahead of"} the same dollars in VTI
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
    </div>
  );
}
