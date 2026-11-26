import Link from "next/link";
import { marketDate, todayPage } from "@trader/core";
import { SankeyChart } from "@/components/sankey";
import { Badge, Card, PhoneRow, RowsOnPhone, Signed, Status, TableOnWide } from "@/components/ui";
import { signedIn } from "@/lib/auth";
import { formatEt, formatPct, formatSignedUsd, formatUsd, shortDate } from "@/lib/format";
import { describeEvent } from "@/lib/today-events";

export const dynamic = "force-dynamic";

/** Today (SPEC-dashboard Amendment 3): how it's doing in the last session, what changed, and where the money is. */
export default async function TodayPage() {
  const { config, db } = await signedIn();
  const now = new Date();
  const p = await todayPage(db, config.env, now);
  const t = p.today;
  const g = p.guardrails;
  const live = t && t.session === marketDate(now);
  const vti = t?.positions.find((x) => x.symbol === "VTI");
  const problems = [
    g.killSwitch && "Kill switch on",
    g.halted && `Halted${g.haltReason ? `: ${g.haltReason}` : ""}`,
    g.buysPausedToday && "Buys paused today",
    !g.brokerTradingAllowed && `Broker blocked: ${g.brokerBlockedReasons.join("; ")}`,
  ].filter(Boolean) as string[];
  const events = (t?.events ?? []).map(describeEvent);
  const headline = (symbol: string) => p.headlines[symbol];

  return (
    <div className="grid grid-cols-1 gap-4">
      <Card title={t ? `${live ? "Today" : "Last session"} · ${shortDate(t.session)}` : "Today"}>
        {t?.move ? (
          <>
            <p className="text-3xl font-semibold">
              <Signed value={t.move}>{formatSignedUsd(t.move)}</Signed>
              {t.movePct && <span className="ml-2 text-lg text-[var(--muted)]">{formatPct(t.movePct)}</span>}
            </p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {vti?.movePct ? <>VTI {formatPct(vti.movePct)} · </> : null}Account value {formatUsd(t.equity)} · as of {formatEt(t.asOf)}
            </p>
          </>
        ) : (
          <p className="text-sm text-[var(--muted)]">No session to show yet: the figures start after the first sync.</p>
        )}
        {p.extended && p.extended.positions.length > 0 && (
          <p className="mt-2 text-sm">
            {p.extended.session === "post" ? "After hours" : "Pre-market"}: <Signed value={p.extended.move}>{formatSignedUsd(p.extended.move)}</Signed>
            {p.extended.movePct && <> ({formatPct(p.extended.movePct)})</>}
            <span className="text-[var(--muted)]"> · as of {formatEt(p.extended.asOf)}, indicative (thin trading, about 16 minutes delayed)</span>
          </p>
        )}
        {p.sinceStart?.pnl && (
          <p className="mt-2 text-sm">
            Since you started ({shortDate(p.sinceStart.since!)}): <Signed value={p.sinceStart.pnl}>{formatSignedUsd(p.sinceStart.pnl)}</Signed>
            {p.sinceStart.gapUsd && (
              <span className="text-[var(--muted)]">
                {" "}
                · {formatSignedUsd(p.sinceStart.gapUsd)} {p.sinceStart.gapUsd.startsWith("-") ? "behind" : "ahead of"} the same money in VTI
              </span>
            )}
          </p>
        )}
      </Card>

      {t && t.positions.length > 0 && (
        <Card title="Each position today">
          <TableOnWide>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-[var(--muted)]">
                <tr>
                  <th className="py-1 pr-3 font-medium">Position</th>
                  <th className="py-1 pr-3 font-medium">Why we hold it</th>
                  <th className="py-1 pr-3 text-right font-medium">Today</th>
                  <th className="py-1 text-right font-medium">%</th>
                </tr>
              </thead>
              <tbody>
                {t.positions.map((x) => {
                  const h = headline(x.symbol);
                  return (
                    <tr key={x.symbol} className="border-t border-[var(--border)]">
                      <td className="py-1.5 pr-3 font-medium">{h ? <Link href={`/theses/${h.thesisId}`}>{x.symbol}</Link> : x.symbol}</td>
                      <td className="py-1.5 pr-3 text-[var(--muted)]">
                        {h ? h.text : x.symbol === "VTI" ? "Idle money, held in the index" : "—"}
                        {h?.fallback && <Badge>summary</Badge>}
                      </td>
                      <td className="py-1.5 pr-3 text-right">
                        <Signed value={x.move}>{formatSignedUsd(x.move)}</Signed>
                      </td>
                      <td className="py-1.5 text-right">{x.movePct ? formatPct(x.movePct) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableOnWide>
          <RowsOnPhone>
            {t.positions.map((x) => {
              const h = headline(x.symbol);
              return (
                <PhoneRow
                  key={x.symbol}
                  title={h ? <Link href={`/theses/${h.thesisId}`}>{x.symbol}</Link> : x.symbol}
                  value={<Signed value={x.move}>{formatSignedUsd(x.move)}</Signed>}
                  detail={
                    h ? (
                      <>
                        {h.text}
                        {h.fallback && <span className="ml-1 text-[var(--muted)]">(summary)</span>}
                      </>
                    ) : x.symbol === "VTI" ? (
                      "Idle money, held in the index"
                    ) : undefined
                  }
                  secondary={x.movePct ? formatPct(x.movePct) : undefined}
                />
              );
            })}
          </RowsOnPhone>
          {t.other && t.other !== "0.00" && <p className="mt-2 text-xs text-[var(--muted)]">Cash, fees and pricing at the previous close: {formatSignedUsd(t.other)}.</p>}
        </Card>
      )}

      <Card title={live ? "What changed today" : "What changed that session"}>
        {events.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)] text-sm">
            {events.map((e, i) => (
              <li key={i} className="flex gap-3 py-1.5">
                <span className="w-16 shrink-0 text-[var(--muted)]">{formatEt(e.at).split(", ").at(-1)}</span>
                <span className={e.attention ? "font-medium" : ""}>{e.text}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <details>
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-0">
            {problems.length === 0 ? <Status level="good">Guardrails: all clear</Status> : <Status level="bad">Guardrails: {problems.join(" · ")}</Status>}
          </summary>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {g.killSwitch ? <Status level="bad">Kill switch on</Status> : <Status level="good">Kill switch off</Status>}
            {g.halted ? <Status level="bad">Halted</Status> : <Status level="good">Not halted</Status>}
            {g.buysPausedToday ? <Status level="warn">Buys paused today</Status> : <Status level="good">Buys allowed</Status>}
            {g.brokerTradingAllowed ? <Status level="good">Broker checks pass</Status> : <Status level="bad">Broker blocked</Status>}
            <span className="text-[var(--muted)]">Last sync {p.lastSync ? formatEt(p.lastSync) : "never"}</span>
          </div>
        </details>
      </Card>

      {p.money && (
        <Card title="Where the money is">
          <SankeyChart data={p.money} unit="usd" label={`Money put in and gained, flowing into today's value of ${formatUsd(p.money.total)}`} />
        </Card>
      )}

      <p className="text-sm">
        <Link href="/performance" className="underline">
          Performance over time →
        </Link>
      </p>
    </div>
  );
}
