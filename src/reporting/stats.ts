// src/reporting/stats.ts
// Reply-rate breakdowns shared by `npm run stats` and the GUI.
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export interface Row {
  bucket: string;
  applied: number;
  responded: number;
  interview: number;
  rejected: number;
  silent: number;
}

const RESPONDED = `p.status in ('responded','interview','offer') or exists (select 1 from status_events e where e.posting_id = p.id and e.to_status in ('responded','interview','offer'))`;
const INTERVIEW = `p.status in ('interview','offer') or exists (select 1 from status_events e where e.posting_id = p.id and e.to_status in ('interview','offer'))`;
const APPLIED = `exists (select 1 from status_events e where e.posting_id = p.id and e.to_status = 'applied')`;

export async function breakdown(label: string, bucketExpr: string): Promise<{ label: string; rows: Row[] }> {
  const result = await db.execute(
    sql.raw(`
      select ${bucketExpr} as bucket,
             count(*)::int as applied,
             count(*) filter (where ${RESPONDED})::int as responded,
             count(*) filter (where ${INTERVIEW})::int as interview,
             count(*) filter (where p.status = 'rejected')::int as rejected,
             count(*) filter (where p.status = 'applied')::int as silent
      from postings p
      left join posting_scores s on s.posting_id = p.id
      where ${APPLIED}
      group by 1
      order by 2 desc`),
  );
  const rows = result.rows as unknown as Row[];
  return { label, rows };
}

export const BREAKDOWNS: readonly { label: string; expr: string }[] = [
  { label: "All applications", expr: `'total'` },
  { label: "By source", expr: `p.source` },
  { label: "By score band", expr: `case when s.total >= 80 then '80+' when s.total >= 70 then '70-79' when s.total >= 60 then '60-69' when s.total is null then 'unscored' else '<60' end` },
  { label: "By location", expr: `coalesce(p.location_tier::text, 'unknown')` },
  {
    label: "By outreach",
    expr: `case when exists (select 1 from outreach o where o.posting_id = p.id and o.kind <> 'followup' and o.status <> 'drafted') then 'contacted a person' else 'ATS only' end`,
  },
  {
    label: "By days to reject (fast = automated screen)",
    expr: `case when p.status <> 'rejected' then 'not rejected'
          when (select max(e.created_at) from status_events e where e.posting_id = p.id and e.to_status = 'rejected')
             - (select max(e.created_at) from status_events e where e.posting_id = p.id and e.to_status = 'applied') < interval '3 days' then 'rejected < 3 days'
          else 'rejected later' end`,
  },
];

export async function allBreakdowns(): Promise<{ label: string; rows: Row[] }[]> {
  const out: { label: string; rows: Row[] }[] = [];
  for (const b of BREAKDOWNS) out.push(await breakdown(b.label, b.expr)); // sequential: pool max is 5
  return out.filter((b) => b.rows.length > 0);
}
