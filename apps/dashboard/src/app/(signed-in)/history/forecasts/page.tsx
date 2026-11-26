import Link from "next/link";
import { trackRecordView } from "@trader/core";
import { Badge, Card, PhoneRow, Signed } from "@/components/ui";
import { signedIn } from "@/lib/auth";
import { formatPts, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/** How many resolved forecasts the Forecasts card lists. */
const RECENT_RESOLVED = 10;


/** Forecasts (SPEC-portfolio § Forecast ledger): moved from the track record to History (SPEC-dashboard Amendment 3). */
export default async function ForecastsPage() {
  const { db } = await signedIn();
  const t = await trackRecordView(db, new Date());
  const f = t.forecasts;
  const fo = f.overall;
  const pts = (x: number | null) => (x === null ? "—" : formatPts(String(x)));
  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="text-sm text-[var(--muted)]">
        <Link href="/history" className="underline underline-offset-2">← History</Link>
      </p>
      <Card title="Forecasts (each thesis's and watchlist name's chance of beating VTI by its horizon)">
        <p className="mb-3 text-sm text-[var(--muted)]">
          Skill compares the forecasts with always saying {f.baseRatePct}%: above 0 beats it. Brier is the mean squared miss: lower is better. Forecasts stated
          after a thesis was already held are backfilled and not scored. Below 30 resolved, every figure is too few to judge.
        </p>
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Figure label="Resolved" value={`${fo.resolved} of ${fo.forecasts}`} detail={`${f.bySource.thesis.resolved} theses, ${f.bySource.watchlist.resolved} watchlist · ${f.bySource.backfilled.forecasts} backfilled`} />
          <Figure label={`Skill vs ${f.baseRatePct}%`} value={fo.skill === null ? "—" : `${fo.skill > 0 ? "+" : ""}${fo.skill.toFixed(2)}`} detail={fo.tooFewToJudge ? "Too few to judge" : "Above 0 beats the base rate"} />
          <Figure label="Brier" value={fo.brier === null ? "—" : fo.brier.toFixed(3)} detail={`Always ${f.baseRatePct}% scores about 0.25`} />
          <Figure label="Expected vs realized" value={`${pts(fo.meanExpectedExcessPct)} / ${pts(fo.meanRealizedExcessPct)}`} detail={fo.excessCorrelation === null ? "Correlation from 20 resolved" : `Correlation ${fo.excessCorrelation.toFixed(2)}`} />
        </div>

        <h3 className="mb-1 text-xs font-medium text-[var(--muted)]">Reliability: did the stocks beat VTI as often as forecast?</h3>
        <table className="mb-4 w-full text-sm">
          <thead className="text-left text-xs text-[var(--muted)]">
            <tr>
              <th className="py-1.5">Forecast</th>
              <th className="text-right">Resolved</th>
              <th className="text-right">Average</th>
              <th className="text-right">Beat VTI</th>
            </tr>
          </thead>
          <tbody>
            {fo.buckets.map((b) => (
              <tr key={b.range} className="border-t border-[var(--border)]">
                <td className="py-2 font-medium">{b.range}</td>
                <td className="text-right">{b.count}</td>
                <td className="text-right">{b.meanForecastPct === null ? "—" : `${b.meanForecastPct}%`}</td>
                <td className="text-right">{b.beatPct === null ? "—" : `${b.beatPct}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 className="mb-1 text-xs font-medium text-[var(--muted)]">Bought vs passed: what was bought against the watchlist names passed on, vs VTI</h3>
        <table className="mb-4 w-full text-sm">
          <thead className="text-left text-xs text-[var(--muted)]">
            <tr>
              <th className="py-1.5">After</th>
              <th className="text-right">Bought</th>
              <th className="text-right">Passed</th>
              <th className="text-right">Difference</th>
            </tr>
          </thead>
          <tbody>
            {f.boughtVsPassed.map((y) => (
              <tr key={y.days} className="border-t border-[var(--border)]">
                <td className="py-2 font-medium">{y.days} sessions</td>
                <td className="text-right">{pts(y.bought.meanExcessPct)}<div className="text-xs text-[var(--muted)]">{y.bought.count} names</div></td>
                <td className="text-right">{pts(y.passed.meanExcessPct)}<div className="text-xs text-[var(--muted)]">{y.passed.count} names</div></td>
                <td className="text-right">
                  {y.differencePct === null ? "—" : <Signed value={String(y.differencePct)}>{formatPts(String(y.differencePct))}</Signed>}
                  {y.stdErr !== null && <div className="text-xs text-[var(--muted)]">± {y.stdErr.toFixed(2)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 className="text-xs font-medium text-[var(--muted)]">Open, soonest first</h3>
        {f.open.length === 0 ? (
          <p className="py-2 text-sm text-[var(--muted)]">None open.</p>
        ) : (
          <ul className="mb-4 divide-y divide-[var(--border)]">
            {f.open.map((x) => (
              <PhoneRow
                key={`${x.source}-${x.id}`}
                title={<>{x.symbol}<Badge>{x.source === "thesis" ? "thesis" : "watchlist"}</Badge>{x.backfilled && <Badge>backfilled</Badge>}</>}
                value={`${x.beatVtiPct}%`}
                detail={`by ${shortDate(x.horizon)}, ${x.daysToHorizon === 1 ? "1 day" : `${x.daysToHorizon} days`} away`}
              />
            ))}
          </ul>
        )}

        <h3 className="text-xs font-medium text-[var(--muted)]">Resolved, latest first</h3>
        {f.resolved.length === 0 ? (
          <p className="py-2 text-sm text-[var(--muted)]">None resolved yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {f.resolved.slice(0, RECENT_RESOLVED).map((x) => (
              <PhoneRow
                key={`${x.source}-${x.id}`}
                title={<>{x.symbol}<Badge>{x.source === "thesis" ? "thesis" : "watchlist"}</Badge>{x.backfilled && <Badge>backfilled</Badge>}</>}
                value={<Signed value={x.excessPct}>{formatPts(x.excessPct)}</Signed>}
                detail={`${x.beatVtiPct}% to beat VTI: ${x.beat ? "it did" : "it didn't"}`}
                secondary={shortDate(x.endDate)}
              />
            ))}
          </ul>
        )}
      </Card>

    </div>
  );
}

function Figure({ label, value, detail }: { label: string; value: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-[var(--muted)]">{label}</div>
      <div className="mt-0.5 text-lg font-semibold">{value}</div>
      {detail && <div className="text-xs text-[var(--muted)]">{detail}</div>}
    </div>
  );
}
