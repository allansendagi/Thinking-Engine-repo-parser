import { startCapture } from "./content/common/capture";
import { attachResumeNudge } from "./content/common/resumeNudge";
import { chatGptAdapter } from "./content/adapters/chatgpt";

startCapture(chatGptAdapter, document);
attachResumeNudge(chatGptAdapter, document);
