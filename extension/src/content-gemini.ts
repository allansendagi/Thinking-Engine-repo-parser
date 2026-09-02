import { startCapture } from "./content/common/capture";
import { attachResumeNudge } from "./content/common/resumeNudge";
import { geminiAdapter } from "./content/adapters/gemini";

startCapture(geminiAdapter, document);
attachResumeNudge(geminiAdapter, document);
