import Link from "next/link";
import { historyView } from "@trader/core";
import { Info } from "@/components/info";
import { SankeyChart } from "@/components/sankey";
import { Badge, Card, Change, PhoneRow, RowsOnPhone, Signed, StatTile, TableOnWide } from "@/components/ui";
import { signedIn } from "@/lib/auth";
import { formatDays, formatEt, formatPct, formatPts, formatQty, formatSignedUsd, formatUsd } from "@/lib/format";

export const dynamic = "force-dynamic";

const ENDING = { open: "held", removed: "removed", stopped: "stopped out", trailing_stopped: "trailing stop", took_profit: "profit target", stale: "went stale", overdue: "review date passed" } as const;

/** History (SPEC-dashboard Amendment 3): every thesis ever held and how it did, by lead signal, with the trades, strategy versions and forecasts a tap away. */
export default async function HistoryPage() {
  const { db } = await signedIn();
  const { track: t, headlines, signal } = await historyView(db, new Date());
  const headlineOf = (ids: string[]) => headlines[ids.at(-1)!] ?? null;
  const o = t.overall;
  return (
    <div className="grid grid-cols-1 gap-4">
      <nav aria-label="History" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link href="/history/activity" className="flex min-h-11 items-center underline underline-offset-2 sm:min-h-0">All trades and events</Link>
        <Link href="/history/strategy" className="flex min-h-11 items-center underline underline-offset-2 sm:min-h-0">Strategy versions</Link>
        <Link href="/history/forecasts" className="flex min-h-11 items-center underline underline-offset-2 sm:min-h-0">Forecasts</Link>
      </nav>
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
        <p className="-mt-2 mb-2 text-xs text-[var(--muted)]">
          What a lead signal is <Info term="leadSignal" />
        </p>
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

      {signal.links.length > 0 && (
        <Card title="Which kinds of evidence have worked">
          <p className="-mt-2 mb-2 text-xs text-[var(--muted)]">
            Closed bets by how they ended; open ones by where they stand against VTI now. <Info term="openVsVti" />
          </p>
          <SankeyChart data={signal} unit="count" label={`${signal.total} theses, from each lead signal to how it turned out`} />
        </Card>
      )}

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
                  <>
                    {headlineOf(r.ids) && <span className="block text-[var(--text)]">{headlineOf(r.ids)!.text}{headlineOf(r.ids)!.fallback && <span className="text-[var(--muted)]"> (summary)</span>}</span>}
                    {"pnl" in r
                      ? `${formatUsd(r.bought)} bought · ${formatSignedUsd(r.excess)} vs VTI · ${r.openedAt?.slice(0, 10)} to ${r.closedAt?.slice(0, 10) ?? "now"}`
                      : `Not scored: ${r.unscored}`}
                  </>
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
                      {headlineOf(r.ids) && <div className="text-xs">{headlineOf(r.ids)!.text}{headlineOf(r.ids)!.fallback && <span className="text-[var(--muted)]"> (summary)</span>}</div>}
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
