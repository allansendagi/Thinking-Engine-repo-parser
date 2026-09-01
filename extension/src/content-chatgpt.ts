import { startCapture } from "./content/common/capture";
import { chatGptAdapter } from "./content/adapters/chatgpt";

startCapture(chatGptAdapter, document);
