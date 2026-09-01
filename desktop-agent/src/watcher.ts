import { existsSync, watch } from "node:fs";

export interface WatchOptions {
  debounceMs?: number;
}

export interface WatchHandle {
  stop: () => void;
  /** Paths that were requested but don't exist on this machine -- the tool likely isn't installed. */
  skipped: string[];
}

/**
 * Watches a set of file paths and calls `onChange(path)` once, debounced, after each path settles
 * (a quiet period with no further writes). Paths that don't exist are silently skipped rather than
 * throwing -- a desktop agent runs on machines where not every source tool is installed, and a
 * missing Cursor install shouldn't crash the agent for someone who only uses ChatGPT.
 */
export function watchPaths(paths: string[], onChange: (path: string) => void, options: WatchOptions = {}): WatchHandle {
  const debounceMs = options.debounceMs ?? 3000;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const closers: (() => void)[] = [];
  const skipped: string[] = [];

  for (const path of paths) {
    if (!existsSync(path)) {
      skipped.push(path);
      continue;
    }
    const watcher = watch(path, () => {
      const existing = timers.get(path);
      if (existing) clearTimeout(existing);
      timers.set(
        path,
        setTimeout(() => onChange(path), debounceMs),
      );
    });
    closers.push(() => watcher.close());
  }

  return {
    stop: () => {
      for (const close of closers) close();
      for (const t of timers.values()) clearTimeout(t);
    },
    skipped,
  };
}
