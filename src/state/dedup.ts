import type { Database } from "bun:sqlite";
import type { IdeaNode } from "../types";
import { loadIdeas } from "../db/queries";
import { mergeIdeas, type MergeIdeasResult } from "../db/mutations";
import { lexicalOverlap } from "../identity/signals";

/**
 * Same bar as buildIdeaNode's in-pipeline lexical backstop (LEXICAL_DUPLICATE_THRESHOLD). This
 * pass is the retroactive half of that: the backstop stops *new* twins, this collapses the ones
 * that predate it.
 */
export const DEDUP_THRESHOLD = 0.9;

export interface DedupCluster {
  /** The idea the others fold into: most evolution steps, then earliest, then id. */
  keepId: string;
  keepTitle: string;
  drop: { id: string; title: string; similarity: number }[];
}

/** The stable signature of a pipeline-created duplicate: the deterministic title (deriveTitle
 *  never rewrites it, not even on merge) plus the FIRST evolution step's formulation. NOT
 *  currentFormulation -- each twin has evolved that independently since they were created. */
function signature(idea: IdeaNode): string {
  const first =
    [...idea.evolution].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    )[0]?.formulation ?? idea.currentFormulation;
  return `${idea.title}\n${first}`;
}

/**
 * Group idea nodes that are near-identical twins -- created as duplicates by an identity-
 * resolution miss. Direct-to-winner only: every drop is >= threshold against the cluster's keep,
 * never chained through an intermediate (at 0.9, A~B and B~C does not make A~C the same thought).
 * Pure: no writes.
 */
export function planDedup(
  db: Database,
  threshold: number = DEDUP_THRESHOLD,
): DedupCluster[] {
  const ranked = [...loadIdeas(db)].sort(
    (a, b) =>
      b.evolution.length - a.evolution.length ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );

  const claimed = new Set<string>();
  const clusters: DedupCluster[] = [];

  for (const keep of ranked) {
    if (claimed.has(keep.id)) continue;
    const keepSig = signature(keep);
    const drop: DedupCluster["drop"] = [];

    for (const other of ranked) {
      if (other.id === keep.id || claimed.has(other.id)) continue;
      const similarity = lexicalOverlap(keepSig, signature(other));
      if (similarity >= threshold)
        drop.push({ id: other.id, title: other.title, similarity });
    }

    if (drop.length > 0) {
      claimed.add(keep.id);
      for (const d of drop) claimed.add(d.id);
      clusters.push({ keepId: keep.id, keepTitle: keep.title, drop });
    }
  }

  return clusters;
}

export interface DedupOutcome {
  merges: number;
  moved: MergeIdeasResult;
}

/** Apply a plan. Each drop is merged into its cluster's keep, in the order planDedup returned. */
export function applyDedup(
  db: Database,
  clusters: DedupCluster[],
): DedupOutcome {
  const moved: MergeIdeasResult = {
    movedEvolutionSteps: 0,
    sharedEvolutionSteps: 0,
    movedOpenLoops: 0,
    dedupedOpenLoops: 0,
    movedDecisions: 0,
  };
  let merges = 0;
  for (const cluster of clusters) {
    for (const d of cluster.drop) {
      const r = mergeIdeas(db, cluster.keepId, d.id);
      moved.movedEvolutionSteps += r.movedEvolutionSteps;
      moved.sharedEvolutionSteps += r.sharedEvolutionSteps;
      moved.movedOpenLoops += r.movedOpenLoops;
      moved.dedupedOpenLoops += r.dedupedOpenLoops;
      moved.movedDecisions += r.movedDecisions;
      merges++;
    }
  }
  return { merges, moved };
}
