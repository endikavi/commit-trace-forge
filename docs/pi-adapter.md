# The Pi adapter

Pi is [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi), pinned to
**0.85.1** in `pnpm-lock.yaml`. Everything below was verified against the installed package's
type definitions and documentation, not assumed.

## Pinned surface

| Export | Used for |
| --- | --- |
| `createAgentSession(options)` | one agent session |
| `defineTool({ name, label, description, parameters, execute })` | bridging a forge tool |
| `DefaultResourceLoader(options)` | disabling every discovery mechanism |
| `ModelRuntime.create({ authPath?, modelsPath? })` | model resolution and credentials |
| `SessionManager.inMemory(cwd)` | no session files on disk |
| `SettingsManager.inMemory(settings)` | no settings files on disk |
| `session.prompt(text)` / `session.abort()` / `session.messages` | driving and reading a run |

Relevant option shapes, verbatim from `dist/core/sdk.d.ts`:

```ts
interface CreateAgentSessionOptions {
  cwd?: string;
  agentDir?: string;
  modelRuntime?: ModelRuntime;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  noTools?: "all" | "builtin";
  tools?: string[];
  excludeTools?: string[];
  customTools?: ToolDefinition[];
  resourceLoader?: ResourceLoader;
  sessionManager?: SessionManager;
  settingsManager?: SettingsManager;
}
```

`ToolDefinition.parameters` is a TypeBox `TSchema`, which is a JSON Schema object at runtime, so
the forge tools declare plain JSON Schema and pass it through.

`ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx)` returns
`{ content: [{ type: "text", text }], details, isError? }`.

`AssistantMessage.usage` is pi-ai's `Usage`: `{ input, output, cacheRead, cacheWrite, totalTokens, cost: { total, ... } }`.

## Isolation settings, and why

```ts
const resourceLoader = new DefaultResourceLoader({
  cwd: scratch,
  agentDir: scratch,
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  systemPromptOverride: () => solverPrompt,
  extensionFactories: [pinSystemPrompt(solverPrompt)],
});

const { session } = await createAgentSession({
  cwd: scratch,
  agentDir: scratch,
  model,
  thinkingLevel: "off",
  modelRuntime,
  noTools: "all",
  tools: forgeTools.map((t) => t.name),
  customTools,
  resourceLoader,
  sessionManager: SessionManager.inMemory(scratch),
  settingsManager: SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
  }),
});
```

- **`no*: true`** — pi would otherwise discover extensions, skills, prompt templates, themes and
  `AGENTS.md`/`CLAUDE.md` from the working directory and from `~/.pi/agent`. The repository under
  test is untrusted input; a file inside it must not be able to change the supervisor's rules.
- **`noTools: "all"` plus an explicit allowlist** — pi's built-in `read`/`bash`/`edit`/`write`
  operate on the host filesystem. Every forge tool executes inside the sandbox container instead.
- **`cwd`/`agentDir` point at a throwaway temp directory** — pi uses them for session naming and
  relative path resolution. Nothing the agent does touches them.
- **`pinSystemPrompt`** — pi appends `Current working directory: <cwd>` to every custom system
  prompt. That cwd is the host temp directory above, which the agent cannot reach (its tools run
  in the container), so the line would leak a host path — including the host user name — into the
  trajectory and send the agent looking for a directory that does not exist. An inline extension
  returns the exact prompt from pi's `before_agent_start` hook; inline factories load even with
  `noExtensions`. A unit test pins this behaviour.
- **In-memory session and settings** — no host session file is read or written, and the host's
  `~/.pi/agent/settings.json` cannot influence a run.
- **`compaction: { enabled: false }`** — compaction rewrites the transcript mid-run, which would
  break the correspondence between recorded events and what actually happened.
- **`thinkingLevel` from config, default `"off"`** — provider reasoning blocks are dropped when
  collecting messages and never reach the dataset.

## Where the credential lives

The `ModelRuntime` lives in the forge process. The provider credential is never placed in the
container's environment and is never reachable from the shell the solver drives via
`run_command`; that shell runs inside a container with no network at all by default.

## Recording

Tool calls and results are recorded **inside the tool wrapper**, at the moment of execution, so a
recorded call is exactly what the agent invoked and a recorded result is exactly what the sandbox
returned. Assistant prose and token usage are then read from `session.messages`.

`ask_user` is recorded as a `user_question` / `user_answer` pair rather than a tool call, because
that is what it is: the answer comes from the simulated user, not from executing anything.

## Cost accounting

`modelHasKnownPrice()` checks whether the model's catalog entry declares numeric `cost.input` and
`cost.output`. If not, `cost_known` is `false` and `cost_usd` is `null` — the price is unknown and
the pipeline says so instead of guessing.

An explicitly declared price of zero — a self-hosted OpenAI-compatible endpoint, for instance — is
a **known** cost of zero. That is a different thing from an unknown price, and the two are not
conflated.

## Swapping the harness

`AgentHarness` in `src/harness/types.ts` is the whole contract:

```ts
interface AgentHarness {
  readonly name: string;
  readonly version: string;
  available(model): Promise<{ ok: boolean; detail: string }>;
  solve(request: SolveRequest): Promise<SolveResponse>;
}
```

The dataset logic never imports `PiHarness` directly. Two implementations ship:

- **`PiHarness`** — the real adapter above.
- **`ScriptedHarness`** — replays a fixed script. The script is synthetic; the **tool execution is
  real**, against a real container. It exists for testing verification and replay without a model,
  and its trajectories are stamped `execution_mode: "scripted_fixture"` and refused by the
  exporter unless explicitly opted into.

`ModelProvider` is the parallel contract for the single-shot structured calls (grader, task
generator, task reviewer, user simulator, judge). `PiModelProvider` implements it through the same
adapter, so there is one model path, one credential path and one usage ledger.

## Custom providers

Any provider declared in `~/.pi/agent/models.json` works, including OpenAI-compatible endpoints:

```json
{
  "providers": {
    "my-endpoint": {
      "baseUrl": "http://localhost:8000/v1",
      "api": "openai-completions",
      "apiKey": "none",
      "models": [
        { "id": "my-model", "contextWindow": 262144, "maxTokens": 65536,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
      ]
    }
  }
}
```

then in the forge config:

```yaml
model:
  provider: my-endpoint
  model: my-model
```

or, without touching the config, `export FORGE_MODEL=my-endpoint/my-model`.

`forge doctor` resolves the model and checks the credential before any stage runs, and reports
PENDING rather than failing silently when it cannot.
