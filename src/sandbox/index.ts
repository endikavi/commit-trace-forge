import type { SandboxConfig } from "../config/schema.ts";
import type { Logger } from "../util/logger.ts";
import { DockerBackend } from "./docker.ts";
import { LocalBackend } from "./local.ts";
import type { SandboxBackend } from "./types.ts";

export * from "./types.ts";
export { DockerBackend } from "./docker.ts";
export { LocalBackend } from "./local.ts";

/** Build the configured sandbox backend. Swapping backends is a config change, not a code change. */
export function createSandboxBackend(config: SandboxConfig, logger: Logger): SandboxBackend {
  switch (config.backend) {
    case "docker":
      return new DockerBackend({
        command: config.docker_command,
        logger: logger.child("docker"),
        defaultTimeoutMs: config.provision_timeout_seconds * 1000,
      });
    case "local":
      return new LocalBackend(logger.child("local"));
  }
}
