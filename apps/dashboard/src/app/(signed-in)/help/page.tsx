import { Card } from "@/components/ui";
import { GLOSSARY } from "@/lib/glossary";

// Signed in, like every page here: rendered per request and never cached (SPEC-dashboard § Boundaries).
export const dynamic = "force-dynamic";

/** How to read the dashboard (SPEC-dashboard Amendment 3): every term an ⓘ explains, in one list. */
export default function HelpPage() {
  return (
    <Card title="How to read this">
      <dl className="divide-y divide-[var(--border)] text-sm">
        {Object.entries(GLOSSARY).map(([key, e]) => (
          <div key={key} id={key} className="py-2.5">
            <dt className="font-semibold">{e.term}</dt>
            <dd className="mt-0.5 leading-relaxed text-[var(--muted)]">{e.text}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
