(function initialiseOptions() {
  "use strict";

  const Core = globalThis.NexusCuratorCore;
  let state = Core.defaultState();
  let recoverySnapshot = null;
  let apiKeyConfigured = false;
  const MANAGE_VIEWS = new Set(["skip", "hidden", "excluded", "keep", "maybe", "decisions", "all"]);

  const elements = {
    summary: document.getElementById("summary"),
    authors: document.getElementById("authors-body"),
    reviewedAuthors: document.getElementById("reviewed-authors-body"),
    mods: document.getElementById("mods-body"),
    manageView: document.getElementById("manage-view"),
    manageViewHelp: document.getElementById("manage-view-help"),
    excludedAuthorsSection: document.getElementById("excluded-authors-section"),
    hiddenAuthorsSection: document.getElementById("hidden-authors-section"),
    modDecisionsSection: document.getElementById("mod-decisions-section"),
    status: document.getElementById("status"),
    showPageStatus: document.getElementById("show-page-status"),
    restoreSnapshot: document.getElementById("restore-snapshot"),
    apiKeyStatus: document.getElementById("api-key-status"),
    apiKeyFile: document.getElementById("api-key-file"),
    clearApiKey: document.getElementById("clear-api-key"),
    openCatalog: document.getElementById("open-catalog")
  };

  function setStatus(message, error) {
    elements.status.textContent = message;
    elements.status.style.color = error ? "#ffb3b3" : "#9de0b8";
  }

  async function persist(next) {
    const previous = Core.normaliseState(state);
    const normalised = Core.normaliseState(next);
    recoverySnapshot = { createdAt: new Date().toISOString(), state: previous };
    try {
      await browser.storage.local.set({ recoverySnapshot });
    } catch (error) {
      console.warn("Nexus Local Curator could not save its recovery snapshot", error);
    }
    state = normalised;
    await browser.storage.local.set(state);
    render();
  }

  function cell(text) {
    const td = document.createElement("td");
    td.textContent = text || "—";
    return td;
  }

  function removeButton(type, key) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Remove";
    button.dataset.removeType = type;
    button.dataset.removeKey = key;
    return button;
  }

  function renderAuthors() {
    elements.authors.replaceChildren();
    const authors = [...state.blockedAuthors].sort((a, b) => a.username.localeCompare(b.username));
    if (!authors.length) {
      const row = document.createElement("tr");
      const td = cell("No authors excluded yet. Use Exclude author on a Nexus mod card.");
      td.colSpan = 4;
      td.className = "empty";
      row.appendChild(td);
      elements.authors.appendChild(row);
      return;
    }
    for (const author of authors) {
      const row = document.createElement("tr");
      row.append(cell(author.username), cell(author.userId), cell(new Date(author.addedAt).toLocaleString()));
      const actions = document.createElement("td");
      actions.appendChild(removeButton("author", Core.authorKey(author)));
      row.appendChild(actions);
      elements.authors.appendChild(row);
    }
  }

  function renderReviewedAuthors() {
    elements.reviewedAuthors.replaceChildren();
    const authors = [...state.reviewedAuthors].sort((a, b) => a.username.localeCompare(b.username));
    if (!authors.length) {
      const row = document.createElement("tr");
      const td = cell("No reviewed authors yet. Use Reviewed author on a Nexus mod card.");
      td.colSpan = 4;
      td.className = "empty";
      row.appendChild(td);
      elements.reviewedAuthors.appendChild(row);
      return;
    }
    for (const author of authors) {
      const row = document.createElement("tr");
      row.append(cell(author.username), cell(author.userId), cell(new Date(author.addedAt).toLocaleString()));
      const actions = document.createElement("td");
      actions.appendChild(removeButton("reviewed-author", Core.authorKey(author)));
      row.appendChild(actions);
      elements.reviewedAuthors.appendChild(row);
    }
  }

  function renderMods(selected) {
    elements.mods.replaceChildren();
    const decisions = [...state.modDecisions]
      .filter(item => selected === "decisions" || item.status === selected)
      .sort((a, b) => a.status.localeCompare(b.status) || a.title.localeCompare(b.title));
    if (!decisions.length) {
      const row = document.createElement("tr");
      const td = cell("No matching mod decisions yet.");
      td.colSpan = 5;
      td.className = "empty";
      row.appendChild(td);
      elements.mods.appendChild(row);
      return;
    }
    for (const mod of decisions) {
      const row = document.createElement("tr");
      const statusCell = document.createElement("td");
      const pill = document.createElement("span");
      pill.className = `status-pill ${mod.status}`;
      pill.textContent = mod.status;
      statusCell.appendChild(pill);
      const modCell = document.createElement("td");
      if (mod.sourceUrl) {
        const link = document.createElement("a");
        link.href = mod.sourceUrl;
        link.textContent = mod.title || `Mod ${mod.modId}`;
        link.target = "_blank";
        link.rel = "noreferrer";
        modCell.appendChild(link);
      } else modCell.textContent = mod.title || `Mod ${mod.modId}`;
      row.append(statusCell, modCell, cell(mod.author), cell(mod.game));
      const actions = document.createElement("td");
      actions.appendChild(removeButton("mod", mod.key));
      row.appendChild(actions);
      elements.mods.appendChild(row);
    }
  }

  function render() {
    const counts = { keep: 0, maybe: 0, skip: 0 };
    state.modDecisions.forEach(item => { counts[item.status] += 1; });
    const selected = elements.manageView.value;
    const showAll = selected === "all";
    const showExcluded = showAll || selected === "excluded";
    const showHidden = showAll || selected === "hidden";
    const showMods = showAll || (!showExcluded && !showHidden);
    const optionLabels = {
      skip: `Skipped mods (${counts.skip.toLocaleString()})`,
      hidden: `Hidden authors (${state.reviewedAuthors.length.toLocaleString()})`,
      excluded: `Excluded authors / blocked (${state.blockedAuthors.length.toLocaleString()})`,
      keep: `Kept mods (${counts.keep.toLocaleString()})`,
      maybe: `Maybe mods (${counts.maybe.toLocaleString()})`,
      decisions: `All mod decisions (${state.modDecisions.length.toLocaleString()})`,
      all: "All lists"
    };
    for (const option of elements.manageView.options) option.textContent = optionLabels[option.value];
    elements.summary.textContent = `${state.blockedAuthors.length} excluded · ${state.reviewedAuthors.length} reviewed · ${counts.keep} keep · ${counts.maybe} maybe · ${counts.skip} skip`;
    elements.showPageStatus.checked = state.settings.showPageStatus;
    elements.restoreSnapshot.disabled = !recoverySnapshot || !recoverySnapshot.state;
    elements.apiKeyStatus.textContent = apiKeyConfigured ? "API key configured" : "API key not configured";
    elements.apiKeyStatus.classList.toggle("configured", apiKeyConfigured);
    elements.openCatalog.disabled = !apiKeyConfigured;
    elements.clearApiKey.disabled = !apiKeyConfigured;
    elements.excludedAuthorsSection.hidden = !showExcluded;
    elements.hiddenAuthorsSection.hidden = !showHidden;
    elements.modDecisionsSection.hidden = !showMods;
    elements.manageViewHelp.textContent = showAll
      ? "Showing every saved list."
      : selected === "excluded"
      ? `${state.blockedAuthors.length.toLocaleString()} blocked / excluded authors.`
      : selected === "hidden"
        ? `${state.reviewedAuthors.length.toLocaleString()} hidden authors whose catalogues were reviewed.`
        : selected === "decisions"
          ? `${state.modDecisions.length.toLocaleString()} saved mod decisions.`
          : `${counts[selected].toLocaleString()} ${selected === "skip" ? "skipped" : selected} mods.`;

    if (showAll) {
      renderAuthors();
      renderReviewedAuthors();
      renderMods("decisions");
    } else if (showExcluded) {
      renderAuthors();
      elements.reviewedAuthors.replaceChildren();
      elements.mods.replaceChildren();
    } else if (showHidden) {
      elements.authors.replaceChildren();
      renderReviewedAuthors();
      elements.mods.replaceChildren();
    } else {
      elements.authors.replaceChildren();
      elements.reviewedAuthors.replaceChildren();
      renderMods(selected);
    }
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  document.getElementById("add-author-form").addEventListener("submit", async event => {
    event.preventDefault();
    const input = document.getElementById("author-name");
    await persist(Core.blockAuthor(state, { username: input.value }, "manual"));
    input.value = "";
    setStatus("Author excluded.");
  });

  document.getElementById("add-reviewed-author-form").addEventListener("submit", async event => {
    event.preventDefault();
    const input = document.getElementById("reviewed-author-name");
    await persist(Core.reviewAuthor(state, { username: input.value }, "manual"));
    input.value = "";
    setStatus("Author added to the reviewed list.");
  });

  document.addEventListener("click", async event => {
    const button = event.target.closest("[data-remove-type]");
    if (!button) return;
    if (button.dataset.removeType === "author") {
      await persist({ ...state, blockedAuthors: state.blockedAuthors.filter(item => Core.authorKey(item) !== button.dataset.removeKey) });
    } else if (button.dataset.removeType === "reviewed-author") {
      await persist({ ...state, reviewedAuthors: state.reviewedAuthors.filter(item => Core.authorKey(item) !== button.dataset.removeKey) });
    } else {
      await persist({ ...state, modDecisions: state.modDecisions.filter(item => item.key !== button.dataset.removeKey) });
    }
    setStatus("Entry removed.");
  });

  elements.manageView.addEventListener("change", () => {
    browser.storage.local.set({ manageView: elements.manageView.value }).catch(() => {});
    render();
  });
  elements.showPageStatus.addEventListener("change", () => persist({
    ...state,
    settings: { ...state.settings, showPageStatus: elements.showPageStatus.checked }
  }));

  elements.apiKeyFile.addEventListener("change", async event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const apiKey = (await file.text()).trim();
      setStatus("Validating the API key with Nexus…");
      const result = await browser.runtime.sendMessage({ type: "nexus-api-validate-key", apiKey });
      if (!result || !result.ok) throw new Error(result && result.error || "Nexus did not accept the API key.");
      await browser.storage.local.set({ nexusApiKey: apiKey });
      apiKeyConfigured = true;
      render();
      const allowance = result.limits && result.limits.dailyRemaining
        ? ` ${result.limits.dailyRemaining} daily API requests remain.`
        : "";
      setStatus(`API key saved locally.${allowance}`);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      event.target.value = "";
    }
  });

  elements.clearApiKey.addEventListener("click", async () => {
    await browser.storage.local.remove("nexusApiKey");
    apiKeyConfigured = false;
    render();
    setStatus("API key forgotten. Your Exclude, Hide, and mod lists were not changed.");
  });

  elements.openCatalog.addEventListener("click", () => browser.runtime.sendMessage({ type: "open-catalog" }));

  document.getElementById("export-csv").addEventListener("click", () => {
    download("nexus-local-curator.csv", Core.stateToCsv(state), "text/csv;charset=utf-8");
    setStatus("CSV exported.");
  });

  document.getElementById("export-json").addEventListener("click", () => {
    download("nexus-local-curator.json", JSON.stringify(state, null, 2) + "\n", "application/json");
    setStatus("JSON backup exported.");
  });

  document.getElementById("export-public-blocklist").addEventListener("click", () => {
    download("nexus-local-curator-community-blocklist.csv", Core.publicBlocklistCsv(state), "text/csv;charset=utf-8");
    setStatus(`Exported ${state.blockedAuthors.length} excluded authors. Hidden authors, mod decisions, recovery data, and the API key were not included.`);
  });

  document.getElementById("export-diagnostics").addEventListener("click", async () => {
    const stored = await browser.storage.local.get(["lastDiagnostics", "performanceDiagnostics"]);
    const diagnostics = stored.lastDiagnostics || {
      capturedAt: new Date().toISOString(),
      extensionVersion: browser.runtime.getManifest().version,
      apiKeyConfigured,
      message: "No API catalogue request has been recorded yet."
    };
    download("nexus-local-curator-diagnostics.json", JSON.stringify({
      ...diagnostics,
      performance: Array.isArray(stored.performanceDiagnostics) ? stored.performanceDiagnostics : []
    }, null, 2) + "\n", "application/json");
    setStatus("Exported privacy-safe diagnostics. The API key and list contents were not included.");
  });

  elements.restoreSnapshot.addEventListener("click", async () => {
    if (!recoverySnapshot || !recoverySnapshot.state) return;
    if (!confirm(`Restore the automatic snapshot from ${new Date(recoverySnapshot.createdAt).toLocaleString()}?`)) return;
    await persist(recoverySnapshot.state);
    setStatus("Previous state restored. Use Restore last change again to undo the restoration.");
  });

  document.getElementById("import-file").addEventListener("change", async event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = file.name.toLocaleLowerCase().endsWith(".json")
        ? Core.normaliseState(JSON.parse(text))
        : Core.csvToState(text, state);
      await persist(imported);
      setStatus(`Imported ${file.name}.`);
    } catch (error) {
      setStatus(`Import failed: ${error.message}`, true);
    } finally {
      event.target.value = "";
    }
  });

  browser.storage.local.get(null).then(items => {
    apiKeyConfigured = Boolean(String(items.nexusApiKey || "").trim());
    recoverySnapshot = items.recoverySnapshot && items.recoverySnapshot.state ? items.recoverySnapshot : null;
    state = Core.stateFromStorage(items);
    if (MANAGE_VIEWS.has(items.manageView)) elements.manageView.value = items.manageView;
    const journalKeys = Object.keys(items).filter(key =>
      key.startsWith(Core.AUTHOR_DECISION_PREFIX) || key.startsWith(Core.MOD_DECISION_PREFIX)
    );
    const migrationNeeded = items.schemaVersion !== Core.SCHEMA_VERSION || Object.prototype.hasOwnProperty.call(items, "blockedMods");
    const migrationSnapshot = migrationNeeded
      ? { createdAt: new Date().toISOString(), state: Core.normaliseState(items) }
      : recoverySnapshot;
    if (migrationNeeded) recoverySnapshot = migrationSnapshot;
    return browser.storage.local.set({ ...state, ...(migrationSnapshot ? { recoverySnapshot: migrationSnapshot } : {}) })
      .then(() => browser.storage.local.remove
        ? browser.storage.local.remove([
            ...journalKeys,
            ...(Object.prototype.hasOwnProperty.call(items, "blockedMods") ? ["blockedMods"] : [])
          ])
        : undefined);
  }).then(render).catch(error => setStatus(error.message, true));
})();
