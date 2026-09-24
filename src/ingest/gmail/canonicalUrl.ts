// src/ingest/gmail/canonicalUrl.ts
const TRACKING_PARAMS = /^(utm_.*|trackingid|refid|lipi|midtoken|midsig|trk|trkemail|eid|otptoken|mc_cid|mc_eid|gclid|fbclid)$/i;
const KNOWN_JOB_HOSTS = /(^|\.)(linkedin\.com|ejobs\.ro|bestjobs\.eu|hipo\.ro)$/i;

/** Stable URL for deduplication: strips tracking params, normalizes LinkedIn job links. */
export function canonicalUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const linkedInJob = /\/jobs\/view\/(?:[^/]*-)?(\d{6,})/.exec(url.pathname);
  if (/(^|\.)linkedin\.com$/i.test(url.hostname) && linkedInJob?.[1]) {
    return `https://www.linkedin.com/jobs/view/${linkedInJob[1]}/`;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.hash = "";
  return url.toString();
}

/**
 * Newsletter links are often click-tracking redirects (e.g. sendgrid). Resolve them to the real
 * posting URL so dedupe works. Known job hosts are returned as-is (no extra request).
 */
export async function resolveJobUrl(raw: string, signal: AbortSignal): Promise<string> {
  try {
    if (KNOWN_JOB_HOSTS.test(new URL(raw).hostname)) return canonicalUrl(raw);
    const response = await fetch(raw, { method: "HEAD", redirect: "follow", signal });
    return canonicalUrl(response.url || raw);
  } catch {
    return canonicalUrl(raw); // unresolvable redirect: keep it, the posting is still reviewable
  }
}
