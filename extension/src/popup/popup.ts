import { getSettings, setApiBaseUrl, setCredentials } from "../lib/storage";
import { createUser, ApiError } from "../lib/api";

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

function showError(message: string): void {
  $("error").textContent = message;
}

async function refreshStatus(): Promise<void> {
  const { apiBaseUrl, credentials } = await getSettings();
  (document.getElementById("apiBaseUrl") as HTMLInputElement).value = apiBaseUrl;

  const status = $("status");
  if (credentials) {
    status.textContent = `Paired as ${credentials.userId}`;
  } else {
    status.textContent = "Not paired -- create an account below.";
  }
}

async function init(): Promise<void> {
  await refreshStatus();

  $("saveUrl").addEventListener("click", async () => {
    const value = (document.getElementById("apiBaseUrl") as HTMLInputElement).value.trim();
    if (!value) return;
    await setApiBaseUrl(value);
    await refreshStatus();
  });

  $("useExisting").addEventListener("click", async () => {
    const userId = (document.getElementById("userId") as HTMLInputElement).value.trim();
    const token = (document.getElementById("token") as HTMLInputElement).value.trim();
    if (!userId || !token) {
      showError("Both User ID and Token are required.");
      return;
    }
    await setCredentials({ userId, token });
    showError("");
    await refreshStatus();
  });

  $("repair").addEventListener("click", async () => {
    showError("");
    const { apiBaseUrl } = await getSettings();
    try {
      const created = await createUser(apiBaseUrl);
      await setCredentials(created);
      await refreshStatus();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Failed to reach the API server.");
    }
  });
}

void init();
