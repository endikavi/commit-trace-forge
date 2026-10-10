/**
 * Implementation versions per stage.
 *
 * These participate in each stage's `input_hash`. Bump the version of a stage whenever its
 * behaviour changes in a way that should invalidate previously cached outputs. Image builds are
 * keyed separately (by recipe hash) so bumping, say, the task generator never forces a rebuild
 * of an otherwise valid container image.
 */
export const IMPL_VERSIONS = {
  mine: "1",
  // 2: snapshot files keep their commit mtime (never 1970), so zip-based Python builds install.
  prepare: "2",
  grade: "1",
  generate: "1",
  // 2: pinned system prompt (no host cwd) and sequential tool execution in the pi adapter.
  // 3: tool calls pi answered without executing are recorded with origin "harness".
  solve: "3",
  // 2: replay skips tool calls the harness refused without executing.
  verify: "2",
  replay: "1",
  export: "1",
} as const;

/** Prompt file versions, resolved at load time from prompts/<role>/<version>.md. */
export const PROMPT_VERSIONS = {
  grader: "v1",
  taskgen: "v1",
  taskreview: "v1",
  solver: "v1",
  user_simulator: "v1",
  judge: "v1",
} as const;

export type PromptRole = keyof typeof PROMPT_VERSIONS;

export const ADAPTER_VERSION = "pi-adapter/2";
export const HARNESS_TOOLS_VERSION = "forge-tools/1";
