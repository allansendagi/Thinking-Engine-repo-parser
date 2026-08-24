import type { CompletionProvider } from "./types";

/**
 * Returns pre-scripted responses in order, one per call. This is what lets the entire pipeline
 * (parser, extraction plumbing, identity resolution logic, threshold behavior, state building,
 * MCP read tools) run and be asserted on in tests with zero API key and zero network calls.
 * It does not simulate model intelligence -- a test using this provider is checking that the
 * pipeline does the right thing WITH a given model output, not that the model produces good
 * output in the first place. That second thing still needs a live key.
 */
export class FakeProvider implements CompletionProvider {
  private index = 0;

  constructor(private readonly responses: string[]) {}

  async complete(): Promise<string> {
    const response = this.responses[this.index];
    if (response === undefined) {
      throw new Error(
        `FakeProvider.complete called ${this.index + 1} times but only ${this.responses.length} responses were scripted`,
      );
    }
    this.index++;
    return response;
  }
}
