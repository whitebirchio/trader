import { overviewView } from "@trader/core";
import { signedIn } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const { config, db } = await signedIn();
  const o = await overviewView(db, config.env, new Date());
  return <pre className="p-6 text-xs">{JSON.stringify(o, null, 2)}</pre>;
}
