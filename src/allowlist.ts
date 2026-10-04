/**
 * HintLab run_commands allow-list.
 *
 * `run_commands` executes on the HOST (inside the session workdir), so this
 * allow-list is the only thing standing between the model and an arbitrary
 * shell. It is deliberately strict and exported so scripts/check-agent.ts can
 * unit-test it.
 */

export interface AllowDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Substrings that are rejected on every command before the whitelist match runs.
 * This is defence-in-depth: even a command that happens to satisfy a structural
 * regex (for example the free-form payload of an `echo ... | python3 main.py`)
 * is still rejected if it smuggles shell metacharacters.
 */
export const DENY_SUBSTRINGS: readonly string[] = [
  ";", // command separator
  "&&", // and-list
  "||", // or-list
  "`", // command substitution
  "$", // any dollar sign: variable or command expansion ($HOME, $(…), ${…})
  "|", // any pipe — echo/printf piping into the program is disallowed entirely
  ">", // output redirection (writing files)
  "&", // backgrounding / single ampersand
  "\n", // literal newline = another command
  "\r", // literal carriage return
  "*", // glob expansion
  "?", // glob expansion
];

/**
 * The whitelist. Each trimmed command must match exactly one of these anchored
 * patterns. Only the assignment's own build/run/read commands are allowed.
 */
export const ALLOWED_COMMANDS: readonly RegExp[] = [
  // --- Python: run the program ---
  /^python3 main\.py$/,
  // stdin redirect from a per-test input file in the workdir (no slashes)
  /^python3 main\.py < input-[A-Za-z0-9_-]+\.txt$/,
  // --- C: build + run ---
  /^gcc -Wall -O0 main\.c -o main$/, // the exact tests.json build command
  /^\.\/main$/,
  /^\.\/main < input-[A-Za-z0-9_-]+\.txt$/,
  // --- Reads ---
  /^cat (main\.py|main\.c|tests\.json|input-[A-Za-z0-9_-]+\.txt)$/,
];

/**
 * Normalise the (loosely-typed) run_commands input into a flat list of command
 * strings. Handles both the simple `{ commands: string[] }` shape and the
 * structured `{ command, args }` / string forms the SDK accepts.
 */
export function extractCommands(input: unknown): string[] {
  if (input == null) return [];
  const obj = input as Record<string, unknown>;
  const raw: unknown = "commands" in obj ? obj.commands : input;

  if (Array.isArray(raw)) {
    return raw
      .map((c): string | undefined => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") return (c as Record<string, unknown>).command as string | undefined;
        return undefined;
      })
      .filter((c): c is string => typeof c === "string" && c.trim().length > 0);
  }

  if (typeof raw === "string") return [raw];
  if (raw && typeof raw === "object") {
    const c = (raw as Record<string, unknown>).command;
    if (typeof c === "string") return [c];
  }
  return [];
}

/** Decide whether a single (trimmed) command is allowed. */
export function allowCommand(command: string): AllowDecision {
  const cmd = command.trim();
  if (!cmd) return { allowed: false, reason: "empty command" };

  for (const sub of DENY_SUBSTRINGS) {
    if (cmd.includes(sub)) {
      return { allowed: false, reason: `forbidden token ${JSON.stringify(sub)}` };
    }
  }

  if (!ALLOWED_COMMANDS.some((re) => re.test(cmd))) {
    return { allowed: false, reason: "command not on the HintLab allow-list" };
  }

  return { allowed: true };
}

/** Decide whether a list of commands is allowed (every command must be allowed). */
export function allowCommands(commands: string[]): AllowDecision {
  if (commands.length === 0) return { allowed: false, reason: "no commands provided" };
  for (const c of commands) {
    const d = allowCommand(c);
    if (!d.allowed) return d;
  }
  return { allowed: true };
}
