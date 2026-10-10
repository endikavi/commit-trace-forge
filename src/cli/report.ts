import type { Store } from "../storage/state.ts";
import type { Sample } from "../types/index.ts";

/**
 * Run report.
 *
 * Shows everything, including what failed. A run that produced two samples out of a hundred
 * requested says so, with the cause breakdown that explains where the other ninety-eight went.
 */

export interface ReportData {
  runId: string;
  population: Array<{ repository_url: string; examined: number; eligible: number }>;
  candidates: number;
  accepted: number;
  rejectionsByCause: Array<{ stage: string; cause: string; count: number }>;
  exactAcceptances: number;
  behavioralAcceptances: number;
  replayFailures: number;
  usage: ReturnType<Store["totals"]>;
  usageByRole: ReturnType<Store["usageByRole"]>;
  costPerAcceptedSample: number | null;
  costKnown: boolean;
  byRepository: Array<{ repository: string; accepted: number }>;
  bySize: Array<{ bucket: string; accepted: number }>;
  byTaskType: Array<{ type: string; accepted: number }>;
  firstAttemptSuccesses: number;
  withinBudgetSuccesses: number;
  fixtureProvenance: number;
}

export function collectReport(store: Store): ReportData {
  const samples = store.listSamples(false);
  const accepted = samples.filter((s) => (s.sample as Sample).verification.accepted);
  const acceptedSamples = accepted.map((s) => s.sample as Sample);
  const totals = store.totals();

  const bucketOf = (lines: number): string =>
    lines < 25 ? "<25 lines" : lines < 75 ? "25-74" : lines < 150 ? "75-149" : lines < 300 ? "150-299" : ">=300";

  const byRepository = tally(acceptedSamples.map((s) => s.source.repository_url));
  const bySize = tally(acceptedSamples.map((s) => bucketOf(s.metrics.filtered.changed_lines)));
  const byTaskType = tally(acceptedSamples.map((s) => s.task.task_type));

  return {
    runId: store.runId,
    population: store.populationStats(),
    candidates: store.listCandidates().length,
    accepted: acceptedSamples.length,
    rejectionsByCause: store.rejectionCounts(),
    exactAcceptances: acceptedSamples.filter((s) => s.verification.exact_tree_match).length,
    behavioralAcceptances: acceptedSamples.filter(
      (s) => !s.verification.exact_tree_match && s.verification.behavioral_checks_passed,
    ).length,
    replayFailures: samples.filter(
      (s) => (s.sample as Sample).verification.replay?.attempted && !(s.sample as Sample).verification.replay_passed,
    ).length,
    usage: totals,
    usageByRole: store.usageByRole(),
    costPerAcceptedSample:
      acceptedSamples.length > 0 && totals.calls_with_unknown_cost === 0
        ? totals.cost_usd / acceptedSamples.length
        : null,
    costKnown: totals.calls_with_unknown_cost === 0,
    byRepository: byRepository.map(([repository, count]) => ({ repository, accepted: count })),
    bySize: bySize.map(([bucket, count]) => ({ bucket, accepted: count })),
    byTaskType: byTaskType.map(([type, count]) => ({ type, accepted: count })),
    firstAttemptSuccesses: acceptedSamples.filter((s) => s.budget.solved_on_first_attempt).length,
    withinBudgetSuccesses: acceptedSamples.filter((s) => s.budget.solved_within_budget).length,
    fixtureProvenance: acceptedSamples.filter((s) => s.agent.execution_mode === "scripted_fixture").length,
  };
}

function tally(values: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export function formatReport(data: ReportData): string {
  const lines: string[] = [];
  const rule = "-".repeat(72);

  lines.push("", `commit-trace-forge report — run ${data.runId}`, rule, "");

  lines.push("Population");
  for (const row of data.population) {
    lines.push(`  ${row.repository_url}`);
    lines.push(`    examined: ${row.examined}   eligible after filters: ${row.eligible}`);
  }
  lines.push(`  candidates drawn: ${data.candidates}`);
  lines.push("");

  lines.push("Outcomes");
  lines.push(`  accepted samples:                 ${data.accepted}`);
  lines.push(`    accepted by exact reconstruction: ${data.exactAcceptances}`);
  lines.push(`    accepted by behaviour only:       ${data.behavioralAcceptances}`);
  lines.push(`  replay failures:                  ${data.replayFailures}`);
  lines.push(`  solved on the first attempt:      ${data.firstAttemptSuccesses}`);
  lines.push(`  solved within budget:             ${data.withinBudgetSuccesses}`);
  if (data.fixtureProvenance > 0) {
    lines.push(`  from the scripted fixture harness: ${data.fixtureProvenance}  (NOT real model execution)`);
  }
  lines.push("");

  lines.push("Rejections by cause");
  if (data.rejectionsByCause.length === 0) {
    lines.push("  (none recorded)");
  } else {
    for (const row of data.rejectionsByCause) {
      lines.push(`  ${String(row.count).padStart(5)}  ${row.stage.padEnd(9)} ${row.cause}`);
    }
  }
  lines.push("");

  lines.push("Cost and usage");
  lines.push(`  model calls:     ${data.usage.calls}`);
  lines.push(`  tokens:          ${data.usage.total_tokens} (in ${data.usage.input_tokens} / out ${data.usage.output_tokens})`);
  if (data.costKnown) {
    lines.push(`  cost:            $${data.usage.cost_usd.toFixed(4)}`);
    lines.push(
      `  cost per accepted sample: ${
        data.costPerAcceptedSample !== null ? `$${data.costPerAcceptedSample.toFixed(4)}` : "n/a (no accepted samples)"
      }`,
    );
  } else {
    lines.push(`  cost:            $${data.usage.cost_usd.toFixed(4)} over priced calls`);
    lines.push(
      `  ${data.usage.calls_with_unknown_cost} call(s) used a model with no published price. ` +
        `Cost per accepted sample is UNKNOWN and is not estimated.`,
    );
  }
  for (const row of data.usageByRole) {
    lines.push(
      `    ${row.role.padEnd(16)} ${String(row.calls).padStart(4)} calls  ${String(row.total_tokens).padStart(9)} tokens` +
        (row.unknown_cost > 0 ? `  (${row.unknown_cost} unpriced)` : `  $${row.cost_usd.toFixed(4)}`),
    );
  }
  lines.push("");

  lines.push("Accepted sample distribution");
  lines.push("  by repository");
  for (const row of data.byRepository) lines.push(`    ${String(row.accepted).padStart(4)}  ${row.repository}`);
  if (data.byRepository.length === 0) lines.push("    (none)");
  lines.push("  by change size");
  for (const row of data.bySize) lines.push(`    ${String(row.accepted).padStart(4)}  ${row.bucket}`);
  if (data.bySize.length === 0) lines.push("    (none)");
  lines.push("  by task type");
  for (const row of data.byTaskType) lines.push(`    ${String(row.accepted).padStart(4)}  ${row.type}`);
  if (data.byTaskType.length === 0) lines.push("    (none)");
  lines.push("");

  return lines.join("\n");
}
