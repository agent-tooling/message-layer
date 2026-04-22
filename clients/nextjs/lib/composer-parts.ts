export type ActorSuggestion = {
  actorId: string;
  displayName: string;
  actorType: string;
};

export type CommandSuggestion = {
  name: string;
  ownerActorId: string;
  description: string | null;
};

export type ComposerPart = {
  type: "text" | "mention" | "command" | "artifact";
  payload: Record<string, unknown>;
};

type MentionCandidate = {
  actorId: string;
  label: string;
  start: number;
  end: number;
};

/**
 * Parse a composer input into first-class message parts. The text part is
 * always included when non-empty; command and mention parts are inferred.
 */
export function parseComposerInput(input: {
  text: string;
  actors: ActorSuggestion[];
  commands: CommandSuggestion[];
}): { parts: ComposerPart[]; trimmedText: string } {
  const rawText = input.text ?? "";
  const trimmedText = rawText.trim();
  const parts: ComposerPart[] = [];
  if (!trimmedText) return { parts, trimmedText };

  parts.push({ type: "text", payload: { text: trimmedText } });

  const command = parseSlashCommand(trimmedText, input.commands);
  if (command) {
    parts.push({
      type: "command",
      payload: {
        command: command.command,
        args: command.args,
      },
    });
  }

  const mentions = parseMentions(trimmedText, input.actors);
  for (const mention of mentions) {
    parts.push({
      type: "mention",
      payload: {
        actorId: mention.actorId,
        label: mention.label,
        start: mention.start,
        end: mention.end,
      },
    });
  }

  return { parts, trimmedText };
}

export function extractActiveMentionQuery(text: string): string | null {
  const match = text.match(/(?:^|\s)@([a-zA-Z0-9_.-]*)$/);
  if (!match) return null;
  return match[1] ?? "";
}

export function extractActiveCommandQuery(text: string): string | null {
  const match = text.match(/^\/([a-zA-Z0-9_:-]*)$/);
  if (!match) return null;
  return match[1] ?? "";
}

export function applyMentionSelection(text: string, displayName: string): string {
  return text.replace(/(?:^|\s)@([a-zA-Z0-9_.-]*)$/, (full) => {
    const prefix = full.startsWith(" ") ? " " : "";
    return `${prefix}@${displayName} `;
  });
}

export function applyCommandSelection(text: string, commandName: string): string {
  return text.replace(/^\/([a-zA-Z0-9_:-]*)$/, `/${commandName} `);
}

function parseMentions(text: string, actors: ActorSuggestion[]): MentionCandidate[] {
  const out: MentionCandidate[] = [];
  const claimed = new Set<number>();
  const sorted = [...actors].sort(
    (a, b) => b.displayName.length - a.displayName.length,
  );
  for (const actor of sorted) {
    const label = `@${actor.displayName}`;
    let from = 0;
    for (;;) {
      const idx = text.indexOf(label, from);
      if (idx === -1) break;
      const end = idx + label.length;
      const beforeOk = idx === 0 || /\s|[([{"'`]/.test(text[idx - 1] ?? "");
      const afterOk = end === text.length || /\s|[.,!?;:)\]}]/.test(text[end] ?? "");
      if (beforeOk && afterOk) {
        let overlaps = false;
        for (let i = idx; i < end; i += 1) {
          if (claimed.has(i)) {
            overlaps = true;
            break;
          }
        }
        if (!overlaps) {
          out.push({
            actorId: actor.actorId,
            label,
            start: idx,
            end,
          });
          for (let i = idx; i < end; i += 1) claimed.add(i);
        }
      }
      from = end;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function parseSlashCommand(
  text: string,
  commands: CommandSuggestion[],
): { command: string; args: Record<string, unknown> } | null {
  const match = text.match(/^\/([a-zA-Z0-9_:-]+)(?:\s+(.*))?$/s);
  if (!match) return null;
  const commandToken = match[1];
  const rest = (match[2] ?? "").trim();
  const shortName = commandToken.includes(":")
    ? commandToken.split(":").pop() ?? commandToken
    : commandToken;
  const known = commands.some((cmd) => cmd.name === shortName);
  const args: Record<string, unknown> = {};
  if (rest.length > 0) args.text = rest;
  if (known) args.fromComposer = "nextjs";
  return { command: commandToken, args };
}
