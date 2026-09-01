export interface CapturedMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface CapturedConversation {
  conversationId: string;
  messages: CapturedMessage[];
}

export interface SourceAdapter {
  name: string;
  source: "cursor";
  /** Absolute paths to watch for changes. Empty array if the tool isn't installed on this machine. */
  locateWatchTargets(): string[];
  /** Extracts everything currently available from the given (just-changed) file. */
  extract(filePath: string): CapturedConversation[];
}
