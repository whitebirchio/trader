import Link from "next/link";
import type { RangeOption } from "@trader/core";

/**
 * A chart's time ranges (#59), in one row above it. Each is a link, so a
 * range is bookmarkable and needs no client code; one the history doesn't
 * reach yet is shown disabled, with the reason.
 */
export function RangePicker({ options, selected, path }: { options: RangeOption[]; selected: string; path: string }) {
  return (
    <nav aria-label="Time range" className="mb-3 flex flex-wrap gap-1 text-xs">
      {options.map((o) =>
        o.available ? (
          <Link
            key={o.range}
            href={`${path}?range=${o.range}`}
            scroll={false}
            aria-current={o.range === selected ? "true" : undefined}
            className={`flex min-h-11 items-center rounded-md border px-3 text-sm sm:min-h-0 sm:px-2 sm:py-1 sm:text-xs ${o.range === selected ? "border-[var(--text)] font-semibold" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]"}`}
          >
            {o.label}
          </Link>
        ) : (
          <span key={o.range} aria-disabled="true" title={`Not yet: ${o.reason}`} className="flex min-h-11 cursor-not-allowed items-center rounded-md border border-dashed border-[var(--border)] px-3 text-sm text-[var(--muted)] opacity-60 sm:min-h-0 sm:px-2 sm:py-1 sm:text-xs">
            {o.label}
          </span>
        ),
      )}
    </nav>
  );
}
