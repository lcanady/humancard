/**
 * Sources funding signals from TechCrunch venture/funding RSS + SEC EDGAR
 * Form D Atom (Crunchbase RSS was discontinued).
 *
 * Filename is historical — the original design fetched from Crunchbase RSS
 * which has since been retired. The replacement composite of TechCrunch +
 * SEC EDGAR provides a similar funding-signal stream.
 *
 * Failure isolation: each upstream feed is tried independently; per-item
 * and per-feed errors are logged and skipped. Returns empty on total failure.
 */

import Parser from "rss-parser";

import { logger } from "../../shared/logger.js";
import type { CompanySignal } from "../../shared/types.js";

const TECHCRUNCH_FEEDS: readonly string[] = [
  "https://techcrunch.com/category/venture/feed/",
  "https://techcrunch.com/tag/funding/feed/",
];

const SEC_EDGAR_FORM_D_URL =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=D&dateb=&owner=include&count=40&output=atom";

/** SEC requires a real, identifying User-Agent. */
const SEC_USER_AGENT = "humancard-hunter/0.1.0 (lem@dailycaller.com)";

const COMPANY_RE =
  /^([A-Z][\w\s.&]+?)\s+(?:raises|secures|nabs|closes|lands|announces)\b/u;

const tcParser: Parser = new Parser();
const secParser: Parser = new Parser();

/**
 * Pull funding-signal items from TechCrunch + SEC EDGAR. Items not matching
 * the company-name regex (TechCrunch) are dropped.
 */
export async function fetchFundingSignals(): Promise<CompanySignal[]> {
  const out: CompanySignal[] = [];

  for (const url of TECHCRUNCH_FEEDS) {
    try {
      const feed = await tcParser.parseURL(url);
      for (const item of feed.items) {
        try {
          const sig = parseTechCrunchItem(item);
          if (sig !== null) out.push(sig);
        } catch (err) {
          logger.warn("techcrunch: skipping unparseable item", {
            error: err instanceof Error ? err.message : String(err),
            link: item.link,
          });
        }
      }
    } catch (err) {
      logger.error("techcrunch: feed fetch failed", {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    // SEC blocks default UA; fetch text first then parseString.
    const res = await fetch(SEC_EDGAR_FORM_D_URL, {
      headers: { "User-Agent": SEC_USER_AGENT, Accept: "application/atom+xml" },
    });
    if (!res.ok) {
      logger.error("sec-edgar: non-2xx", { status: res.status });
    } else {
      const xml = await res.text();
      const feed = await secParser.parseString(xml);
      for (const item of feed.items) {
        try {
          const sig = parseSecItem(item);
          if (sig !== null) out.push(sig);
        } catch (err) {
          logger.warn("sec-edgar: skipping unparseable item", {
            error: err instanceof Error ? err.message : String(err),
            link: item.link,
          });
        }
      }
    }
  } catch (err) {
    logger.error("sec-edgar: feed fetch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return out;
}

/** Parse one TechCrunch RSS item into a CompanySignal, or null if it doesn't match. */
function parseTechCrunchItem(item: Parser.Item): CompanySignal | null {
  const title = item.title;
  const link = item.link;
  if (title === undefined || link === undefined) return null;

  const m = COMPANY_RE.exec(title);
  if (m === null || m[1] === undefined) return null;
  const company = m[1].trim();

  const guid = item.guid ?? link;
  const occurredAt = item.isoDate ?? item.pubDate ?? new Date().toISOString();

  return {
    source: "techcrunch",
    externalId: guid,
    url: link,
    company,
    signalType: "funding",
    occurredAt,
    raw: item,
  };
}

/** Parse one SEC EDGAR Atom entry into a CompanySignal. */
function parseSecItem(item: Parser.Item): CompanySignal | null {
  const link = item.link;
  const title = item.title ?? "";
  if (link === undefined) return null;
  const guid = item.guid ?? link;
  const occurredAt =
    item.isoDate ?? item.pubDate ?? new Date().toISOString();

  // EDGAR titles look like: "D - Acme Capital LLC (0001234567) (Filer)".
  // Strip the leading code/dash and the trailing parenthetical metadata.
  let company = title;
  const dashIdx = company.indexOf(" - ");
  if (dashIdx >= 0) company = company.slice(dashIdx + 3);
  const parenIdx = company.indexOf(" (");
  if (parenIdx >= 0) company = company.slice(0, parenIdx);
  company = company.trim();
  if (company.length === 0) company = "Unknown";

  return {
    source: "sec-edgar",
    externalId: guid,
    url: link,
    company,
    signalType: "funding",
    occurredAt,
    raw: item,
  };
}
