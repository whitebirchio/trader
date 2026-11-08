import { OVERVIEW_RANGES, overviewView, parseRange, sub } from "@trader/core";
import { PerformanceChart } from "@/components/performance-chart";
import { RangePicker } from "@/components/range-picker";
import { Card, Change, StatTile, Status } from "@/components/ui";
import { signedIn } from "@/lib/auth";
import { formatEt, formatPct, formatPts, formatUsd, sign } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const { config, db } = await signedIn();
  const o = await overviewView(db, config.env, new Date(), parseRange((await searchParams).range, OVERVIEW_RANGES, "all"));
  const g = o.guardrails;
  const totals = o.performance.totals;
  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Equity" value={formatUsd(o.account.equity)} detail={`Cash ${formatUsd(o.account.cash)}`} />
        <StatTile label="Today" value={formatPct(o.account.todayPct)} detail="Flow-adjusted" />
        <StatTile label="From peak" value={o.account.drawdownFromPeakPct === "0" ? "0.00%" : `−${formatPct(o.account.drawdownFromPeakPct, 2, false)}`} detail="Drawdown" />
        <StatTile
          label="vs VTI"
          value={totals ? formatPts(sub(totals.portfolioPct, totals.benchmarkPct)) : "—"}
          detail={
            totals ? (
              <>
                Trader {formatPct(totals.portfolioPct)}, VTI {formatPct(totals.benchmarkPct)} · {totals.since} to {totals.through} close
              </>
            ) : (
              "After the first close"
            )
          }
        />
      </div>

      <Card title="Guardrails">
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {g.killSwitch ? <Status level="bad">Kill switch on</Status> : <Status level="good">Kill switch off</Status>}
          {g.halted ? <Status level="bad">Halted{g.haltReason ? `: ${g.haltReason}` : ""}</Status> : <Status level="good">Not halted</Status>}
          {g.buysPausedToday ? <Status level="warn">Buys paused today</Status> : <Status level="good">Buys allowed</Status>}
          {g.brokerTradingAllowed ? <Status level="good">Broker checks pass</Status> : <Status level="bad">Broker blocked: {g.brokerBlockedReasons.join("; ")}</Status>}
          <span className="text-[var(--muted)]">Last sync {o.lastSync ? formatEt(o.lastSync) : "never"}</span>
        </div>
      </Card>

      <Card title="Performance (both from 100)">
        <RangePicker options={o.performance.ranges} selected={o.performance.range} path="/" />
        <PerformanceChart points={o.performance.points} />
        {o.performance.rangeTotals && (
          <p className="mt-3 text-sm">
            Since {o.performance.rangeTotals.since}: Trader <Change pct={o.performance.rangeTotals.portfolioPct} />, VTI <Change pct={o.performance.rangeTotals.benchmarkPct} />
          </p>
        )}
      </Card>

      {o.capital && (
        <Card title="Your money">
          {o.capital.since && o.capital.startValue && o.capital.value ? (
            <p className="text-sm">
              From the {o.capital.since} close (the first snapshot) to the {o.capital.through} close: started with {formatUsd(o.capital.startValue)}
              {sign(o.capital.addedSince) !== 0 && <>, net transfers {formatUsd(o.capital.addedSince)}</>}, worth {formatUsd(o.capital.value)}.
              {o.capital.sameFlowsInVti && <> The same money held in VTI over those days would be worth {formatUsd(o.capital.sameFlowsInVti)}.</>}
            </p>
          ) : (
            <p className="text-sm">The comparison with VTI starts after the first close.</p>
          )}
          <p className="mt-2 text-sm text-[var(--muted)]">
            All time: put in {formatUsd(o.capital.contributed)}, worth {formatUsd(o.account.equity)} now.
          </p>
        </Card>
      )}

      <Card title={`Strategy v${o.strategy.version} · ${o.strategy.authoredBy} · ${formatEt(o.strategy.createdAt)}`}>
        <p className="whitespace-pre-line text-sm leading-relaxed [overflow-wrap:anywhere]">{o.strategy.summary}</p>
      </Card>
    </div>
  );
}
