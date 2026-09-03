// scripts/geo-trust-report.js
// Geo Trust Report — Layer 2 of the Geo Trust pipeline.
//
// Consumes the output of audit-geo-coverage.js (Layer 1) and produces
// decision-support metrics: trust scores, certification coverage, ranking
// readiness, and backfill prioritization.
//
// This layer does NOT:
//   - reclassify stores
//   - perform geo resolution
//   - modify store data
//   - write to Firebase
//   - implement a ranking engine
//
// Usage (piped):
//   node audit-geo-coverage.js | node geo-trust-report.js
//
// Usage (from file):
//   node geo-trust-report.js < audit-2026-06-24.json
//   node geo-trust-report.js < audit-2026-06-24.json > report-2026-06-24.json
//
// Layer boundary:
//   Audit measures reality.
//   Report evaluates readiness.
//   Ranking consumes readiness — it must never inspect audit buckets directly.
//
// Assumptions:
//   - Audit input arrives on stdin as a single JSON object.
//   - Input conforms to the audit output shape from audit-geo-coverage.js.
//   - If a chain or global section is missing expected bucket fields, the
//     missing value is treated as 0 (fail-closed: unknown degrades trust).
//   - Trust score is an observability metric only. It must not drive ranking.
//   - Thresholds are configurable at the top of this file.

// ── Thresholds (configurable) ─────────────────────────────────────────────────

const RANKING_READINESS = {
  HIGH_CERTIFIED_COVERAGE:   0.80,  // certifiedCoverage >= this → high
  MEDIUM_CERTIFIED_COVERAGE: 0.50,  // certifiedCoverage >= this → medium
};

const BACKFILL_PRIORITY = {
  // HIGH when any of:
  HIGH_REPAIR_GAP:              0.20,  // repairGap >= this
  HIGH_CANDIDATE_COVERAGE:      0.30,  // candidateCoverage >= this (large backfill opportunity)
  HIGH_MAX_CERTIFIED_CEILING:   0.60,  // certifiedCoverage < this (room to grow)
  // MEDIUM when any of:
  MEDIUM_REPAIR_GAP:            0.05,
  MEDIUM_CANDIDATE_COVERAGE:    0.10,
  MEDIUM_MAX_CERTIFIED_CEILING: 0.90,
  // LOW: everything else (mostly certified, minimal repair work)
};

// ── Trust tier weights ────────────────────────────────────────────────────────
// These are observability weights only. They must not be used to gate ranking.

const TRUST_WEIGHT = {
  certified:  1.00,
  candidate:  0.70,
  suspicious: 0.35,
  inferred:   0.20,
  unusable:   0.00,
};

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {"low"|"medium"|"high"} ReadinessLevel
 */

/**
 * @typedef {{
 *   certified: number,
 *   candidate: number,
 *   suspicious: number,
 *   inferred: number,
 *   unusable: number,
 *   storesTotal: number
 * }} TierCounts
 */

/**
 * @typedef {{
 *   trustScore: number,
 *   certifiedCoverage: number,
 *   candidateCoverage: number,
 *   repairGap: number,
 *   rankingReadiness: ReadinessLevel,
 *   backfillPriority: ReadinessLevel
 * }} TrustMetrics
 */

// ── Audit input extraction ────────────────────────────────────────────────────

/**
 * Extracts trust tier counts from an audit section (global or per-chain).
 * Missing fields are treated as 0 — fail-closed: unknown degrades trust, never elevates it.
 *
 * Maps from audit bucket counts to trust tier groups:
 *   certified  = direct_coords + resolved_coords
 *   candidate  = legacy_import_coords
 *   suspicious = legacy_noisy_coords
 *   inferred   = heuristic_coords
 *   unusable   = address_only + invalid_coords + missing_geo
 *
 * @param {any} section  — global or per-chain audit output
 * @returns {TierCounts}
 */
function extractTierCounts(section) {
  const b = section?.buckets ?? {};
  const n = (key) => Number(b[key] ?? 0);

  const certified  = n('direct_coords')        + n('resolved_coords');
  const candidate  = n('legacy_import_coords');
  const suspicious = n('legacy_noisy_coords');
  const inferred   = n('heuristic_coords');
  const unusable   = n('address_only')         + n('invalid_coords') + n('missing_geo');

  const storesTotal = Number(section?.storesTotal ?? 0);

  return { certified, candidate, suspicious, inferred, unusable, storesTotal };
}

// ── Trust score ───────────────────────────────────────────────────────────────

/**
 * Calculates the weighted trust score for a set of tier counts.
 * Returns 0 when storesTotal is 0 to avoid division by zero.
 *
 * This is an observability metric. Do not use it as a ranking gate.
 *
 * @param {TierCounts} t
 * @returns {number}  0..1, rounded to 3 decimal places
 */
function calcTrustScore(t) {
  if (t.storesTotal === 0) return 0;
  const raw = (
    t.certified  * TRUST_WEIGHT.certified  +
    t.candidate  * TRUST_WEIGHT.candidate  +
    t.suspicious * TRUST_WEIGHT.suspicious +
    t.inferred   * TRUST_WEIGHT.inferred
    // unusable contributes 0
  ) / t.storesTotal;
  return Math.round(raw * 1000) / 1000;
}

// ── Coverage metrics ──────────────────────────────────────────────────────────

/**
 * @param {TierCounts} t
 * @returns {{ certifiedCoverage: number, candidateCoverage: number, repairGap: number }}
 */
function calcCoverage(t) {
  if (t.storesTotal === 0) {
    return { certifiedCoverage: 0, candidateCoverage: 0, repairGap: 0 };
  }
  return {
    certifiedCoverage: round3(t.certified / t.storesTotal),
    candidateCoverage: round3(t.candidate / t.storesTotal),
    repairGap:         round3((t.suspicious + (t.unusable)) / t.storesTotal),
  };
}

// ── Readiness classification ──────────────────────────────────────────────────

/**
 * @param {number} certifiedCoverage  0..1
 * @returns {ReadinessLevel}
 */
function calcRankingReadiness(certifiedCoverage) {
  if (certifiedCoverage >= RANKING_READINESS.HIGH_CERTIFIED_COVERAGE)   return 'high';
  if (certifiedCoverage >= RANKING_READINESS.MEDIUM_CERTIFIED_COVERAGE) return 'medium';
  return 'low';
}

/**
 * @param {number} repairGap
 * @param {number} candidateCoverage
 * @param {number} certifiedCoverage
 * @param {number} storesTotal
 * @returns {ReadinessLevel}
 */
function calcBackfillPriority(repairGap, candidateCoverage, certifiedCoverage, storesTotal) {
  // Small chains with no repair work needed are low priority regardless of coverage ratios.
  if (storesTotal === 0) return 'low';

  const bp = BACKFILL_PRIORITY;

  const isHigh =
    repairGap         >= bp.HIGH_REPAIR_GAP             ||
    candidateCoverage >= bp.HIGH_CANDIDATE_COVERAGE      ||
    certifiedCoverage <  bp.HIGH_MAX_CERTIFIED_CEILING;

  if (isHigh) return 'high';

  const isMedium =
    repairGap         >= bp.MEDIUM_REPAIR_GAP            ||
    candidateCoverage >= bp.MEDIUM_CANDIDATE_COVERAGE    ||
    certifiedCoverage <  bp.MEDIUM_MAX_CERTIFIED_CEILING;

  if (isMedium) return 'medium';

  return 'low';
}

// ── Metrics builder ───────────────────────────────────────────────────────────

/**
 * Derives all trust metrics from tier counts.
 *
 * @param {TierCounts} t
 * @returns {TrustMetrics}
 */
function buildMetrics(t) {
  const trustScore              = calcTrustScore(t);
  const { certifiedCoverage, candidateCoverage, repairGap } = calcCoverage(t);
  const rankingReadiness        = calcRankingReadiness(certifiedCoverage);
  const backfillPriority        = calcBackfillPriority(repairGap, candidateCoverage, certifiedCoverage, t.storesTotal);

  return { trustScore, certifiedCoverage, candidateCoverage, repairGap, rankingReadiness, backfillPriority };
}

// ── Per-chain report ──────────────────────────────────────────────────────────

/**
 * Builds a report section for a single chain.
 *
 * @param {string} chainId
 * @param {any} chainAudit  — per-chain section from audit output
 * @returns {object}
 */
function buildChainReport(chainId, chainAudit) {
  const t = extractTierCounts(chainAudit);
  const m = buildMetrics(t);

  return {
    chainId,
    storesTotal:       t.storesTotal,
    certified:         t.certified,
    candidate:         t.candidate,
    suspicious:        t.suspicious,
    inferred:          t.inferred,
    unusable:          t.unusable,
    trustScore:        m.trustScore,
    certifiedCoverage: m.certifiedCoverage,
    candidateCoverage: m.candidateCoverage,
    repairGap:         m.repairGap,
    rankingReadiness:  m.rankingReadiness,
    backfillPriority:  m.backfillPriority,
  };
}

// ── Duplicate cluster severity ────────────────────────────────────────────────

/**
 * Passes through duplicate cluster diagnostics from the audit without recomputing.
 *
 * @param {any} auditDiagnostics
 * @returns {object}
 */
function extractDuplicateClusterSeverity(auditDiagnostics) {
  const d = auditDiagnostics?.duplicateCoordClusters ?? {};
  return {
    maxClusterSize:          Number(d.maxClusterSize          ?? 0),
    clustersOverThreshold:   Number(d.clustersOverThreshold   ?? 0),
    storesInDuplicateClusters: Number(d.storesInDuplicateClusters ?? 0),
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data',  chunk => chunks.push(chunk));
    process.stdin.on('end',   ()    => resolve(chunks.join('')));
    process.stdin.on('error', err   => reject(err));
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch (err) {
    process.stderr.write(`ERROR: Failed to read stdin: ${err.message}\n`);
    process.exit(1);
  }

  let audit;
  try {
    audit = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`ERROR: Invalid JSON on stdin: ${err.message}\n`);
    process.exit(1);
  }

  if (!audit || typeof audit !== 'object') {
    process.stderr.write('ERROR: Audit input must be a JSON object.\n');
    process.exit(1);
  }

  // Global metrics
  const globalTiers   = extractTierCounts(audit);
  const globalMetrics = buildMetrics(globalTiers);

  // Per-chain metrics
  const chainReports = {};
  if (audit.chains && typeof audit.chains === 'object') {
    for (const [chainId, chainAudit] of Object.entries(audit.chains)) {
      chainReports[chainId] = buildChainReport(chainId, chainAudit);
    }
  }

  const output = {
    reportVersion: 1,
    reportName:    'geo_trust_report',
    generatedAt:   new Date().toISOString(),
    auditedAt:     audit.auditedAt ?? audit.generatedAt ?? null,

    summary: {
      storesTotal:       globalTiers.storesTotal,
      certified:         globalTiers.certified,
      candidate:         globalTiers.candidate,
      suspicious:        globalTiers.suspicious,
      inferred:          globalTiers.inferred,
      unusable:          globalTiers.unusable,
      trustScore:        globalMetrics.trustScore,
      certifiedCoverage: globalMetrics.certifiedCoverage,
      candidateCoverage: globalMetrics.candidateCoverage,
      repairGap:         globalMetrics.repairGap,
      rankingReadiness:  globalMetrics.rankingReadiness,
      backfillPriority:  globalMetrics.backfillPriority,
    },

    duplicateClusterSeverity: extractDuplicateClusterSeverity(audit.diagnostics),

    chains: chainReports,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch(err => {
  process.stderr.write(`ERROR: Unhandled error: ${err.message}\n`);
  process.exit(1);
});
