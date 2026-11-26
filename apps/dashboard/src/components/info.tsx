"use client";

import { useId, useState } from "react";
import { GLOSSARY, type GlossaryTerm } from "@/lib/glossary";

/** An ⓘ that says what a figure means (SPEC-dashboard Amendment 3): a tap opens it, so it works on a phone. */
export function Info({ term }: { term: GlossaryTerm }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const entry = GLOSSARY[term];
  return (
    <span className="relative inline-block align-middle text-sm font-normal">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`What "${entry.term}" means`}
        onClick={() => setOpen((o) => !o)}
        // A 44 px tap target on phones, pulled in by negative margins so it doesn't stretch the line it
        // sits in; a fixed small size (not the surrounding text's), a gap before it, and a pointer cursor.
        className="-my-3 -mr-2.5 ml-0.5 inline-flex size-11 cursor-pointer items-center justify-center align-middle text-sm font-normal leading-none text-[var(--muted)] hover:text-[var(--text)] sm:my-0 sm:mr-0 sm:ml-1.5 sm:size-5"
      >
        ⓘ
      </button>
      {open && (
        <span id={id} role="note" className="absolute left-1/2 z-10 mt-1 block w-64 max-w-[80vw] -translate-x-1/2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-left text-xs font-normal leading-relaxed text-[var(--text)] shadow-lg">
          <span className="font-semibold">{entry.term}.</span> {entry.text}
        </span>
      )}
    </span>
  );
}
