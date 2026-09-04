import { bootstrapContentScript } from "./content/common/bootstrap";
import { chatGptAdapter } from "./content/adapters/chatgpt";

bootstrapContentScript(chatGptAdapter);
