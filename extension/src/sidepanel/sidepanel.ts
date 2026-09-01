import {
  continueThinking,
  deleteIdea,
  getThinkingState,
  pasteConversation,
  renameIdea,
  searchIdeas,
  setIdeaState,
  setOpenLoopResolved,
  traceIdea,
  ApiError,
  type IdeaTrace,
} from "../lib/api";

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}
function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

async function renderList(query: string): Promise<void> {
  const ideaListEl = $("ideaList");
  const openLoopsEl = $("openLoops");

  try {
    if (query.trim().length > 0) {
      const results = await searchIdeas(query);
      openLoopsEl.parentElement!.style.display = "none";
      ideaListEl.innerHTML =
        results.length === 0
          ? '<p class="muted">No matches.</p>'
          : results.map((r) => ideaRowHtml(r.id, r.title, r.state)).join("");
    } else {
      openLoopsEl.parentElement!.style.display = "";
      const state = await getThinkingState();
      const openLoops = state.openLoops.filter((l) => !l.resolved);
      openLoopsEl.innerHTML =
        openLoops.length === 0
          ? '<p class="muted">Nothing open.</p>'
          : openLoops
              .map(
                (l) =>
                  `<div class="open-loop" data-idea-id="${l.ideaId}"><span>${escapeHtml(l.statement)}</span><span class="badge">${escapeHtml(l.ideaTitle)}</span></div>`,
              )
              .join("");

      ideaListEl.innerHTML =
        state.currentIdeas.length === 0
          ? '<p class="muted">Nothing captured yet. Start a conversation in ChatGPT, Claude, or Gemini.</p>'
          : state.currentIdeas.map((i) => ideaRowHtml(i.id, i.title, i.state)).join("");
    }
  } catch (err) {
    ideaListEl.innerHTML = `<p class="error">${err instanceof ApiError ? escapeHtml(err.message) : "Failed to load. Is the API server running?"}</p>`;
  }
}

function ideaRowHtml(id: string, title: string, state: string): string {
  return `<div class="card"><span class="idea-title" data-idea-id="${id}">${escapeHtml(title)}</span> <span class="badge">${escapeHtml(state)}</span></div>`;
}

async function openDetail(ideaId: string): Promise<void> {
  $("listView").style.display = "none";
  $("searchRow").style.display = "none";
  const detail = $("detailView");
  detail.style.display = "";
  detail.innerHTML = '<p class="muted">Loading…</p>';
  $("back").style.display = "";

  let trace: IdeaTrace;
  try {
    trace = await traceIdea(ideaId);
  } catch (err) {
    detail.innerHTML = `<p class="error">${err instanceof ApiError ? escapeHtml(err.message) : "Failed to load idea."}</p>`;
    return;
  }

  const { idea, provenance } = trace;
  detail.innerHTML = `
    <div class="card">
      <div class="row">
        <input id="titleInput" type="text" value="${escapeHtml(idea.title)}" style="flex:1" />
        <button id="renameBtn">Save</button>
      </div>
      <p class="muted">${escapeHtml(idea.currentFormulation)}</p>
      <div class="row">
        <select id="stateSelect">
          ${["developing", "established", "rejected", "dormant"].map((s) => `<option value="${s}" ${s === idea.state ? "selected" : ""}>${s}</option>`).join("")}
        </select>
        <button id="continueBtn">Continue thinking</button>
        <button id="deleteBtn" class="danger">Delete</button>
      </div>
    </div>

    <h3>Evolution</h3>
    ${provenance
      .map(
        (p) =>
          `<div class="evolution-step"><div>${escapeHtml(p.formulation)}</div><div class="muted">${new Date(p.createdAt).toLocaleDateString()} — grounded in: "${escapeHtml((p.sourceText ?? "").slice(0, 80))}${(p.sourceText?.length ?? 0) > 80 ? "…" : ""}"</div></div>`,
      )
      .join("")}

    <h3>Open loops</h3>
    ${
      idea.openLoops.length === 0
        ? '<p class="muted">None.</p>'
        : idea.openLoops
            .map(
              (l) =>
                `<div class="open-loop ${l.resolved ? "resolved" : ""}"><span>${escapeHtml(l.statement)}</span><input type="checkbox" data-loop-id="${l.id}" ${l.resolved ? "checked" : ""} /></div>`,
            )
            .join("")
    }

    <div id="continueResult" class="card muted" style="display:none"></div>
  `;

  $("renameBtn").addEventListener("click", async () => {
    const title = (document.getElementById("titleInput") as HTMLInputElement).value;
    try {
      await renameIdea(ideaId, title);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Rename failed.");
    }
  });

  document.getElementById("stateSelect")!.addEventListener("change", async (e) => {
    const state = (e.target as HTMLSelectElement).value;
    try {
      await setIdeaState(ideaId, state);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Update failed.");
    }
  });

  $("deleteBtn").addEventListener("click", async () => {
    if (!confirm(`Delete "${idea.title}"? This removes Thread's interpretation but keeps the source conversation.`)) return;
    try {
      await deleteIdea(ideaId);
      await goBack();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Delete failed.");
    }
  });

  $("continueBtn").addEventListener("click", async () => {
    const resultEl = $("continueResult");
    resultEl.style.display = "";
    resultEl.textContent = "Thinking…";
    try {
      const { text } = await continueThinking(idea.title);
      resultEl.textContent = text;
    } catch (err) {
      resultEl.textContent = err instanceof ApiError ? err.message : "Failed to continue.";
    }
  });

  detail.querySelectorAll<HTMLInputElement>("[data-loop-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", async () => {
      const loopId = checkbox.getAttribute("data-loop-id") as string;
      try {
        await setOpenLoopResolved(loopId, checkbox.checked);
      } catch (err) {
        alert(err instanceof ApiError ? err.message : "Update failed.");
        checkbox.checked = !checkbox.checked;
      }
    });
  });
}

async function goBack(): Promise<void> {
  $("detailView").style.display = "none";
  $("listView").style.display = "";
  $("searchRow").style.display = "";
  $("back").style.display = "none";
  await renderList("");
}

function init(): void {
  $("back").addEventListener("click", () => void goBack());

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  document.getElementById("search")!.addEventListener("input", (e) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    const value = (e.target as HTMLInputElement).value;
    debounceTimer = setTimeout(() => void renderList(value), 300);
  });

  document.body.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const ideaId = target.getAttribute("data-idea-id") ?? target.closest("[data-idea-id]")?.getAttribute("data-idea-id");
    if (ideaId && (target.classList.contains("idea-title") || target.closest(".open-loop"))) {
      void openDetail(ideaId);
    }
  });

  $("pasteSubmit").addEventListener("click", async () => {
    const textarea = document.getElementById("pasteText") as HTMLTextAreaElement;
    const text = textarea.value;
    const resultEl = $("pasteResult");
    if (text.trim().length === 0) {
      resultEl.textContent = "Paste something first.";
      return;
    }
    (document.getElementById("pasteSubmit") as HTMLButtonElement).disabled = true;
    resultEl.textContent = "Processing…";
    try {
      const result = await pasteConversation(text);
      resultEl.textContent = `Captured ${result.newCognitiveEvents} idea event(s), ${result.ideaCount} idea(s) total.`;
      textarea.value = "";
      await renderList("");
    } catch (err) {
      resultEl.textContent = err instanceof ApiError ? err.message : "Failed to reach the API server.";
    } finally {
      (document.getElementById("pasteSubmit") as HTMLButtonElement).disabled = false;
    }
  });

  void renderList("");
}

init();
