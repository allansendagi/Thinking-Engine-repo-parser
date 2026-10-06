/**
 * Hand-authored storylines for the thinking bench. Each storyline is ONE idea as a real person
 * would develop it with AI over weeks: introduced, come back to later in DIFFERENT words,
 * questioned, weighed against options, partly rejected, decided. Two properties are deliberate:
 *
 *  - Paraphrase: later beats of the same idea share few words with earlier ones ("charge per
 *    seat" -> "bill by headcount"). A miner that only matches on shared words splits the idea.
 *  - Collision: some storylines share vocabulary with a DIFFERENT storyline (the "review" pair,
 *    the "verification" pair). A miner that merges on shared words corrupts both ideas.
 *
 * Each beat has a couple of phrasings; the generator picks one per scenario seed, so scenarios
 * differ in surface form while the ground truth stays fixed.
 */

export type BeatKind =
  | "introduce"
  | "restate"
  | "refine"
  | "question"
  | "option"
  | "reject"
  | "decide"
  | "answer"
  | "contradict"
  | "adopt";

export interface Variant {
  /** The full user message. */
  text: string;
  /** Verbatim substring of `text` grounding the thought. */
  quote: string;
}

export interface Beat {
  kind: BeatKind;
  /** The thought, decontextualized, in the person's voice. */
  statement: string;
  variants: Variant[];
  /** Assistant message shown BEFORE this user message (an adopt beat's proposal lives here). */
  assistantBefore?: string;
  /** For adopt: verbatim quote of the adopted proposal inside assistantBefore. */
  adoptedQuote?: string;
  /** Loop key this beat opens (question) or closes (answer). */
  loop?: string;
  /** Assistant reply after the user message. */
  assistantAfter?: string;
}

export interface Storyline {
  key: string;
  title: string;
  confusableWith: string[];
  beats: Beat[];
}

const ok = "That makes sense. Want me to sketch out the implications?";

export const STORYLINES: Storyline[] = [
  // ---------------------------------------------------------------- persona: startup founder
  {
    key: "pricing-model",
    title: "Pricing model for teams",
    confusableWith: [],
    beats: [
      {
        kind: "introduce",
        statement: "We should charge per seat rather than a flat monthly fee.",
        variants: [
          { text: "I'm leaning towards charging per seat instead of a flat monthly fee. Thoughts?", quote: "charging per seat instead of a flat monthly fee" },
          { text: "Thinking we price it per seat, not one flat monthly fee for everyone.", quote: "we price it per seat, not one flat monthly fee" },
        ],
        assistantAfter: "Per-seat pricing scales with value for teams, though it can discourage adding people.",
      },
      {
        kind: "question",
        statement: "Do guest collaborators count toward the bill?",
        loop: "guests",
        variants: [
          { text: "Open question: do guest collaborators count toward the bill?", quote: "do guest collaborators count toward the bill?" },
          { text: "What happens with outside guests, do they count toward what a company pays?", quote: "do they count toward what a company pays?" },
        ],
        assistantAfter: "Many tools give a free guest allowance and bill only full members.",
      },
      {
        kind: "option",
        statement: "One option is billing per workspace instead of per person.",
        variants: [
          { text: "Alternative: bill per workspace instead of per person.", quote: "bill per workspace instead of per person" },
          { text: "Or we could do a price per workspace rather than per person.", quote: "a price per workspace rather than per person" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "reject",
        statement: "Per-workspace billing is out because it punishes small teams.",
        variants: [
          { text: "Scratch the per-workspace idea, it punishes small teams too much.", quote: "Scratch the per-workspace idea, it punishes small teams" },
          { text: "No to workspace-based billing — tiny teams would end up overpaying.", quote: "No to workspace-based billing" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "restate",
        statement: "Billing should scale with headcount, so bigger orgs pay more.",
        variants: [
          { text: "The bill should grow with headcount — a 200-person org pays a lot more than a 5-person startup.", quote: "The bill should grow with headcount" },
          { text: "Cost ought to track how many people use it; large orgs pay more, startups less.", quote: "Cost ought to track how many people use it" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "answer",
        statement: "Guests are free up to five per account; beyond that they're billed.",
        loop: "guests",
        variants: [
          { text: "On guests: first five per account are free, after that they're billed like members.", quote: "first five per account are free" },
          { text: "Settled the guest thing — five free guests per account, the rest get charged.", quote: "five free guests per account" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "decide",
        statement: "Decision: annual plans only, billed per active member.",
        variants: [
          { text: "Decided: annual plans only, billed per active member.", quote: "annual plans only, billed per active member" },
          { text: "Final call — yearly contracts only, charged for each active member.", quote: "yearly contracts only, charged for each active member" },
        ],
        assistantAfter: "Got it — annual, per active member.",
      },
    ],
  },
  {
    key: "onboarding-import",
    title: "First-run history import",
    confusableWith: [],
    beats: [
      {
        kind: "introduce",
        statement: "New users should see their own past conversations on first launch, not an empty screen.",
        variants: [
          { text: "Big realization: a blank first screen kills us. New users should land on their own past conversations.", quote: "New users should land on their own past conversations" },
          { text: "The empty state is the problem — on first launch people should already see their previous chats.", quote: "on first launch people should already see their previous chats" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "question",
        statement: "How do we get someone's chat history without making them request an export?",
        loop: "export-wait",
        variants: [
          { text: "How do we get someone's history without them requesting an export and waiting a day?", quote: "How do we get someone's history without them requesting an export" },
          { text: "Is there a way to pull past chats that doesn't involve the slow export email?", quote: "pull past chats that doesn't involve the slow export email" },
        ],
        assistantAfter: "A browser extension could read the history while the user is signed in.",
      },
      {
        kind: "answer",
        statement: "The browser extension reads the history directly while the user is signed in.",
        loop: "export-wait",
        variants: [
          { text: "Answer: the extension reads it straight from the site while they're logged in. Minutes, not a day.", quote: "the extension reads it straight from the site while they're logged in" },
          { text: "Got it — we read history through the extension using their existing login.", quote: "we read history through the extension using their existing login" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "refine",
        statement: "Day one should already show the user a handful of their real ideas.",
        variants: [
          { text: "Sharper version: within two minutes of installing, you should see five of your own real ideas.", quote: "within two minutes of installing, you should see five of your own real ideas" },
          { text: "The bar: minute two after install, a handful of your genuine ideas are already there.", quote: "minute two after install, a handful of your genuine ideas are already there" },
        ],
        assistantAfter: ok,
      },
    ],
  },
  {
    key: "security-review",
    title: "Vendor security questionnaire",
    confusableWith: ["code-review-bot"],
    beats: [
      {
        kind: "introduce",
        statement: "We need a standard answer pack for enterprise security questionnaires.",
        variants: [
          { text: "Every enterprise deal stalls on the security review. We need a standard answer pack for those questionnaires.", quote: "We need a standard answer pack for those questionnaires" },
          { text: "Security reviews from big customers keep blocking deals — let's build a reusable questionnaire response kit.", quote: "build a reusable questionnaire response kit" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "question",
        statement: "Do we need SOC 2 before the first enterprise customer?",
        loop: "soc2",
        variants: [
          { text: "Do we actually need SOC 2 before the first enterprise customer signs?", quote: "Do we actually need SOC 2 before the first enterprise customer signs?" },
          { text: "Is a SOC 2 report a must-have ahead of landing enterprise customer number one?", quote: "Is a SOC 2 report a must-have ahead of landing enterprise customer number one?" },
        ],
        assistantAfter: "Often a Type I plus a strong questionnaire is enough to start.",
      },
      {
        kind: "decide",
        statement: "Start a SOC 2 Type I now and use the answer pack in the meantime.",
        variants: [
          { text: "Decision: kick off SOC 2 Type I now, lean on the answer pack until it lands.", quote: "kick off SOC 2 Type I now" },
          { text: "We'll begin Type I immediately and use the questionnaire kit while we wait.", quote: "We'll begin Type I immediately" },
        ],
        assistantAfter: ok,
      },
    ],
  },
  {
    key: "code-review-bot",
    title: "AI code review feature",
    confusableWith: ["security-review"],
    beats: [
      {
        kind: "introduce",
        statement: "Add an AI reviewer that comments on pull requests before a human reviews them.",
        variants: [
          { text: "Feature idea: an AI review pass that comments on every pull request before a human looks at it.", quote: "an AI review pass that comments on every pull request before a human looks at it" },
          { text: "What if a bot does a first review on each PR, so human reviewers start from its notes?", quote: "a bot does a first review on each PR" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "option",
        statement: "The reviewer could block merges on serious findings.",
        variants: [
          { text: "Option: let it block the merge when it finds something serious.", quote: "let it block the merge when it finds something serious" },
          { text: "It could also hard-stop merges on severe issues.", quote: "hard-stop merges on severe issues" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "reject",
        statement: "The bot should never block merges; developers would hate it.",
        variants: [
          { text: "No blocking. Developers will rip it out the first time it stops a deploy.", quote: "No blocking." },
          { text: "Blocking merges is a non-starter — engineers would turn it off on day one.", quote: "Blocking merges is a non-starter" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "restate",
        statement: "The automated reviewer only leaves suggestions; humans keep the final say.",
        variants: [
          { text: "So the machine reviewer is advisory — it suggests, people approve.", quote: "the machine reviewer is advisory" },
          { text: "The automated pass just leaves suggestions; a person still signs off.", quote: "The automated pass just leaves suggestions" },
        ],
        assistantAfter: ok,
      },
    ],
  },
  {
    key: "first-hire",
    title: "First engineering hire",
    confusableWith: [],
    beats: [
      {
        kind: "adopt",
        statement: "Hire a senior generalist who can own the backend and talk to customers.",
        assistantBefore:
          "Three profiles could work: (1) a frontend specialist to polish the app, (2) a senior generalist who can own the backend and talk to customers, (3) an ML engineer for the extraction models.",
        adoptedQuote: "a senior generalist who can own the backend and talk to customers",
        variants: [
          { text: "Yes, the second one. That's exactly who we need first.", quote: "Yes, the second one." },
          { text: "Number two, definitely — that's our first hire.", quote: "Number two, definitely" },
        ],
        assistantAfter: "Great — I'll draft a job description for a senior generalist.",
      },
      {
        kind: "question",
        statement: "Should the first engineer be remote or in person?",
        loop: "remote",
        variants: [
          { text: "Remote or in person for this first engineer?", quote: "Remote or in person for this first engineer?" },
          { text: "Does the first engineer need to sit with us, or is remote fine?", quote: "Does the first engineer need to sit with us, or is remote fine?" },
        ],
        assistantAfter: ok,
      },
    ],
  },
  // ---------------------------------------------------------------- persona: governance researcher
  {
    key: "verifiable-authority",
    title: "Independently verifiable authority",
    confusableWith: ["identity-kyc"],
    beats: [
      {
        kind: "introduce",
        statement: "Institutional authority should be something an outside party can independently verify.",
        variants: [
          { text: "Core claim for the paper: institutional authority should be independently verifiable by an outside party.", quote: "institutional authority should be independently verifiable by an outside party" },
          { text: "I think the point is that an institution's authority must be checkable by someone outside it.", quote: "an institution's authority must be checkable by someone outside it" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "question",
        statement: "Who performs the independent check on an institution's authority?",
        loop: "who-checks",
        variants: [
          { text: "But who does the checking? That's the hole.", quote: "who does the checking?" },
          { text: "Unresolved: which body actually audits the institution?", quote: "which body actually audits the institution?" },
        ],
        assistantAfter: "Candidates include courts, auditors, or a public registry.",
      },
      {
        kind: "refine",
        statement: "Authority has to be expressed in a form that can be checked mechanically.",
        variants: [
          { text: "Refining: the mandate has to be written in a machine-checkable form, not prose.", quote: "the mandate has to be written in a machine-checkable form" },
          { text: "Better: legitimacy needs to be encoded so software can test it.", quote: "legitimacy needs to be encoded so software can test it" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "contradict",
        statement: "Fully mechanical checks miss the judgment calls that legitimacy depends on.",
        variants: [
          { text: "Hmm, but pure mechanical checking misses the judgment calls legitimacy really depends on.", quote: "pure mechanical checking misses the judgment calls legitimacy really depends on" },
          { text: "Wait — code can't capture the discretion that makes a mandate legitimate.", quote: "code can't capture the discretion that makes a mandate legitimate" },
        ],
        assistantAfter: ok,
      },
    ],
  },
  {
    key: "identity-kyc",
    title: "Identity verification for payouts",
    confusableWith: ["verifiable-authority"],
    beats: [
      {
        kind: "introduce",
        statement: "Verify a creator's identity before the first payout, not at signup.",
        variants: [
          { text: "For the marketplace: verify a creator's identity before their first payout, not at signup.", quote: "verify a creator's identity before their first payout, not at signup" },
          { text: "Let's only run identity verification when someone is about to get paid the first time.", quote: "only run identity verification when someone is about to get paid the first time" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "decide",
        statement: "Use the payment provider's built-in identity checks instead of a separate vendor.",
        variants: [
          { text: "Going with the payment provider's built-in identity checks, no separate KYC vendor.", quote: "the payment provider's built-in identity checks" },
          { text: "Decision: Stripe-style built-in verification, skip the extra KYC vendor.", quote: "built-in verification, skip the extra KYC vendor" },
        ],
        assistantAfter: ok,
      },
    ],
  },
  {
    key: "paper-structure",
    title: "Paper leads with its answer",
    confusableWith: [],
    beats: [
      {
        kind: "introduce",
        statement: "The paper should open with its main conclusion, then the supporting arguments.",
        variants: [
          { text: "Structure: open the paper with the conclusion, then the three arguments under it.", quote: "open the paper with the conclusion, then the three arguments under it" },
          { text: "Lead with the answer up front and let the sections defend it.", quote: "Lead with the answer up front" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "refine",
        statement: "Each section heading should itself be a claim, not a topic label.",
        variants: [
          { text: "And every section heading should be a claim, not a topic like 'Background'.", quote: "every section heading should be a claim" },
          { text: "Headings as assertions — no more 'Background', 'Discussion'.", quote: "Headings as assertions" },
        ],
        assistantAfter: ok,
      },
    ],
  },
  // ---------------------------------------------------------------- persona: writer
  {
    key: "book-structure",
    title: "Book organized around questions",
    confusableWith: ["newsletter-cadence"],
    beats: [
      {
        kind: "introduce",
        statement: "Each chapter of the book should answer one question a reader actually has.",
        variants: [
          { text: "New plan for the book: each chapter answers one question a real reader would ask.", quote: "each chapter answers one question a real reader would ask" },
          { text: "What if every chapter is built around a single question readers actually have?", quote: "every chapter is built around a single question readers actually have" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "question",
        statement: "Where do the reader questions for the book come from?",
        loop: "source-questions",
        variants: [
          { text: "Where do I get the real questions from, though?", quote: "Where do I get the real questions from" },
          { text: "How do I find out what readers genuinely wonder about?", quote: "How do I find out what readers genuinely wonder about?" },
        ],
        assistantAfter: "Your newsletter replies could be a source.",
      },
      {
        kind: "answer",
        statement: "Mine the replies to the newsletter for the questions readers ask.",
        loop: "source-questions",
        variants: [
          { text: "Answer: mine two years of replies to the newsletter for questions.", quote: "mine two years of replies to the newsletter for questions" },
          { text: "I'll pull the questions from what subscribers write back.", quote: "pull the questions from what subscribers write back" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "restate",
        statement: "The table of contents is a list of questions.",
        variants: [
          { text: "Basically the table of contents is just a list of questions.", quote: "the table of contents is just a list of questions" },
          { text: "So the contents page reads as questions, one per chapter.", quote: "the contents page reads as questions" },
        ],
        assistantAfter: ok,
      },
    ],
  },
  {
    key: "newsletter-cadence",
    title: "Newsletter publishing rhythm",
    confusableWith: ["book-structure"],
    beats: [
      {
        kind: "introduce",
        statement: "Move the newsletter from weekly to every other week.",
        variants: [
          { text: "The newsletter should go from weekly to every other week, quality is slipping.", quote: "The newsletter should go from weekly to every other week" },
          { text: "Thinking of switching the newsletter to fortnightly so each issue is better.", quote: "switching the newsletter to fortnightly" },
        ],
        assistantAfter: ok,
      },
      {
        kind: "decide",
        statement: "Publish the newsletter every second Tuesday.",
        variants: [
          { text: "Decided: every second Tuesday, starting next month.", quote: "every second Tuesday, starting next month" },
          { text: "Locking it in — biweekly on Tuesdays.", quote: "biweekly on Tuesdays" },
        ],
        assistantAfter: ok,
      },
    ],
  },
];

/** Real but not idea-worthy user turns. */
export const NOISE: { text: string; assistantAfter: string }[] = [
  { text: "Thanks, that's helpful!", assistantAfter: "Happy to help." },
  { text: "Can you format that as a table?", assistantAfter: "| Item | Detail |\n|---|---|\n| ... | ... |" },
  { text: "What does SOC 2 stand for again?", assistantAfter: "Service Organization Control 2." },
  { text: "Make it shorter please.", assistantAfter: "Here's a shorter version." },
  { text: "ok", assistantAfter: "Anything else?" },
  { text: "Explain what a webhook is like I'm five.", assistantAfter: "It's a doorbell for apps." },
  { text: "Can you fix the typos in that paragraph?", assistantAfter: "Fixed." },
];

export const PERSONAS: { name: string; storylines: string[] }[] = [
  { name: "founder", storylines: ["pricing-model", "onboarding-import", "security-review", "code-review-bot", "first-hire"] },
  { name: "researcher", storylines: ["verifiable-authority", "identity-kyc", "paper-structure"] },
  { name: "writer", storylines: ["book-structure", "newsletter-cadence", "paper-structure"] },
  { name: "polymath", storylines: STORYLINES.map((s) => s.key) },
];
