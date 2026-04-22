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

type MentionAlias = {
  actorId: string;
  alias: string;
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

  const aliases = buildMentionAliases(actors);
  const mentionTokenRegex = /(^|\s)@([a-zA-Z0-9_.-]+)/g;
  for (const match of text.matchAll(mentionTokenRegex)) {
    const token = (match[2] ?? "").toLowerCase();
    if (!token) continue;
    const full = match[0] ?? "";
    const atOffset = full.lastIndexOf("@");
    if (atOffset < 0) continue;
    const start = (match.index ?? 0) + atOffset;
    const end = start + token.length + 1;
    if (rangeOverlapsClaimed(claimed, start, end)) continue;
    const actorId = resolveMentionToken(token, aliases);
    if (!actorId) continue;
    out.push({
      actorId,
      label: text.slice(start, end),
      start,
      end,
    });
    markClaimed(claimed, start, end);
  }

  return out.sort((a, b) => a.start - b.start);
}

function normalizeMentionAlias(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_.-]/g, "");
}

function buildMentionAliases(actors: ActorSuggestion[]): MentionAlias[] {
  const out: MentionAlias[] = [];
  const seen = new Set<string>();
  for (const actor of actors) {
    const canonical = normalizeMentionAlias(actor.displayName);
    if (!canonical) continue;
    const aliases = new Set<string>([canonical]);
    aliases.add(canonical.replace(/-agent$/, ""));
    aliases.add(canonical.replace(/_agent$/, ""));
    for (const alias of aliases) {
      if (!alias) continue;
      const key = `${actor.actorId}:${alias}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ actorId: actor.actorId, alias });
    }
  }
  return out;
}

function resolveMentionToken(token: string, aliases: MentionAlias[]): string | null {
  const matches = aliases.filter((entry) => entry.alias === token);
  if (matches.length === 1) return matches[0].actorId;
  return null;
}

function rangeOverlapsClaimed(claimed: Set<number>, start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    if (claimed.has(i)) return true;
  }
  return false;
}

function markClaimed(claimed: Set<number>, start: number, end: number): void {
  for (let i = start; i < end; i += 1) claimed.add(i);
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
