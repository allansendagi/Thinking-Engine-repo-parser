export {};

const command = process.argv[2];

switch (command) {
  case "eval": {
    const { runEval } = await import("../eval/harness");
    await runEval();
    break;
  }
  default: {
    console.log(`Usage: bun src/cli.ts <command>

Commands:
  eval    Run the pipeline against eval/fixture and score it against the gate.

Not yet implemented: import (real ChatGPT export), state (query the Thinking State
for a topic) -- see README.md for the build order.`);
    if (command !== undefined) process.exit(1);
  }
}
