"use client";

import { useEffect, useState } from "react";

/** True below Tailwind's `sm` breakpoint (640 px), where charts take their phone layout (SPEC-dashboard Amendment 2). */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 639px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}
