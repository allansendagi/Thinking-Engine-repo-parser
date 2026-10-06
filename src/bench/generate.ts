import type { CanonicalEvent, CognitiveEventType } from "../types";
import { NOISE, PERSONAS, STORYLINES, type Beat, type BeatKind } from "./storylines";
import type { GoldIdea, GoldThought, Scenario, ThoughtRole } from "./types";

/** Deterministic PRNG (mulberry32) -- the same seed always yields the same scenario. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BEAT_GOLD: Record<BeatKind, { type: CognitiveEventType; role: ThoughtRole }> = {
  introduce: { type: "new_idea", role: "position" },
  restate: { type: "claim", role: "position" },
  refine: { type: "refinement", role: "position" },
  contradict: { type: "contradiction", role: "position" },
  question: { type: "question", role: "question" },
  option: { type: "claim", role: "option" },
  reject: { type: "rejection", role: "rejection" },
  decide: { type: "decision", role: "decision" },
  adopt: { type: "decision", role: "decision" },
  answer: { type: "resolution", role: "answer" },
};

/** Beat kinds that state where the idea stands -- the last one is the gold "current thinking". */
const POSITIONAL: ReadonlySet<BeatKind> = new Set(["introduce", "restate", "refine", "contradict", "decide", "adopt"]);

const TOOLS: CanonicalEvent["source"][] = ["chatgpt", "claude", "cursor"];

export interface GenerateOptions {
  persona: string;
  seed: number;
  /** Probability of a noise exchange after each beat. Default 0.35. */
  noiseRate?: number;
  /** Start date of the timeline. */
  start?: string;
}

/**
 * Turn a persona's storylines into a realistic multi-conversation history: ideas interleaved
 * across conversations, tools and weeks (beats of one idea land in different chats days apart),
 * noise turns sprinkled in, and the full ground truth recorded alongside.
 */
export function generateScenario(opts: GenerateOptions): Scenario {
  const persona = PERSONAS.find((p) => p.name === opts.persona);
  if (!persona) throw new Error(`Unknown persona ${opts.persona}`);
  const rand = rng(opts.seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const noiseRate = opts.noiseRate ?? 0.35;

  const storylines = persona.storylines.map((k) => STORYLINES.find((s) => s.key === k)!);
  const cursor = new Map<string, number>(storylines.map((s) => [s.key, 0]));
  const remaining = () => storylines.filter((s) => cursor.get(s.key)! < s.beats.length);

  const events: CanonicalEvent[] = [];
  const thoughts: GoldThought[] = [];
  const noiseMessageIds: string[] = [];
  let clock = new Date(opts.start ?? "2026-06-01T09:00:00.000Z").getTime();
  let convN = 0;

  while (remaining().length > 0) {
    const convId = `${opts.persona}_s${opts.seed}_c${convN++}`;
    const source = pick(TOOLS);
    let index = 0;
    const push = (role: "user" | "assistant", text: string): string => {
      const id = `${convId}_m${index}`;
      clock += 60_000 + Math.floor(rand() * 240_000); // 1-5 minutes between turns
      events.push({
        id,
        conversationId: convId,
        source,
        role,
        text,
        createdAt: new Date(clock).toISOString(),
        index: index++,
      });
      return id;
    };

    // A conversation works one storyline (sometimes drifts into a second), 1-3 beats of each.
    const lines = [pick(remaining())];
    const second = remaining().filter((s) => s.key !== lines[0]!.key);
    if (second.length > 0 && rand() < 0.3) lines.push(pick(second));

    for (const line of lines) {
      const beatsHere = 1 + Math.floor(rand() * 3);
      for (let b = 0; b < beatsHere && cursor.get(line.key)! < line.beats.length; b++) {
        const beat: Beat = line.beats[cursor.get(line.key)!]!;
        cursor.set(line.key, cursor.get(line.key)! + 1);

        let assistantId: string | undefined;
        if (beat.assistantBefore) assistantId = push("assistant", beat.assistantBefore);
        const variant = pick(beat.variants);
        const messageId = push("user", variant.text);
        const gold = BEAT_GOLD[beat.kind];
        thoughts.push({
          messageId,
          idea: line.key,
          type: gold.type,
          role: gold.role,
          statement: beat.statement,
          quote: variant.quote,
          loop: beat.loop,
          adopted:
            beat.kind === "adopt" && assistantId && beat.adoptedQuote
              ? { assistantMessageId: assistantId, quote: beat.adoptedQuote }
              : undefined,
        });
        if (beat.assistantAfter) push("assistant", beat.assistantAfter);

        if (rand() < noiseRate) {
          const n = pick(NOISE);
          noiseMessageIds.push(push("user", n.text));
          push("assistant", n.assistantAfter);
        }
      }
    }
    clock += Math.floor((0.5 + rand() * 3) * 86_400_000); // next conversation 0.5-3.5 days later
  }

  const ideas: GoldIdea[] = storylines.map((line) => {
    const mine = thoughts.filter((t) => t.idea === line.key);
    const kinds = mine.map((t, i) => ({ t, kind: line.beats[i]!.kind }));
    const positional = kinds.filter((k) => POSITIONAL.has(k.kind));
    const opened = mine.filter((t) => t.role === "question" && t.loop).map((t) => t.loop!);
    const answered = new Set(mine.filter((t) => t.role === "answer" && t.loop).map((t) => t.loop!));
    return {
      key: line.key,
      title: line.title,
      finalPositionMessageId: positional.at(-1)?.t.messageId ?? mine[0]!.messageId,
      openLoops: opened.filter((l) => !answered.has(l)),
      resolvedLoops: opened.filter((l) => answered.has(l)),
      decisions: mine.filter((t) => t.role === "decision").map((t) => t.messageId),
      confusableWith: line.confusableWith.filter((k) => persona.storylines.includes(k)),
    };
  });

  return { name: `${opts.persona}#${opts.seed}`, persona: opts.persona, events, thoughts, ideas, noiseMessageIds };
}

/** The standard bench suite: every persona at a few seeds. */
export function standardSuite(seeds: number[] = [1, 2, 3]): Scenario[] {
  return PERSONAS.flatMap((p) => seeds.map((seed) => generateScenario({ persona: p.name, seed })));
}
