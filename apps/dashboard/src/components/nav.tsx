"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

/**
 * The menu and the refresh control (SPEC-dashboard Amendment 2). On phones the
 * menu is one row that scrolls inside itself, never the page: the next item is
 * cut off at the edge, that edge fades, and the current page is scrolled into
 * view. A home-screen app has no reload button, so there's a refresh control,
 * and the page refreshes itself when the app returns after a minute away.
 */
const NAV = [
  ["/", "Overview"],
  ["/holdings", "Holdings"],
  ["/money", "Money"],
  ["/strategy", "Strategy"],
  ["/track-record", "Track record"],
  ["/activity", "Activity"],
] as const;

const STALE_AFTER_MS = 60_000;

/** The menu entry a path belongs to (a thesis page sits under the track record). */
export function activeHref(pathname: string): string {
  if (pathname.startsWith("/theses/")) return "/track-record";
  return NAV.map(([href]) => href).find((href) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`))) ?? "";
}

/** Whether the page's data is old enough to reload when the app comes back to the foreground. */
export function isStale(loadedAt: number, now: number): boolean {
  return now - loadedAt > STALE_AFTER_MS;
}

export function Nav() {
  const pathname = usePathname();
  const active = activeHref(pathname);
  const row = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });

  // Keep the current page in view and show which edges have more to scroll to.
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const current = el.querySelector<HTMLElement>('[aria-current="page"]');
    if (current) el.scrollLeft = Math.max(0, current.offsetLeft - (el.clientWidth - current.offsetWidth) / 2);
    const update = () => setFade({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [active]);

  const mask = [fade.left ? "transparent, black 1.5rem" : "black", fade.right ? "black calc(100% - 2.5rem), transparent" : "black"].join(", ");
  return (
    <div
      ref={row}
      // `relative` makes it the links' offsetParent, so offsetLeft is measured from the row's own edge.
      className="relative -ml-4 min-w-0 flex-1 overflow-x-auto overscroll-x-contain pl-4 [scrollbar-width:none] sm:ml-0 sm:overflow-visible sm:pl-0 [&::-webkit-scrollbar]:hidden"
      style={{ maskImage: `linear-gradient(to right, ${mask})`, WebkitMaskImage: `linear-gradient(to right, ${mask})` }}
    >
      <nav aria-label="Pages" className="flex w-max gap-1 text-sm sm:w-auto sm:flex-wrap">
        {NAV.map(([href, label]) => (
          <Link
            key={href}
            href={href}
            aria-current={href === active ? "page" : undefined}
            className={`flex min-h-11 items-center whitespace-nowrap rounded-md px-3 sm:min-h-0 sm:px-2.5 sm:py-1.5 ${href === active ? "bg-[var(--border)] font-semibold" : "hover:bg-[var(--border)]"}`}
          >
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** Reload the page's data: on tap, and when the app comes back after a minute away. */
export function Refresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const loadedAt = useRef(Date.now());

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && isStale(loadedAt.current, Date.now())) {
        loadedAt.current = Date.now();
        startTransition(() => router.refresh());
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [router]);

  return (
    <button
      type="button"
      aria-label="Refresh"
      title="Refresh"
      disabled={pending}
      onClick={() => {
        loadedAt.current = Date.now();
        startTransition(() => router.refresh());
      }}
      className="flex size-11 shrink-0 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--border)] hover:text-[var(--text)] disabled:opacity-60 sm:size-9"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={pending ? "animate-spin" : undefined}>
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </svg>
    </button>
  );
}
