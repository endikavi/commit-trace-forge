/**
 * Secret and personal-data scanning.
 *
 * Applied to everything that would be exported: the request, the criteria, the fact sheet and
 * every event's text and tool output.
 *
 * These patterns catch the common cases. They are not a guarantee, and the documentation says so:
 * a clean scan means "these detectors found nothing", not "this sample contains no secrets".
 */

export interface Finding {
  kind: "secret" | "pii";
  detector: string;
  where: string;
  /** A masked excerpt. The raw value is never copied into a report. */
  excerpt: string;
}

interface Detector {
  kind: "secret" | "pii";
  name: string;
  pattern: RegExp;
  /** Reject obvious false positives (documentation placeholders, example values). */
  ignore?: RegExp;
}

const DETECTORS: Detector[] = [
  { kind: "secret", name: "aws_access_key_id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "secret", name: "aws_secret_access_key", pattern: /\baws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi },
  { kind: "secret", name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: "secret", name: "anthropic_api_key", pattern: /\bsk-ant-(?:api|oat)[0-9]{2}-[A-Za-z0-9_-]{20,}/g },
  { kind: "secret", name: "openai_api_key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g },
  { kind: "secret", name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "secret", name: "slack_token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { kind: "secret", name: "private_key_block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { kind: "secret", name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    kind: "secret",
    name: "generic_assigned_secret",
    pattern: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|password|passwd)\s*[=:]\s*['"][^'"\s]{12,}['"]/gi,
    // Placeholders in documentation and tests are not secrets.
    ignore: /(?:xxx|placeholder|example|changeme|your[_-]?|dummy|fake|test|<[^>]+>|\$\{|\{\{)/i,
  },
  {
    kind: "pii",
    name: "email_address",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    // Commit authorship and obvious non-addresses are expected in this material.
    ignore: /(?:example\.(?:com|org|net)|\.invalid$|noreply|users\.noreply\.github\.com|localhost)/i,
  },
  { kind: "pii", name: "iban", pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}\b/g },
  {
    kind: "pii",
    name: "credit_card",
    pattern: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6011)[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g,
  },
];

function mask(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}${"*".repeat(Math.min(12, value.length - 8))}${value.slice(-4)}`;
}

export function scanText(text: string, where: string): Finding[] {
  const findings: Finding[] = [];
  for (const detector of DETECTORS) {
    detector.pattern.lastIndex = 0;
    for (const match of text.matchAll(detector.pattern)) {
      const value = match[0];
      if (detector.ignore?.test(value)) continue;
      findings.push({ kind: detector.kind, detector: detector.name, where, excerpt: mask(value) });
    }
  }
  return findings;
}

export function scanRecord(record: unknown, prefix = "$"): Finding[] {
  const findings: Finding[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      findings.push(...scanText(value, path));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(record, prefix);
  return findings;
}

/**
 * Redact findings in place.
 *
 * Redaction rewrites real tool output, so anything redacted stops being a faithful record of the
 * execution. The caller must re-verify afterwards, and exclude the sample when the redacted text
 * no longer matches what the commands actually produced.
 */
export function redactText(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;
  for (const detector of DETECTORS) {
    detector.pattern.lastIndex = 0;
    out = out.replace(detector.pattern, (value) => {
      if (detector.ignore?.test(value)) return value;
      redactions++;
      return `[REDACTED:${detector.name}]`;
    });
  }
  return { text: out, redactions };
}

export function summarise(findings: readonly Finding[]): string {
  if (findings.length === 0) return "no secret or personal-data detector fired";
  const byDetector = new Map<string, number>();
  for (const finding of findings) byDetector.set(finding.detector, (byDetector.get(finding.detector) ?? 0) + 1);
  return [...byDetector.entries()].map(([name, count]) => `${name} x${count}`).join(", ");
}
