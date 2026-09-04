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
  case "grant": {
    // Operator escape hatch: set an account's plan directly in registry.db, for giving the
    // founder / support accounts Pro without a Paddle checkout. A later real Paddle webhook for
    // the same account still overwrites this.
    //   bun src/cli.ts grant --email=you@example.com [--plan=pro|free] [--status=active]
    //   bun src/cli.ts grant --user=user_<24hex>     [--plan=pro|free] [--status=active]
    const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
    const { findAccountByEmail, getAccount, setPlan } = await import("./api/auth");
    const email = arg("email");
    const userArg = arg("user");
    const plan = (arg("plan") ?? "pro") as "pro" | "free";
    if (plan !== "pro" && plan !== "free") {
      console.error("--plan must be pro or free");
      process.exit(1);
    }
    const status = (arg("status") ?? (plan === "pro" ? "active" : "free")) as
      | "active"
      | "free"
      | "past_due"
      | "canceled";
    const account = email ? findAccountByEmail(email) : userArg ? getAccount(userArg) : null;
    if (!account) {
      console.error(
        email
          ? `No account with email ${email}`
          : userArg
            ? `No account ${userArg}`
            : "Pass --email=<addr> or --user=<id>",
      );
      process.exit(1);
    }
    setPlan(account.userId, { plan, status });
    console.log(`${account.userId} (${account.email ?? "no email"}) -> plan=${plan} status=${status}`);
    break;
  }
  case "downloads": {
    const { downloadSummary } = await import("./api/metrics");
    const days = Math.min(365, Math.max(1, Number(process.argv[3] ?? 30) || 30));
    const s = downloadSummary(days);
    console.log(`\nApp downloads\n============`);
    console.log(`  all time : ${s.total}`);
    console.log(`  today    : ${s.today}`);
    console.log(`  last 7d  : ${s.last7}`);
    console.log(`  last 30d : ${s.last30}\n`);
    if (s.byDay.length) {
      const max = Math.max(...s.byDay.map((d) => d.count), 1);
      console.log(`Per day (last ${days}d)`);
      for (const d of s.byDay) {
        const bar = "█".repeat(Math.round((d.count / max) * 32));
        console.log(`  ${d.day}  ${String(d.count).padStart(4)}  ${bar}`);
      }
      console.log("");
    }
    const table = (label: string, rows: { k: string; count: number }[]) => {
      if (!rows.length) return;
      console.log(label);
      for (const r of rows) console.log(`  ${r.k.padEnd(16)} ${r.count}`);
      console.log("");
    };
    table("By version", s.byVersion.map((r) => ({ k: r.version, count: r.count })));
    table("By country", s.byCountry.map((r) => ({ k: r.country, count: r.count })));
    table("By platform", s.byPlatform.map((r) => ({ k: r.platform, count: r.count })));
    break;
  }
  default: {
    console.log(`Usage: bun src/cli.ts <command>

Commands:
  eval                                    Run the pipeline against every eval/cases/* case and
                                           score it (micro-averaged). Needs ANTHROPIC_API_KEY.
  downloads [days]                         Print the self-hosted app-download counter (all-time,
                                           today, 7d/30d, per-day bars, by version/country).
  grant --email=<addr>|--user=<id> [--plan=pro|free] [--status=active]
                                           Set an account's plan directly in registry.db (no
                                           Paddle checkout). For founder / support accounts.
  import <chatgpt|claude> <file> [--user=<id>]
                                           Import a real export file. Creates a new user if
                                           --user isn't given, and prints its credentials once.
                                           Safe to re-run against an updated/overlapping export --
                                           already-imported messages are skipped, not duplicated.`);
    if (command !== undefined) process.exit(1);
  }
}
