import Link from "next/link";
import { trackRecordView } from "@trader/core";
import { Badge, Card, Change, PhoneRow, RowsOnPhone, Signed, StatTile, TableOnWide } from "@/components/ui";
import { signedIn } from "@/lib/auth";
import { formatDays, formatEt, formatPct, formatPts, formatQty, formatSignedUsd, formatUsd, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/** How many resolved forecasts the Forecasts card lists. */
const RECENT_RESOLVED = 10;

const ENDING = { open: "held", removed: "removed", stopped: "stopped out", trailing_stopped: "trailing stop", took_profit: "profit target", stale: "went stale", overdue: "review date passed" } as const;

export default async function TrackRecordPage() {
  const { db } = await signedIn();
  const t = await trackRecordView(db, new Date());
  const o = t.overall;
  const f = t.forecasts;
  const fo = f.overall;
  const pts = (x: number | null) => (x === null ? "—" : formatPts(String(x)));
  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="text-sm text-[var(--muted)]">
        Each thesis's return on the dollars bought, against the same dollars held in VTI over the same days (each buy buys VTI at that day's close, each sell sells the same share).
        {t.markedAt && <> Open theses are marked at the {formatEt(t.markedAt)} sync.</>} A few theses held for days is noise, not a verdict.
      </p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Theses" value={`${o.theses}`} detail={`${o.scored} scored, ${o.closed} closed`} />
        <StatTile label="vs VTI" value={o.excessPct ? <Signed value={o.excessPct}>{formatPts(o.excessPct)}</Signed> : "—"}
          detail={`${formatSignedUsd(o.excess)} on ${formatUsd(o.bought)} bought`} />
        <StatTile label="Beat VTI" value={o.beatVtiPct ? formatPct(o.beatVtiPct, 0, false) : "—"} detail="Share of scored theses" />
        <StatTile label="Held" value={o.medianDaysHeld === null ? "—" : formatDays(o.medianDaysHeld)} detail="Median" />
      </div>

      <Card title="By lead signal (declared on each thesis; older ones inferred from their most cited evidence)">
        {t.byKind.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No theses yet.</p>
        ) : (
          <>
          <RowsOnPhone>
            {t.byKind.map((k) => (
              <PhoneRow
                key={k.kind}
                title={k.kind}
                value={k.excessPct ? <Signed value={k.excessPct}>{formatPts(k.excessPct)}</Signed> : "—"}
                detail={`${k.scored === k.theses ? k.theses : `${k.scored} of ${k.theses}`} ${k.theses === 1 ? "thesis" : "theses"} · ${formatUsd(k.bought)} bought`}
                secondary={<>P&amp;L {formatSignedUsd(k.pnl)} · VTI {formatSignedUsd(k.vtiPnl)}</>}
              />
            ))}
          </RowsOnPhone>
          <TableOnWide>
            <table className="w-full min-w-[32rem] text-sm">
              <thead className="text-left text-xs text-[var(--muted)]">
                <tr>
                  <th className="py-1.5">Kind</th>
                  <th className="text-right">Theses</th>
                  <th className="text-right">Bought</th>
                  <th className="text-right">P&amp;L</th>
                  <th className="text-right">Same $ in VTI</th>
                  <th className="text-right">vs VTI</th>
                </tr>
              </thead>
              <tbody>
                {t.byKind.map((k) => (
                  <tr key={k.kind} className="border-t border-[var(--border)]">
                    <td className="py-2 font-medium">{k.kind}</td>
                    <td className="text-right">{k.scored === k.theses ? k.theses : `${k.scored} of ${k.theses}`}</td>
                    <td className="text-right">{formatUsd(k.bought)}</td>
                    <td className="text-right"><Signed value={k.pnl}>{formatSignedUsd(k.pnl)}</Signed></td>
                    <td className="text-right"><Signed value={k.vtiPnl}>{formatSignedUsd(k.vtiPnl)}</Signed></td>
                    <td className="text-right">{k.excessPct ? <Signed value={k.excessPct}>{formatPts(k.excessPct)}</Signed> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableOnWide>
          </>
        )}
      </Card>

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

      <Card title="Theses, newest first">
        {t.theses.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No theses yet.</p>
        ) : (
          <>
          <RowsOnPhone>
            {t.theses.map((r) => (
              <PhoneRow
                key={`${r.ids[0]}-${r.openedAt}`}
                title={
                  <>
                    <Link href={`/theses/${r.ids.at(-1)}`} className="underline decoration-[var(--border)] underline-offset-2 hover:decoration-current">{r.symbol}</Link>
                    {r.primaryKind && <Badge>{r.primaryKind}{r.kindSource === "inferred" && " (inferred)"}</Badge>}
                  </>
                }
                value={"pnl" in r ? <Signed value={r.excessPct}>{formatPts(r.excessPct)}</Signed> : "—"}
                detail={
                  <>
                    {formatDays(r.daysHeld)}, {ENDING[r.ending]}
                    {r.ending !== "open" && !r.closedAt && " (selling)"}
                  </>
                }
                secondary={"pnl" in r ? <>return <Change pct={r.returnPct} /> · VTI <Change pct={r.vtiPct} /></> : undefined}
                foot={
                  "pnl" in r
                    ? `${formatUsd(r.bought)} bought · ${formatSignedUsd(r.excess)} vs VTI · ${r.openedAt?.slice(0, 10)} to ${r.closedAt?.slice(0, 10) ?? "now"}`
                    : `Not scored: ${r.unscored}`
                }
              />
            ))}
          </RowsOnPhone>
          <TableOnWide>
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="text-left text-xs text-[var(--muted)]">
                <tr>
                  <th className="py-1.5">Thesis</th>
                  <th>Held</th>
                  <th className="text-right">Bought</th>
                  <th className="text-right">Return</th>
                  <th className="text-right">VTI</th>
                  <th className="text-right">vs VTI</th>
                </tr>
              </thead>
              <tbody>
                {t.theses.map((r) => (
                  <tr key={`${r.ids[0]}-${r.openedAt}`} className="border-t border-[var(--border)] align-top">
                    <td className="py-2">
                      <div className="flex gap-2">
                        <Link href={`/theses/${r.ids.at(-1)}`} className="font-medium underline decoration-[var(--border)] underline-offset-2 hover:decoration-current">{r.symbol}</Link>
                        {r.primaryKind && <Badge>{r.primaryKind}{r.kindSource === "inferred" && " (inferred)"}</Badge>}
                      </div>
                      <div className="text-xs text-[var(--muted)]">{r.ids.join(" → ")}</div>
                    </td>
                    <td className="whitespace-nowrap">
                      {formatDays(r.daysHeld)}, {ENDING[r.ending]}
                      {r.ending !== "open" && !r.closedAt && <span className="text-[var(--muted)]"> (selling)</span>}
                      <div className="text-xs text-[var(--muted)]">
                        {r.openedAt?.slice(0, 10)} to {r.closedAt?.slice(0, 10) ?? "now"}
                        {r.closedAt ? "" : ` · ${formatQty(r.qty)} sh`}
                      </div>
                    </td>
                    {"pnl" in r ? (
                      <>
                        <td className="text-right">{formatUsd(r.bought)}</td>
                        <td className="text-right">
                          <Change pct={r.returnPct} />
                          <div className="text-xs text-[var(--muted)]">{formatSignedUsd(r.pnl)}</div>
                        </td>
                        <td className="text-right">
                          <Change pct={r.vtiPct} />
                          <div className="text-xs text-[var(--muted)]">{formatSignedUsd(r.vtiPnl)}</div>
                        </td>
                        <td className="text-right font-medium">
                          <Signed value={r.excessPct}>{formatPts(r.excessPct)}</Signed>
                          <div className="text-xs font-normal text-[var(--muted)]">{formatSignedUsd(r.excess)}</div>
                        </td>
                      </>
                    ) : (
                      <td colSpan={4} className="text-right text-[var(--muted)]">Not scored: {r.unscored}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableOnWide>
          </>
        )}
      </Card>
    </div>
  );
}

/** A figure inside a card: a StatTile without its own border. */
function Figure({ label, value, detail }: { label: string; value: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-[var(--muted)]">{label}</div>
      <div className="mt-0.5 text-lg font-semibold">{value}</div>
      {detail && <div className="text-xs text-[var(--muted)]">{detail}</div>}
    </div>
  );
}
