(function initialiseCatalog() {
  "use strict";

  const Core = globalThis.NexusCuratorCore;
  const ApiCore = globalThis.NexusCuratorApiCore;
  let state = Core.defaultState();
  let mods = [];
  let totalCount = 0;
  let loading = false;
  let sourcePage = 1;
  let nextSourceCursor = null;

  const elements = {
    game: document.getElementById("game-domain"),
    sort: document.getElementById("catalog-sort"),
    load: document.getElementById("load-catalog"),
    manager: document.getElementById("open-manager"),
    summary: document.getElementById("catalog-summary"),
    status: document.getElementById("catalog-status"),
    grid: document.getElementById("catalog-grid")
  };

  function setStatus(message, error) {
    elements.status.textContent = message;
    elements.status.classList.toggle("error", Boolean(error));
  }

  function safeImageUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.href : "";
    } catch (_error) {
      return "";
    }
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(Number(value || 0));
  }

  function textElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  function link(href, text) {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.textContent = text;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    return anchor;
  }

  function actionButton(label, action, modKey) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.action = action;
    button.dataset.modKey = modKey;
    return button;
  }

  function card(mod) {
    const article = document.createElement("article");
    article.className = "mod-card";
    article.dataset.modKey = mod.key;

    const imageUrl = safeImageUrl(mod.thumbnailUrl);
    if (imageUrl) {
      const image = document.createElement("img");
      image.className = "mod-image";
      image.src = imageUrl;
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.fetchPriority = "low";
      article.appendChild(image);
    } else {
      article.appendChild(textElement("div", "mod-image placeholder", "No preview"));
    }

    const body = document.createElement("div");
    body.className = "mod-body";
    const heading = document.createElement("h2");
    heading.appendChild(link(mod.sourceUrl, mod.title));
    const byline = document.createElement("p");
    byline.className = "byline";
    byline.append("by ");
    if (mod.author.profileUrl) byline.appendChild(link(mod.author.profileUrl, mod.author.username || "Unknown author"));
    else byline.append(mod.author.username || "Unknown author");
    const summary = textElement("p", "summary-text", mod.summary || "No summary provided.");
    const metadata = textElement(
      "div",
      "metadata",
      `${mod.category || "Uncategorised"} · ${formatNumber(mod.downloads)} downloads · ${formatNumber(mod.endorsements)} endorsements`
    );
    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.append(
      actionButton("Keep", "keep", mod.key),
      actionButton("Skip", "skip", mod.key),
      actionButton("Hide", "hide", mod.key),
      actionButton("Exclude", "exclude", mod.key)
    );
    body.append(heading, byline, summary, metadata, actions);
    article.appendChild(body);
    return article;
  }

  function isVisible(mod) {
    return !Core.isAuthorBlocked(state, mod.author) &&
      !Core.isAuthorReviewed(state, mod.author) &&
      !Core.decisionFor(state, mod);
  }

  function render() {
    mods = mods.filter(isVisible);
    elements.grid.replaceChildren();
    if (!mods.length) {
      elements.grid.appendChild(textElement("div", "empty", loading ? "Loading the curated catalogue…" : "No unreviewed mods are loaded. Load the next batch."));
    } else {
      for (const mod of mods) elements.grid.appendChild(card(mod));
    }
    elements.summary.textContent = totalCount
      ? `${formatNumber(totalCount)} source mods · source page ${sourcePage} · ${mods.length} shown locally`
      : `Source page ${sourcePage} · ${mods.length} shown locally`;
    elements.load.disabled = loading;
    elements.load.textContent = loading ? "Loading from Nexus…" : "Continue to next source page";
  }

  async function saveRecoverySnapshot(previous) {
    await browser.storage.local.set({
      recoverySnapshot: {
        createdAt: new Date().toISOString(),
        state: Core.normaliseState(previous)
      }
    });
  }

  async function persist(nextState) {
    const previous = state;
    state = Core.normaliseState(nextState);
    await browser.storage.local.set({
      ...state,
      recoverySnapshot: {
        createdAt: new Date().toISOString(),
        state: previous
      }
    });
  }

  async function loadBatch(advance = false) {
    if (loading) return;
    if (advance) sourcePage = nextSourceCursor ? nextSourceCursor.page : sourcePage + 1;
    loading = true;
    render();
    setStatus(`Loading Nexus source page ${sourcePage}; your lists will be applied locally…`);
    try {
      const response = await browser.runtime.sendMessage({
        type: "nexus-api-batch",
        request: {
          mode: "stream",
          gameDomainName: elements.game.value,
          sort: elements.sort.value,
          page: sourcePage,
          cursor: { page: sourcePage, index: 0, batch: sourcePage }
        }
      });
      if (!response || !response.ok) throw new Error(response && response.error || "The Nexus API did not return a result.");
      mods = response.nodes.map(node => ApiCore.normaliseApiMod(node, elements.game.value)).filter(mod => mod.modId && isVisible(mod));
      totalCount = response.totalCount;
      sourcePage = Number(response.streamEndPage || sourcePage);
      nextSourceCursor = response.nextCursor || null;
      setStatus(`Loaded ${mods.length} unreviewed mods from Nexus source page ${sourcePage}. Decisions remain in Manage and your backups.`);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      loading = false;
      render();
    }
  }

  elements.grid.addEventListener("click", async event => {
    const button = event.target.closest("[data-action][data-mod-key]");
    if (!button) return;
    const mod = mods.find(item => item.key === button.dataset.modKey);
    if (!mod) return;
    button.disabled = true;
    const action = button.dataset.action;
    if (action === "hide") {
      await persist(Core.reviewAuthor(state, mod.author, mod.author.profileUrl || mod.sourceUrl));
      mods = mods.filter(item => !Core.authorsMatch(item.author, mod.author));
      setStatus(`${mod.author.username} hidden as an author whose catalogue you have reviewed.`);
    } else if (action === "exclude") {
      await persist(Core.blockAuthor(state, mod.author, mod.author.profileUrl || mod.sourceUrl));
      mods = mods.filter(item => !Core.authorsMatch(item.author, mod.author));
      setStatus(`${mod.author.username} excluded.`);
    } else if (Core.VALID_STATUSES.has(action)) {
      await persist(Core.setDecision(state, mod, action));
      mods = mods.filter(item => item.key !== mod.key);
      setStatus(`${mod.title} marked ${action}.`);
    }
    render();
    if (!mods.length) loadBatch(true);
  });

  elements.load.addEventListener("click", () => loadBatch(true));
  elements.game.addEventListener("change", () => {
    mods = [];
    totalCount = 0;
    sourcePage = 1;
    nextSourceCursor = null;
    render();
    loadBatch();
  });
  elements.sort.addEventListener("change", () => {
    mods = [];
    totalCount = 0;
    sourcePage = 1;
    nextSourceCursor = null;
    render();
    loadBatch();
  });
  elements.manager.addEventListener("click", () => browser.runtime.openOptionsPage());

  browser.storage.onChanged.addListener((_changes, area) => {
    if (area !== "local") return;
    browser.storage.local.get(null).then(items => {
      state = Core.stateFromStorage(items);
      render();
    });
  });

  browser.storage.local.get(null).then(items => {
    state = Core.stateFromStorage(items);
    render();
    return loadBatch();
  }).catch(error => setStatus(error.message, true));
})();
