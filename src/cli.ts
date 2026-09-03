export {};

const command = process.argv[2];

async function runImport(): Promise<void> {
  const format = process.argv[3];
  const filePath = process.argv[4];
  const userIdArg = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];

  if (format !== "chatgpt" && format !== "claude") {
    console.error('Usage: bun src/cli.ts import <chatgpt|claude> <file-path> [--user=<userId>]');
    process.exit(1);
  }
  if (!filePath) {
    console.error("Missing file path.");
    process.exit(1);
  }

  const { readFileSync } = await import("node:fs");
  const { parseExportFile, importIntoDb } = await import("./import/run");
  const { createUser } = await import("./api/auth");
  const { openUserDb } = await import("./db/tenancy");
  const { createExtractionProvider, createReasoningProvider } = await import("./providers/anthropic");

  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  const events = parseExportFile(format, raw);
  console.log(`Parsed ${events.length} canonical events from ${filePath}`);

  let userId = userIdArg;
  if (!userId) {
    const created = await createUser();
    userId = created.userId;
    console.log(`Created a new user: ${created.userId}`);
    console.log(`Token (save this, shown once): ${created.token}`);
  }

  const db = openUserDb(userId);
  const providers = { extraction: createExtractionProvider(), reasoning: createReasoningProvider() };
  const summary = await importIntoDb(db, events, providers);
  db.close();

  console.log("Import summary:", summary);
}

switch (command) {
  case "eval": {
    const { runEval } = await import("../eval/harness");
    await runEval();
    process.exit(process.exitCode ?? 0);
  }
  case "import": {
    await runImport();
    break;
  }
  default: {
    console.log(`Usage: bun src/cli.ts <command>

Commands:
  eval                                    Run the pipeline against every eval/cases/* case and
                                           score it (micro-averaged). Needs ANTHROPIC_API_KEY.
  import <chatgpt|claude> <file> [--user=<id>]
                                           Import a real export file. Creates a new user if
                                           --user isn't given, and prints its credentials once.
                                           Safe to re-run against an updated/overlapping export --
                                           already-imported messages are skipped, not duplicated.`);
    if (command !== undefined) process.exit(1);
  }
}
