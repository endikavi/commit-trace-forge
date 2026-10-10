import type { TaskSpec } from "../types/index.ts";

/**
 * Deterministic leak detection.
 *
 * The independent reviewer is a model and can be wrong; these checks cannot be talked out of a
 * finding. They are conservative on purpose: a public API name the user could plausibly know is
 * not a leak, but a private identifier that only exists in the patch is.
 */

export interface LeakScanInput {
  task: TaskSpec;
  targetSha: string;
  parentSha: string;
  commitMessage: string;
  patch: string;
  parentPaths: readonly string[];
}

const META_PHRASES = [
  /\bthis commit\b/i,
  /\bthe commit\b/i,
  /\bthe original (fix|patch|change|commit|implementation)\b/i,
  /\breproduce the (commit|patch|change)\b/i,
  /\bthe historical (fix|patch|solution)\b/i,
  /\brevert\s+[0-9a-f]{7,40}\b/i,
  /\bcherry[- ]pick\b/i,
  /\bgit (show|log|diff)\b/i,
];

export function detectLeaks(input: LeakScanInput): string[] {
  const findings: string[] = [];
  const surfaces: Array<{ label: string; text: string }> = [
    { label: "user_prompt", text: input.task.user_prompt },
    ...input.task.acceptance_criteria.map((c, i) => ({ label: `acceptance_criteria[${i}]`, text: c })),
    ...input.task.user_fact_sheet.map((f, i) => ({ label: `user_fact_sheet[${i}]`, text: `${f.topic}: ${f.fact}` })),
    { label: "ambiguity_assessment.notes", text: input.task.ambiguity_assessment.notes },
    ...input.task.ambiguity_assessment.likely_questions.map((q, i) => ({
      label: `ambiguity_assessment.likely_questions[${i}]`,
      text: q,
    })),
  ];

  const shaPrefixes = [input.targetSha, input.parentSha].flatMap((sha) => [sha, sha.slice(0, 12), sha.slice(0, 8), sha.slice(0, 7)]);
  const addedIdentifiers = privateIdentifiersAddedBy(input.patch);
  const addedLines = significantAddedLines(input.patch);
  const commitSubject = input.commitMessage.split("\n")[0]?.trim() ?? "";

  for (const { label, text } of surfaces) {
    if (text.trim().length === 0) continue;

    for (const sha of shaPrefixes) {
      if (sha.length >= 7 && text.toLowerCase().includes(sha.toLowerCase())) {
        findings.push(`${label} contains a commit SHA (${sha.slice(0, 12)})`);
      }
    }

    for (const phrase of META_PHRASES) {
      const match = phrase.exec(text);
      if (match) findings.push(`${label} refers to the history rather than the desired behaviour: "${match[0]}"`);
    }

    if (commitSubject.length >= 20 && text.includes(commitSubject)) {
      findings.push(`${label} quotes the commit subject verbatim: "${commitSubject}"`);
    }

    for (const identifier of addedIdentifiers) {
      const boundary = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(identifier)}([^A-Za-z0-9_]|$)`);
      if (boundary.test(text)) {
        findings.push(`${label} names "${identifier}", a private identifier that only the patch introduces`);
      }
    }

    for (const line of addedLines) {
      if (line.length >= 30 && text.includes(line)) {
        findings.push(`${label} contains a literal line from the patch: "${line.slice(0, 60)}"`);
      }
    }
  }

  return [...new Set(findings)];
}

/**
 * Identifiers the patch adds that a user could not know.
 *
 * Only private names are reported: a leading underscore in Python/JS, or a name that appears
 * nowhere in the pre-change side of the diff. Public API names are legitimate in a user request.
 */
function privateIdentifiersAddedBy(patch: string): string[] {
  const added: string[] = [];
  const removedText: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removedText.push(line.slice(1));
  }
  const before = removedText.join("\n");

  const declarations = /(?:^|\s)(?:def|class|function|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const found = new Set<string>();
  for (const line of added) {
    for (const match of line.matchAll(declarations)) {
      const name = match[1];
      if (!name || name.length < 4) continue;
      if (!name.startsWith("_")) continue; // only private names are treated as leaks
      if (before.includes(name)) continue; // it already existed
      found.add(name);
    }
  }
  return [...found];
}

/** Added lines with enough substance that quoting them would hand over the implementation. */
function significantAddedLines(patch: string): string[] {
  const lines: string[] = [];
  for (const raw of patch.split("\n")) {
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    const line = raw.slice(1).trim();
    if (line.length < 30) continue;
    if (line.startsWith("#") || line.startsWith("//") || line.startsWith("*")) continue;
    lines.push(line);
  }
  return lines;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
