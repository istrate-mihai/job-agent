// src/ingest/sources/index.ts
import type { SearchConfig } from "../../config/searchConfig.js";
import type { JobSource } from "../types.js";
import { gmailSource } from "./gmail.js";
import { greenhouseSource } from "./greenhouse.js";
import { jobicySource } from "./jobicy.js";
import { leverSource } from "./lever.js";
import { remotiveSource } from "./remotive.js";
import { smartRecruitersSource } from "./smartrecruiters.js";
import { webBoardSource } from "./webBoard.js";

export function buildSources(config: SearchConfig): JobSource[] {
  const { gmail, remotive, jobicy, smartrecruiters, greenhouse, lever, boards } = config.sources;
  return [
    ...(gmail.enabled ? [gmailSource(config)] : []),
    ...(remotive.enabled ? [remotiveSource(remotive.categories)] : []),
    ...(jobicy.enabled ? [jobicySource(jobicy.geos, jobicy.count)] : []),
    ...smartrecruiters.map((s) => smartRecruitersSource(s.company, s.companyId, s.country, config.titles)),
    ...greenhouse.map((g) => greenhouseSource(g.company, g.boardToken)),
    ...lever.map((l) => leverSource(l.company, l.slug, l.region)),
    ...boards.filter((b) => b.enabled).map((b) => webBoardSource(b, config)),
  ];
}
