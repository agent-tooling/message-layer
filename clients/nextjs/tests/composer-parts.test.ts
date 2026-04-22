import { describe, expect, test } from "vitest";
import {
  applyCommandSelection,
  applyMentionSelection,
  extractActiveCommandQuery,
  extractActiveMentionQuery,
  parseComposerInput,
  type ActorSuggestion,
  type CommandSuggestion,
} from "../lib/composer-parts";

const actors: ActorSuggestion[] = [
  { actorId: "a1", displayName: "Alice", actorType: "human" },
  { actorId: "a2", displayName: "Poet Bot", actorType: "agent" },
];

const commands: CommandSuggestion[] = [
  { name: "poem", ownerActorId: "a2", description: "Write a poem" },
];

describe("composer parts parser", () => {
  test("parses plain text into a text part", () => {
    const parsed = parseComposerInput({
      text: "hello world",
      actors,
      commands,
    });
    expect(parsed.parts).toHaveLength(1);
    expect(parsed.parts[0].type).toBe("text");
  });

  test("parses slash command into text + command parts", () => {
    const parsed = parseComposerInput({
      text: "/poem about moonlight",
      actors,
      commands,
    });
    expect(parsed.parts.map((p) => p.type)).toEqual(["text", "command"]);
    const command = parsed.parts[1];
    expect(command.payload.command).toBe("poem");
    expect(command.payload.args).toEqual({
      text: "about moonlight",
      fromComposer: "nextjs",
    });
  });

  test("parses mention offsets using known actor names", () => {
    const parsed = parseComposerInput({
      text: "hi @Alice and @Poet Bot",
      actors,
      commands,
    });
    const mentions = parsed.parts.filter((p) => p.type === "mention");
    expect(mentions).toHaveLength(2);
    expect(mentions[0].payload).toMatchObject({
      actorId: "a1",
      label: "@Alice",
      start: 3,
      end: 9,
    });
    expect(mentions[1].payload).toMatchObject({
      actorId: "a2",
      label: "@Poet Bot",
    });
  });

  test("query helpers detect active mention and slash command tokens", () => {
    expect(extractActiveMentionQuery("hello @po")).toBe("po");
    expect(extractActiveMentionQuery("hello @po now")).toBeNull();
    expect(extractActiveCommandQuery("/po")).toBe("po");
    expect(extractActiveCommandQuery("say /po")).toBeNull();
  });

  test("selection helpers replace the active mention/command token", () => {
    expect(applyMentionSelection("hello @po", "Poet Bot")).toBe(
      "hello @Poet Bot ",
    );
    expect(applyCommandSelection("/po", "poem")).toBe("/poem ");
  });
});
