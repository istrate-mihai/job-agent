// src/ingest/sources/index.ts
import type { SearchConfig } from "../../config/searchConfig.js";
import type { JobSource } from "../types.js";
import { greenhouseSource } from "./greenhouse.js";
import { leverSource } from "./lever.js";
import { remotiveSource } from "./remotive.js";

export function buildSources(config: SearchConfig): JobSource[] {
  const { remotive, greenhouse, lever } = config.sources;
  return [
    ...(remotive.enabled ? [remotiveSource(remotive.categories)] : []),
    ...greenhouse.map((g) => greenhouseSource(g.company, g.boardToken)),
    ...lever.map((l) => leverSource(l.company, l.slug, l.region)),
  ];
}
