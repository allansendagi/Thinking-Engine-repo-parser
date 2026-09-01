#!/usr/bin/env bun
import { loadConfig } from "./config";
import { sendConversation } from "./ingest";
import { watchPaths } from "./watcher";
import { cursorAdapter } from "./sources/cursor";
import type { SourceAdapter } from "./sources/sourceAdapter";

const ADAPTERS: SourceAdapter[] = [cursorAdapter];

async function processChange(adapter: SourceAdapter, filePath: string, config: ReturnType<typeof loadConfig>): Promise<void> {
  let conversations;
  try {
    conversations = adapter.extract(filePath);
  } catch (err) {
    console.error(`[Thread desktop-agent] ${adapter.name}: failed to extract from ${filePath}:`, err);
    return;
  }

  if (conversations.length === 0) {
    console.warn(
      `[Thread desktop-agent] ${adapter.name}: ${filePath} changed but nothing message-shaped was found -- ` +
        "the extraction heuristic likely needs updating for this tool's current storage format.",
    );
    return;
  }

  for (const conversation of conversations) {
    try {
      const result = await sendConversation(config, adapter.source, conversation);
      console.log(`[Thread desktop-agent] ${adapter.name}: ${conversation.conversationId} ->`, result);
    } catch (err) {
      console.error(`[Thread desktop-agent] ${adapter.name}: failed to ingest ${conversation.conversationId}:`, err);
    }
  }
}

function main(): void {
  const config = loadConfig();
  console.log(`[Thread desktop-agent] starting, API base ${config.apiBaseUrl}`);

  const stops: (() => void)[] = [];

  for (const adapter of ADAPTERS) {
    const targets = adapter.locateWatchTargets();
    if (targets.length === 0) {
      console.log(`[Thread desktop-agent] ${adapter.name}: not installed on this machine, skipping`);
      continue;
    }

    const handle = watchPaths(targets, (path) => void processChange(adapter, path, config));
    for (const skipped of handle.skipped) {
      console.warn(`[Thread desktop-agent] ${adapter.name}: expected path not found: ${skipped}`);
    }
    console.log(`[Thread desktop-agent] ${adapter.name}: watching ${targets.length - handle.skipped.length} path(s)`);
    stops.push(handle.stop);

    // Also do an initial pass on startup, not just on future changes.
    for (const target of targets) void processChange(adapter, target, config);
  }

  process.on("SIGINT", () => {
    for (const stop of stops) stop();
    process.exit(0);
  });
}

main();
