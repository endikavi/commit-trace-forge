/**
 * Extract a single JSON object from model output.
 *
 * Models wrap JSON in prose or code fences even when told not to. This recovers the object when
 * it is unambiguously present and fails loudly when it is not; it never guesses at missing fields
 * or repairs a malformed structure into something that validates.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("model returned an empty response");

  const candidates: string[] = [];

  // 1. The whole response.
  candidates.push(trimmed);

  // 2. Fenced blocks, ```json or bare ```.
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  for (const match of trimmed.matchAll(fence)) {
    const body = (match[1] ?? "").trim();
    if (body.length > 0) candidates.push(body);
  }

  // 3. The outermost balanced {...} span, ignoring braces inside strings.
  const span = outermostObject(trimmed);
  if (span) candidates.push(span);

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      errors.push(`parsed but is ${Array.isArray(parsed) ? "an array" : typeof parsed}, not an object`);
    } catch (error) {
      errors.push((error as Error).message);
    }
  }

  throw new Error(
    `model response does not contain a JSON object (${errors.length} parse attempts). ` +
      `First 400 characters: ${trimmed.slice(0, 400)}`,
  );
}

function outermostObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
