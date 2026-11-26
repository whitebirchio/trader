/** The old pages' URLs and where they live now (SPEC-dashboard Amendment 3): permanent (308), keeping the query string. */
export const REDIRECTS = [
  { source: "/holdings", destination: "/positions", permanent: true },
  { source: "/track-record", destination: "/history", permanent: true },
  { source: "/activity", destination: "/history/activity", permanent: true },
  { source: "/strategy", destination: "/history/strategy", permanent: true },
  { source: "/strategy/:version", destination: "/history/strategy/:version", permanent: true },
];
