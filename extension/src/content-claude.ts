import { startCapture } from "./content/common/capture";
import { attachResumeNudge } from "./content/common/resumeNudge";
import { claudeAdapter } from "./content/adapters/claude";

startCapture(claudeAdapter, document);
attachResumeNudge(claudeAdapter, document);
