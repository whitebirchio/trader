import Link from "next/link";
import { notFound } from "next/navigation";
import { THESIS_RANGES, parseRange, thesisView } from "@trader/core";
import { ThesisBody } from "@/components/strategy-document";
import { RangePicker } from "@/components/range-picker";
import { ThesisChart } from "@/components/thesis-chart";
import { Badge, Card, Change, PhoneRow, RowsOnPhone, Signed, StatTile, TableOnWide } from "@/components/ui";
import { signedIn } from "@/lib/auth";
import { formatDays, formatEt, formatPct, formatPts, formatQty, formatSignedUsd, formatUsd, sign } from "@/lib/format";

export const dynamic = "force-dynamic";

const ENDING = { open: "held", removed: "removed", stopped: "stopped out", trailing_stopped: "trailing stop", took_profit: "profit target", stale: "went stale", overdue: "review date passed" } as const;

export default async function ThesisPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ range?: string }> }) {
  const { db } = await signedIn();
  const { id } = await params;
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) notFound();
  const v = await thesisView(db, id, new Date(), parseRange((await searchParams).range, THESIS_RANGES, "held"));
  if (!v) notFound();
  const s = v.score;
  const m = s?.money ?? null;

  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="text-sm text-[var(--muted)]">
        <Link href="/track-record" className="underline underline-offset-2">← Track record</Link>
      </p>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold">{v.symbol}</h1>
        <span className="text-sm text-[var(--muted)]">{v.ids.join(" → ")}</span>
        {s?.primaryKind && <Badge>{s.primaryKind}</Badge>}
        <span className="text-sm">
          {s ? (
            <>
              {ENDING[s.ending]} · {formatDays(s.daysHeld)}
              {s.ending !== "open" && !s.closedAt && <span className="text-[var(--muted)]"> (selling)</span>}
              <span className="text-[var(--muted)]"> · {s.openedAt.slice(0, 10)} to {s.closedAt?.slice(0, 10) ?? "now"}{s.closedAt ? "" : ` · ${formatQty(s.qty)} sh`}</span>
            </>
          ) : (
            <span className="text-[var(--muted)]">not bought yet</span>
          )}
        </span>
      </div>

      {v.thesis.plainSummary && (
        <Card title="In plain terms">
          <p className="text-sm leading-relaxed [overflow-wrap:anywhere]">{v.thesis.plainSummary}</p>
        </Card>
      )}

      {m ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="Bought" value={formatUsd(m.bought)} detail={sign(m.proceeds) > 0 ? `${formatUsd(m.proceeds)} sold` : undefined} />
          <StatTile label="Return" value={<Change pct={m.returnPct} />} detail={formatSignedUsd(m.pnl)} />
          <StatTile label="Same $ in VTI" value={<Change pct={m.vtiPct} />} detail={formatSignedUsd(m.vtiPnl)} />
          <StatTile label="vs VTI" value={<Signed value={m.excessPct}>{formatPts(m.excessPct)}</Signed>} detail={formatSignedUsd(m.excess)} />
        </div>
      ) : (
        s?.unscored && <p className="text-sm text-[var(--muted)]">Not scored: {s.unscored}</p>
      )}
      {m && s && !s.closedAt && v.markedAt && <p className="-mt-2 text-xs text-[var(--muted)]">Marked at the {formatEt(v.markedAt)} sync.</p>}

      <Card title="Price">
        <RangePicker options={v.chart.ranges} selected={v.chart.range} path={`/theses/${id}`} />
        <ThesisChart chart={v.chart} />
      </Card>

      <Card title={`Reasoning and evidence (v${v.latestVersion})`}>
        <div className="flex flex-wrap gap-2">
          <Badge>{formatPct(v.thesis.targetWeightPct, 1, false)} target</Badge>
          <Badge>stop {formatPct(v.thesis.stopLossPct, 0, false)}</Badge>
          {v.thesis.reviewBy && <Badge>review by {v.thesis.reviewBy}</Badge>}
        </div>
        <ThesisBody thesis={v.thesis} plain={false} />
      </Card>

      <Card title="Version history, newest first">
        <RowsOnPhone>
          {v.history.map((h) => (
            <PhoneRow
              key={h.version}
              title={<Link href={`/strategy/${h.version}`} className="underline decoration-[var(--border)] underline-offset-2 hover:decoration-current">v{h.version}</Link>}
              value={h.thesis ? `${formatPct(h.thesis.targetWeightPct, 1, false)} target` : "dropped"}
              detail={formatEt(h.createdAt)}
              secondary={h.thesis ? `stop ${formatPct(h.thesis.stopLossPct, 0, false)}${h.thesis.reviewBy ? ` · review by ${h.thesis.reviewBy}` : ""}` : undefined}
              foot={h.changes.join(", ")}
            />
          ))}
        </RowsOnPhone>
        <TableOnWide>
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="text-left text-xs text-[var(--muted)]">
              <tr>
                <th className="py-1.5">Version</th>
                <th>Date</th>
                <th className="text-right">Weight</th>
                <th className="text-right">Stop</th>
                <th className="pl-3">Review by</th>
                <th className="pl-3">Change</th>
              </tr>
            </thead>
            <tbody>
              {v.history.map((h) => (
                <tr key={h.version} className="border-t border-[var(--border)] align-top">
                  <td className="py-2"><Link href={`/strategy/${h.version}`} className="underline decoration-[var(--border)] underline-offset-2 hover:decoration-current">v{h.version}</Link></td>
                  <td className="whitespace-nowrap">{formatEt(h.createdAt)}</td>
                  <td className="text-right">{h.thesis ? formatPct(h.thesis.targetWeightPct, 1, false) : "—"}</td>
                  <td className="text-right">{h.thesis ? formatPct(h.thesis.stopLossPct, 0, false) : "—"}</td>
                  <td className="pl-3">{h.thesis?.reviewBy ?? "—"}</td>
                  <td className="pl-3">{h.changes.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableOnWide>
      </Card>

      {v.events.length > 0 && (
        <Card title="Automatic exits">
          <ul className="grid gap-1.5 text-sm">
            {v.events.map((e) => (
              <li key={`${e.thesisId}-${e.at}`}>
                <span className="font-medium">{e.kind}</span> <span className="text-[var(--muted)]">{formatEt(e.at)}</span>: {e.reason}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
