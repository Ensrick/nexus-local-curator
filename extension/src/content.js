(function initialiseContentScript() {
  "use strict";

  const Core = globalThis.NexusCuratorCore;
  const ApiCore = globalThis.NexusCuratorApiCore;
  const TILE_SELECTOR = '[data-e2eid="mod-tile"]';
  let state = Core.defaultState();
  let blockedAuthorIndex = Core.createAuthorIndex(state.blockedAuthors);
  let reviewedAuthorIndex = Core.createAuthorIndex(state.reviewedAuthors);
  let scheduled = null;
  let applying = false;
  let showHidden = false;
  let showBlocked = false;
  let showSkipped = false;
  let curatedLoading = false;
  let curatedTimer = null;
  let curatedSequence = 0;
  let loadedCuratedSignature = "";
  let desiredCuratedSignature = "";
  let curatedTotal = null;
  let curatedVisibleCount = 0;
  let curatedPage = 1;
  let curatedSourceIndex = 0;
  let curatedBatchNumber = 1;
  let curatedPageCount = 0;
  let curatedHiddenModCount = 0;
  let curatedExcludedModCount = 0;
  let curatedStatsReady = false;
  let curatedStatsTimer = null;
  let curatedStatsSequence = 0;
  let curatedLanguageCounts = {};
  let curatedLanguageRefreshed = new Set();
  let curatedLanguageCountsReady = false;
  let curatedLanguageContextSignature = "";
  let curatedLanguageSequence = 0;
  let curatedCategoryCounts = {};
  let curatedCategoryRefreshed = new Set();
  let curatedCategoryCountsReady = false;
  let curatedCategoryContextSignature = "";
  let curatedCategorySequence = 0;
  let catalogueContextSignature = "";
  let catalogueQuerySignature = "";
  let observedLocation = location.href;
  let curatedError = "";
  let apiKeyConfigured = false;
  let curatedRefreshNotBefore = 0;
  const localSourceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let streamCursors = {};
  let activeStreamContext = "";
  let savedBacklogCursor = null;
  let currentSourceResponse = null;
  let currentBatchNextCursor = null;
  let currentBatchSourceEndPage = 1;
  let streamCursorHistory = [];
  let streamAdvanceScheduled = false;
  let runtimeRecoveryScheduled = false;

  function runtimeDisconnected(error) {
    const message = String(error && error.message || error || "");
    return /Could not establish connection|Receiving end does not exist|Extension context invalidated/i.test(message);
  }

  function scheduleRuntimeRecovery() {
    if (runtimeRecoveryScheduled) return;
    runtimeRecoveryScheduled = true;
    setTimeout(() => location.reload(), 100);
  }

  async function sendRuntimeMessage(message, allowRetry = true) {
    try {
      return await browser.runtime.sendMessage(message);
    } catch (error) {
      if (!runtimeDisconnected(error)) throw error;
      let contextIsCurrent = false;
      try {
        contextIsCurrent = Boolean(browser.runtime.getManifest());
      } catch (_error) {
        contextIsCurrent = false;
      }
      if (contextIsCurrent && allowRetry) {
        try {
          if (browser.runtime.getBackgroundPage) await browser.runtime.getBackgroundPage();
        } catch (_error) {
          // The follow-up message remains the authoritative recovery check.
        }
        await new Promise(resolve => setTimeout(resolve, 150));
        return sendRuntimeMessage(message, false);
      }
      scheduleRuntimeRecovery();
      throw new Error("The extension was updated. Reloading this Nexus tab…");
    }
  }

  function rebuildAuthorIndexes() {
    blockedAuthorIndex = Core.createAuthorIndex(state.blockedAuthors);
    reviewedAuthorIndex = Core.createAuthorIndex(state.reviewedAuthors);
  }

  function isAuthorBlocked(author) {
    return Core.authorIndexHas(blockedAuthorIndex, author);
  }

  function isAuthorReviewed(author) {
    return Core.authorIndexHas(reviewedAuthorIndex, author);
  }

  async function loadState() {
    const stored = await browser.storage.local.get(null);
    apiKeyConfigured = Boolean(String(stored.nexusApiKey || "").trim());
    streamCursors = stored.streamCursors && typeof stored.streamCursors === "object" ? { ...stored.streamCursors } : {};
    state = Core.stateFromStorage(stored);
    rebuildAuthorIndexes();
    if (stored.schemaVersion !== Core.SCHEMA_VERSION || Object.prototype.hasOwnProperty.call(stored, "blockedMods")) {
      await saveRecoverySnapshot(Core.normaliseState(stored));
      await browser.storage.local.set(state);
      if (Object.prototype.hasOwnProperty.call(stored, "blockedMods") && browser.storage.local.remove) {
        await browser.storage.local.remove("blockedMods");
      }
    }
    scheduleApply();
  }

  async function saveRecoverySnapshot(snapshot) {
    try {
      await browser.storage.local.set({
        recoverySnapshot: {
          createdAt: new Date().toISOString(),
          state: Core.normaliseState(snapshot)
        }
      });
    } catch (error) {
      console.warn("Nexus Local Curator could not save its recovery snapshot", error);
    }
  }

  function enqueuePersistence(key, value) {
    setTimeout(() => {
      Promise.resolve(sendRuntimeMessage({
        type: "persist-local-delta",
        key,
        value: { ...value, sourceId: localSourceId }
      })).then(response => {
        if (!response || !response.ok) throw new Error(response && response.error || "The local decision queue rejected an entry.");
      }).catch(error => console.error("Nexus Local Curator could not queue a local decision", error));
    }, 0);
  }

  function reportPerformanceDiagnostic(value) {
    Promise.resolve(sendRuntimeMessage({ type: "record-performance-diagnostic", value })).catch(() => {});
  }

  function reportActionPerformance(action, startedAt, paintedAt, updateStartedAt) {
    const finishedAt = performance.now();
    const clickToPaintMs = paintedAt - startedAt;
    const stateUpdateMs = finishedAt - updateStartedAt;
    const durationMs = finishedAt - startedAt;
    if (clickToPaintMs < 45 && stateUpdateMs < 20 && durationMs < 70) return;
    reportPerformanceDiagnostic({
      phase: "action",
      action,
      durationMs,
      clickToPaintMs,
      stateUpdateMs,
      tileCount: document.querySelectorAll(TILE_SELECTOR).length
    });
  }

  function saveState(nextState) {
    state = nextState;
    rebuildAuthorIndexes();
    curatedRefreshNotBefore = Date.now() + 8000;
    const emptyCuratedPage = document.body.classList.contains("nlc-curated-active") &&
      !document.querySelector('[data-nlc-api-tile]:not(.nlc-hidden)');
    scheduleApply(emptyCuratedPage ? 0 : 250);
  }

  function setAuthorIndexValue(index, author, present) {
    const userId = String(author && author.userId || "").trim();
    const username = String(author && author.username || "").trim().toLocaleLowerCase();
    if (userId) index.userIds[present ? "add" : "delete"](userId);
    if (username) index.usernames[present ? "add" : "delete"](username);
  }

  function applyAuthorDecisionLocally(status, author) {
    const item = {
      username: String(author && author.username || "").trim(),
      userId: String(author && author.userId || "").trim(),
      addedAt: new Date().toISOString(),
      sourceUrl: String(author && (author.profileUrl || author.sourceUrl) || location.href)
    };
    if (status === "included") {
      for (const [list, index] of [[state.blockedAuthors, blockedAuthorIndex], [state.reviewedAuthors, reviewedAuthorIndex]]) {
        for (let position = list.length - 1; position >= 0; position -= 1) {
          if (!Core.authorsMatch(list[position], item)) continue;
          setAuthorIndexValue(index, list[position], false);
          list.splice(position, 1);
        }
      }
      curatedRefreshNotBefore = Date.now() + 8000;
      return item;
    }
    const blocking = status === "blocked";
    const target = blocking ? state.blockedAuthors : state.reviewedAuthors;
    const other = blocking ? state.reviewedAuthors : state.blockedAuthors;
    const targetIndex = blocking ? blockedAuthorIndex : reviewedAuthorIndex;
    const otherIndex = blocking ? reviewedAuthorIndex : blockedAuthorIndex;
    let storedItem = item;
    if (Core.authorIndexHas(targetIndex, item)) {
      const existing = target.find(value => Core.authorsMatch(value, item));
      if (existing) {
        Object.assign(existing, item);
        storedItem = existing;
      }
    } else target.push(item);
    setAuthorIndexValue(targetIndex, item, true);
    if (Core.authorIndexHas(otherIndex, item)) {
      for (let index = other.length - 1; index >= 0; index -= 1) {
        if (!Core.authorsMatch(other[index], item)) continue;
        setAuthorIndexValue(otherIndex, other[index], false);
        other.splice(index, 1);
      }
    }
    curatedRefreshNotBefore = Date.now() + 8000;
    return storedItem;
  }

  function createButton(label, action, pressed, title) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.nlcAction = action;
    button.setAttribute("aria-pressed", pressed ? "true" : "false");
    if (title) button.title = title;
    return button;
  }

  function ensureControls(tile, mod, decision) {
    const blocked = isAuthorBlocked(mod.author);
    const hidden = isAuthorReviewed(mod.author);
    let controls = tile.querySelector(":scope > .nlc-controls");
    if (!controls) {
      controls = document.createElement("div");
      controls.className = "nlc-controls";
      controls.dataset.nlcOwned = "true";
      if (tile.lastElementChild) tile.lastElementChild.dataset.nlcPreviousBottom = "true";
      tile.appendChild(controls);
      const keep = createButton("Keep", "keep", decision && decision.status === "keep", "Keep this mod as a candidate");
      keep.classList.add("nlc-keep-mod");
      const trim = createButton("Trim", "trim", decision && decision.status === "trim", "Keep only part of this mod; it needs trimming later");
      trim.classList.add("nlc-trim-mod");
      const skip = createButton("Skip", "skip", decision && decision.status === "skip", "Hide this individual mod");
      skip.classList.add("nlc-skip-mod");
      const review = createButton("", "", false);
      review.classList.add("nlc-review-author");
      const block = createButton("", "", false);
      block.classList.add("nlc-block-author");
      controls.append(keep, trim, skip, review, block);
    }
    const keep = controls.querySelector(".nlc-keep-mod");
    const trim = controls.querySelector(".nlc-trim-mod");
    const skip = controls.querySelector(".nlc-skip-mod");
    const review = controls.querySelector(".nlc-review-author");
    const block = controls.querySelector(".nlc-block-author");
    if (keep) {
      const kept = decision && decision.status === "keep";
      keep.textContent = kept ? "Unkeep" : "Keep";
      keep.dataset.nlcAction = kept ? "unkeep" : "keep";
      keep.setAttribute("aria-pressed", kept ? "true" : "false");
      keep.title = kept ? "Remove this mod from your Keep shortlist" : "Keep this mod as a candidate";
    }
    if (trim) {
      const trimmed = decision && decision.status === "trim";
      trim.textContent = trimmed ? "Untrim" : "Trim";
      trim.dataset.nlcAction = trimmed ? "untrim" : "trim";
      trim.setAttribute("aria-pressed", trimmed ? "true" : "false");
      trim.title = trimmed
        ? "Remove this mod from your Trim shortlist"
        : "Keep only part of this mod; it needs trimming later";
    }
    if (skip) {
      const skipped = decision && decision.status === "skip";
      skip.textContent = skipped ? "Unskip" : "Skip";
      skip.dataset.nlcAction = skipped ? "unskip" : "skip";
      skip.setAttribute("aria-pressed", skipped ? "true" : "false");
      skip.title = skipped ? "Remove this mod from the skipped list" : "Hide this individual mod";
    }
    if (review) {
      review.disabled = false;
      review.textContent = hidden ? "Unhide" : "Hide";
      review.dataset.nlcAction = hidden ? "unreview-author" : "review-author";
      review.setAttribute("aria-pressed", hidden ? "true" : "false");
      review.title = hidden
        ? `Remove ${mod.author.username || "this author"} from the hidden-author list`
        : `Hide ${mod.author.username || "this reviewed author"} from discovery listings`;
    }
    if (block) {
      block.disabled = false;
      block.textContent = blocked ? "Include" : "Exclude";
      block.dataset.nlcAction = blocked ? "unblock-author" : "block-author";
      block.setAttribute("aria-pressed", blocked ? "true" : "false");
      block.title = blocked
        ? `Remove ${mod.author.username || "this author"} from the excluded-author list`
        : `Exclude ${mod.author.username || "this author"} because you want none of their mods`;
    }
  }

  function statusButton(label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.nlcAction = action;
    button.textContent = label;
    return button;
  }

  function decisionCount(status) {
    return state.modDecisions.filter(decision => decision.status === status).length;
  }

  function displayedCuratedPage() {
    return curatedPageCount === 0 ? 0 : curatedPage;
  }

  function sourcePageRangeText() {
    if (!curatedPageCount) return "no source pages";
    const start = displayedCuratedPage().toLocaleString();
    const end = Math.max(curatedPage, currentBatchSourceEndPage).toLocaleString();
    return start === end
      ? `source page ${start} of ${curatedPageCount.toLocaleString()}`
      : `source pages ${start}–${end} of ${curatedPageCount.toLocaleString()}`;
  }

  function updatePageStatus(total, counts) {
    let badge = document.getElementById("nlc-page-status");
    if (!state.settings.showPageStatus) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "nlc-page-status";
      badge.dataset.nlcOwned = "true";
      const text = document.createElement("span");
      text.className = "nlc-status-text";
      badge.append(
        text,
        statusButton("Show Hidden", "toggle-hidden"),
        statusButton("Show Blocked", "toggle-blocked"),
        statusButton("Show Skipped", "toggle-skipped"),
        statusButton("Manage", "open-options")
      );
      document.body.appendChild(badge);
    }
    const hiddenButton = badge.querySelector('[data-nlc-action="toggle-hidden"]');
    const blockedButton = badge.querySelector('[data-nlc-action="toggle-blocked"]');
    const skippedButton = badge.querySelector('[data-nlc-action="toggle-skipped"]');
    hiddenButton.textContent = showHidden ? "Hide Hidden" : "Show Hidden";
    hiddenButton.setAttribute("aria-pressed", showHidden ? "true" : "false");
    blockedButton.textContent = showBlocked ? "Hide Blocked" : "Show Blocked";
    blockedButton.setAttribute("aria-pressed", showBlocked ? "true" : "false");
    skippedButton.textContent = showSkipped ? "Hide Skipped" : "Show Skipped";
    skippedButton.setAttribute("aria-pressed", showSkipped ? "true" : "false");
    const shown = total - counts.totalHidden;
    const pageText = curatedTotal == null ? "" : ` · batch ${curatedBatchNumber.toLocaleString()} · ${sourcePageRangeText()}`;
    badge.querySelector(".nlc-status-text").textContent =
      `${shown.toLocaleString()} shown · ${state.reviewedAuthors.length.toLocaleString()} hidden authors` +
      ` · ${state.blockedAuthors.length.toLocaleString()} excluded authors` +
      ` · ${decisionCount("skip").toLocaleString()} skipped mods · ${decisionCount("keep").toLocaleString()} kept` +
      ` · ${decisionCount("trim").toLocaleString()} trimmed${pageText}` +
      (curatedLoading ? " · loading filtered catalogue" : "") +
      (curatedError ? ` · ${curatedError}` : "");
  }

  function updateInlineResultSummary(total, hidden) {
    const resultCount = document.querySelector('[data-e2eid="result-count"]');
    if (!resultCount) return;
    let summary = resultCount.querySelector(":scope > .nlc-result-summary");
    if (!summary) {
      summary = document.createElement("span");
      summary.className = "nlc-result-summary";
      summary.dataset.nlcOwned = "true";
      resultCount.appendChild(summary);
    }
    summary.textContent = curatedTotal == null
      ? ` · ${total} loaded · ${hidden} hidden locally`
      : ` · ${curatedTotal.toLocaleString()} source mods · Batch ${curatedBatchNumber.toLocaleString()} · ${sourcePageRangeText()} · ${total - hidden} shown locally`;
  }

  function updateLoadingIndicator() {
    let indicator = document.getElementById("nlc-loading-indicator");
    if (!curatedLoading) {
      if (indicator) indicator.remove();
      return;
    }
    if (indicator) return;
    indicator = document.createElement("div");
    indicator.id = "nlc-loading-indicator";
    indicator.dataset.nlcOwned = "true";
    indicator.setAttribute("role", "status");
    indicator.setAttribute("aria-live", "polite");
    const spinner = document.createElement("span");
    spinner.className = "nlc-loading-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = "Loading next 80…";
    indicator.append(spinner, label);
    document.body.appendChild(indicator);
  }

  function listingGame() {
    const match = location.pathname.match(/^\/games\/([^/]+)\/mods\/?$/i);
    return match ? decodeURIComponent(match[1]).toLocaleLowerCase() : "";
  }

  function isAuthorCataloguePage() {
    if (/^\/profile\/[^/]+(?:\/mods)?\/?$/i.test(location.pathname)) return true;
    if (!/^\/users\/\d+\/?$/i.test(location.pathname)) return false;
    const tab = new URL(location.href).searchParams.get("tab") || "";
    return /^(files|user files|user\+files|mods)$/i.test(tab.replace(/\+/g, " ").trim());
  }

  function routeAuthorLinkToMods(link) {
    if (!link) return;
    try {
      const url = new URL(link.href, location.href);
      if (!/(^|\.)nexusmods\.com$/i.test(url.hostname)) return;
      const profile = url.pathname.match(/^(\/profile\/[^/]+)(?:\/about-me)?\/?$/i);
      if (profile) {
        url.pathname = `${profile[1]}/mods`;
      } else if (/^\/users\/\d+\/?$/i.test(url.pathname)) {
        url.searchParams.set("tab", "user files");
      } else {
        return;
      }
      link.href = url.href;
    } catch (_error) {
      // Leave malformed or unexpected page-provided links untouched.
    }
  }

  function selectedValues(url, name) {
    return Array.from(url.searchParams.entries())
      .filter(([key]) => key.toLocaleLowerCase().replace(/\[\]$/, "") === name.toLocaleLowerCase())
      .map(([, value]) => value)
      .flatMap(value => value.split(","))
      .map(value => value.trim())
      .filter(Boolean);
  }

  function selectedFacetValues(url, name, containerId) {
    const fromUrl = selectedValues(url, name);
    const container = document.querySelector(`[data-e2eid="${containerId}"]`);
    if (!container) return fromUrl;
    return Array.from(container.querySelectorAll('[data-e2eid^="checkbox-filter-"][role="checkbox"][aria-checked="true"]'))
      .map(checkbox => {
        const label = checkbox.id
          ? Array.from(document.querySelectorAll("label[for]")).find(item => item.getAttribute("for") === checkbox.id)
          : null;
        return String(label && (label.dataset.nlcFacetName || label.textContent) || "")
          .replace(/\s*\((?:[\d,]+|…|—)\)\s*$/, "")
          .trim();
      })
      .filter(Boolean);
  }

  function currentCatalogueRequest() {
    const url = new URL(location.href);
    const sortName = url.searchParams.get("sort") || "createdAt";
    const sortMap = {
      createdAt: "newest",
      updatedAt: "updated",
      downloads: "downloads",
      endorsements: "endorsements",
      name: "name"
    };
    return {
      mode: "stream",
      gameDomainName: listingGame(),
      page: curatedPage,
      sort: sortMap[sortName] || "newest",
      sortDirection: url.searchParams.get("sortDirection") || "",
      filters: {
        languageNames: selectedFacetValues(url, "languageName", "language-support-filter"),
        categoryNames: selectedFacetValues(url, "categoryName", "category-filter")
      }
    };
  }

  function streamContextSignature() {
    const request = currentCatalogueRequest();
    return JSON.stringify({
      mode: request.mode,
      gameDomainName: request.gameDomainName,
      sort: request.sort,
      sortDirection: request.sortDirection,
      filters: request.filters
    });
  }

  function normaliseStreamCursor(value) {
    const input = value && typeof value === "object" ? value : { page: value };
    return {
      page: Math.max(1, Number.parseInt(input.page, 10) || 1),
      index: Math.max(0, Number.parseInt(input.index, 10) || 0),
      batch: Math.max(1, Number.parseInt(input.batch, 10) || 1),
      history: (Array.isArray(input.history) ? input.history : []).slice(-20).map(item => ({
        page: Math.max(1, Number.parseInt(item && item.page, 10) || 1),
        index: Math.max(0, Number.parseInt(item && item.index, 10) || 0),
        batch: Math.max(1, Number.parseInt(item && item.batch, 10) || 1)
      }))
    };
  }

  function syncStreamCursor() {
    const context = streamContextSignature();
    if (context === activeStreamContext) return context;
    activeStreamContext = context;
    const saved = streamCursors[context];
    savedBacklogCursor = saved == null ? null : normaliseStreamCursor(saved);
    curatedPage = 1;
    curatedSourceIndex = 0;
    curatedBatchNumber = 1;
    currentSourceResponse = null;
    currentBatchNextCursor = null;
    currentBatchSourceEndPage = 1;
    streamCursorHistory = [];
    loadedCuratedSignature = "";
    return context;
  }

  function persistStreamCursor() {
    if (!activeStreamContext) return;
    const cursor = {
      page: curatedPage,
      index: curatedSourceIndex,
      batch: curatedBatchNumber,
      history: streamCursorHistory.slice(-20)
    };
    streamCursors[activeStreamContext] = cursor;
    savedBacklogCursor = normaliseStreamCursor(cursor);
    Promise.resolve(sendRuntimeMessage({
      type: "persist-stream-cursor",
      context: activeStreamContext,
      cursor
    })).catch(() => {});
  }

  function signatureForCatalogue() {
    const request = currentCatalogueRequest();
    return JSON.stringify({
      gameDomainName: request.gameDomainName,
      sort: request.sort,
      sortDirection: request.sortDirection,
      filters: request.filters,
      apiKeyConfigured,
      page: request.page,
      index: curatedSourceIndex,
      batch: curatedBatchNumber
    });
  }

  function contextSignatureForCatalogue() {
    const request = currentCatalogueRequest();
    return JSON.stringify({
      gameDomainName: request.gameDomainName,
      sort: request.sort,
      sortDirection: request.sortDirection,
      filters: request.filters,
      apiKeyConfigured
    });
  }

  function querySignatureForCatalogue() {
    const request = currentCatalogueRequest();
    return JSON.stringify({
      gameDomainName: request.gameDomainName,
      sort: request.sort,
      sortDirection: request.sortDirection,
      filters: request.filters
    });
  }

  function languageContextSignatureForCatalogue() {
    const request = currentCatalogueRequest();
    return JSON.stringify({
      gameDomainName: request.gameDomainName,
      categoryNames: request.filters.categoryNames,
      apiKeyConfigured
    });
  }

  function categoryContextSignatureForCatalogue() {
    const request = currentCatalogueRequest();
    return JSON.stringify({
      gameDomainName: request.gameDomainName,
      languageNames: request.filters.languageNames,
      apiKeyConfigured
    });
  }

  function nativeTiles() {
    return Array.from(document.querySelectorAll(`${TILE_SELECTOR}:not([data-nlc-api-tile])`));
  }

  function clearCuratedDisplay() {
    document.querySelectorAll("[data-nlc-api-tile], .nlc-api-empty, .nlc-api-pagination, .nlc-api-header").forEach(element => element.remove());
    nativeTiles().forEach(tile => tile.classList.remove("nlc-native-suppressed"));
    document.body.classList.remove("nlc-curated-active");
    curatedTotal = null;
    curatedVisibleCount = 0;
    curatedPageCount = 0;
  }

  function showCuratedLoading() {
    const originals = nativeTiles();
    const existing = document.querySelector("[data-nlc-api-tile], .nlc-api-pagination, .nlc-api-empty");
    const container = (existing && existing.parentElement) || (originals[0] && originals[0].parentElement);
    if (!container) return;
    document.querySelectorAll("[data-nlc-api-tile], .nlc-api-pagination, .nlc-api-empty, .nlc-api-header").forEach(element => element.remove());
    originals.forEach(tile => tile.classList.add("nlc-native-suppressed"));
    const loading = document.createElement("div");
    loading.className = "nlc-api-empty";
    loading.dataset.nlcOwned = "true";
    loading.textContent = "Finding the next source page with visible mods…";
    container.appendChild(loading);
    curatedTotal = null;
    curatedPageCount = 0;
    document.body.classList.add("nlc-curated-active");
  }

  function showCuratedError(message) {
    const loading = document.querySelector(".nlc-api-empty");
    if (!loading) return;
    const text = document.createElement("span");
    text.textContent = `Could not load the selected results: ${message}`;
    const retry = statusButton("Retry", "curated-refresh");
    loading.replaceChildren(text, retry);
    loading.classList.add("nlc-api-error");
  }

  function apiTile(node, gameDomainName) {
    const mod = ApiCore.normaliseApiMod(node, gameDomainName);
    const tile = document.createElement("article");
    tile.className = "nlc-api-tile";
    tile.dataset.e2eid = "mod-tile";
    tile.dataset.nlcApiTile = "true";
    tile.dataset.nlcOwned = "true";
    tile.dataset.nlcAuthorId = mod.author.userId || "";
    tile.dataset.nlcAuthorName = String(mod.author.username || "").trim().toLocaleLowerCase();

    if (mod.thumbnailUrl) {
      try {
        const imageUrl = new URL(mod.thumbnailUrl);
        if (imageUrl.protocol === "https:") {
          const imageLink = document.createElement("a");
          imageLink.href = mod.sourceUrl;
          const image = document.createElement("img");
          image.className = "nlc-api-image";
          image.src = imageUrl.href;
          image.alt = "";
          image.loading = "lazy";
          image.decoding = "async";
          image.fetchPriority = "low";
          imageLink.appendChild(image);
          tile.appendChild(imageLink);
        }
      } catch (_error) {
        // The API image is optional; invalid URLs are ignored.
      }
    }

    const body = document.createElement("div");
    body.className = "nlc-api-body";
    const title = document.createElement("a");
    title.dataset.e2eid = "mod-tile-title";
    title.href = mod.sourceUrl;
    title.textContent = mod.title;
    const authorLine = document.createElement("div");
    authorLine.className = "nlc-api-author";
    authorLine.append("by ");
    const author = document.createElement("a");
    author.dataset.e2eid = "user-link";
    author.dataset.nlcUserId = mod.author.userId;
    author.href = mod.author.profileUrl || mod.sourceUrl;
    author.textContent = mod.author.username || "Unknown author";
    authorLine.appendChild(author);
    const summary = document.createElement("p");
    summary.textContent = mod.summary || "No summary provided.";
    const metadata = document.createElement("div");
    metadata.className = "nlc-api-metadata";
    metadata.textContent = `${mod.category || "Uncategorised"} · ${mod.downloads.toLocaleString()} downloads · ${mod.endorsements.toLocaleString()} endorsements`;
    body.append(title, authorLine, summary, metadata);
    tile.appendChild(body);
    return tile;
  }

  function facetCounts(value) {
    const counts = new Map();
    if (Array.isArray(value)) {
      for (const item of value) {
        const name = String(item && (item.value || item.name || item.label) || "").trim();
        const count = Number(item && (item.count ?? item.totalCount));
        if (name && Number.isFinite(count)) counts.set(name.replace(/\s+/g, " ").toLocaleLowerCase(), count);
      }
    } else if (value && typeof value === "object") {
      for (const [name, item] of Object.entries(value)) {
        const count = Number(item && typeof item === "object" ? (item.count ?? item.totalCount) : item);
        if (Number.isFinite(count)) counts.set(name.replace(/\s+/g, " ").trim().toLocaleLowerCase(), count);
      }
    }
    return counts;
  }

  function updateFacetCounts(facetsData, totalCount, filters) {
    const available = facetCounts(facetsData && facetsData.categoryName);
    const selected = [
      ...(filters && filters.languageNames || []),
      ...(filters && filters.categoryNames || [])
    ];
    if (selected.length === 1) {
      available.set(selected[0].replace(/\s+/g, " ").trim().toLocaleLowerCase(), Number(totalCount || 0));
    }
    if (!available.size) return;
    for (const label of document.querySelectorAll("label[for]")) {
      const match = label.textContent.trim().match(/^(.*?)\s*\(([\d,]+)\)\s*$/);
      if (!match) continue;
      const name = match[1].replace(/\s+/g, " ").trim();
      const count = available.get(name.toLocaleLowerCase());
      if (count == null) continue;
      if (!label.dataset.nlcServerCount) label.dataset.nlcServerCount = match[2].replace(/,/g, "");
      label.dataset.nlcFacetName = name;
      const suffix = Array.from(label.querySelectorAll("span, small, strong"))
        .reverse()
        .find(element => /^\s*\(([\d,]+|…|—)\)\s*$/.test(element.textContent) && !element.children.length);
      if (suffix) suffix.textContent = `(${count.toLocaleString()})`;
      else label.textContent = `${name} (${count.toLocaleString()})`;
      label.title = `Nexus count: ${Number(label.dataset.nlcServerCount).toLocaleString()}; after your local lists: ${count.toLocaleString()}`;
    }
  }

  function hideFacetSuffixes() {
    for (const container of document.querySelectorAll('[data-e2eid="language-support-filter"], [data-e2eid="category-filter"]')) {
      for (const label of container.querySelectorAll("label[for]")) {
        const match = label.textContent.trim().match(/^(.*?)\s*\((([\d,]+)|…|—)\)\s*$/);
        if (!match) continue;
        if (!label.dataset.nlcFacetName) label.dataset.nlcFacetName = match[1].replace(/\s+/g, " ").trim();
        const suffix = Array.from(label.querySelectorAll("span, small, strong"))
          .reverse()
          .find(element => /^\s*\(([\d,]+|…|—)\)\s*$/.test(element.textContent) && !element.children.length);
        if (suffix) suffix.classList.add("nlc-facet-count-suppressed");
        else label.textContent = label.dataset.nlcFacetName;
      }
    }
  }

  function availableLanguageNames() {
    const container = document.querySelector('[data-e2eid="language-support-filter"]');
    if (!container) return [];
    return Array.from(container.querySelectorAll('[data-e2eid^="checkbox-filter-"][role="checkbox"]'))
      .map(checkbox => {
        const label = checkbox.id
          ? Array.from(container.querySelectorAll("label[for]")).find(item => item.getAttribute("for") === checkbox.id)
          : null;
        return String(label && (label.dataset.nlcFacetName || label.textContent) || "")
          .replace(/\s*\((?:[\d,]+|…|—)\)\s*$/, "")
          .trim();
      })
      .filter(Boolean);
  }

  function updateExactLanguageCounts(counts) {
    const container = document.querySelector('[data-e2eid="language-support-filter"]');
    if (!container || !counts || typeof counts !== "object") return;
    const exact = new Map(Object.entries(counts).map(([name, count]) => [name.replace(/\s+/g, " ").trim().toLocaleLowerCase(), Number(count || 0)]));
    for (const label of container.querySelectorAll("label[for]")) {
      const match = label.textContent.trim().match(/^(.*?)\s*\((([\d,]+)|…|—)\)\s*$/);
      if (!match) continue;
      const name = String(label.dataset.nlcFacetName || match[1]).replace(/\s+/g, " ").trim();
      const count = exact.get(name.toLocaleLowerCase());
      if (count == null) continue;
      if (!label.dataset.nlcServerCount && /^[\d,]+$/.test(match[2])) label.dataset.nlcServerCount = match[2].replace(/,/g, "");
      label.dataset.nlcFacetName = name;
      const suffix = Array.from(label.querySelectorAll("span, small, strong"))
        .reverse()
        .find(element => /^\s*\(([\d,]+|…|—)\)\s*$/.test(element.textContent) && !element.children.length);
      if (suffix) suffix.textContent = `(${count.toLocaleString()})`;
      else label.textContent = `${name} (${count.toLocaleString()})`;
      const original = label.dataset.nlcServerCount ? Number(label.dataset.nlcServerCount).toLocaleString() : "unknown";
      label.title = `Nexus count: ${original}; after your local lists: ${count.toLocaleString()}`;
    }
  }

  function markLanguageCountsPending() {
    const container = document.querySelector('[data-e2eid="language-support-filter"]');
    if (!container) return;
    for (const label of container.querySelectorAll("label[for]")) {
      const match = label.textContent.trim().match(/^(.*?)\s*\(([\d,]+)\)\s*$/);
      if (!match) continue;
      const name = String(label.dataset.nlcFacetName || match[1]).replace(/\s+/g, " ").trim();
      if (Object.prototype.hasOwnProperty.call(curatedLanguageCounts, name)) continue;
      if (!label.dataset.nlcServerCount) label.dataset.nlcServerCount = match[2].replace(/,/g, "");
      label.dataset.nlcFacetName = name;
      const suffix = Array.from(label.querySelectorAll("span, small, strong"))
        .reverse()
        .find(element => /^\s*\([\d,]+\)\s*$/.test(element.textContent) && !element.children.length);
      if (suffix) suffix.textContent = "(…)";
      else label.textContent = `${name} (…)`;
      label.title = "Calculating this count after your local lists…";
    }
  }

  function availableCategoryNames() {
    const container = document.querySelector('[data-e2eid="category-filter"]');
    if (!container) return [];
    return Array.from(container.querySelectorAll('[data-e2eid^="checkbox-filter-"][role="checkbox"]'))
      .map(checkbox => {
        const label = checkbox.id
          ? Array.from(container.querySelectorAll("label[for]")).find(item => item.getAttribute("for") === checkbox.id)
          : null;
        return String(label && (label.dataset.nlcFacetName || label.textContent) || "")
          .replace(/\s*\((?:[\d,]+|…|—)\)\s*$/, "")
          .trim();
      })
      .filter(Boolean);
  }

  function updateExactCategoryCounts(counts) {
    const container = document.querySelector('[data-e2eid="category-filter"]');
    if (!container || !counts || typeof counts !== "object") return;
    const exact = new Map(Object.entries(counts).map(([name, count]) => [name.replace(/\s+/g, " ").trim().toLocaleLowerCase(), Number(count || 0)]));
    for (const label of container.querySelectorAll("label[for]")) {
      const match = label.textContent.trim().match(/^(.*?)\s*\((([\d,]+)|…|—)\)\s*$/);
      if (!match) continue;
      const name = String(label.dataset.nlcFacetName || match[1]).replace(/\s+/g, " ").trim();
      const count = exact.get(name.toLocaleLowerCase());
      if (count == null) continue;
      if (!label.dataset.nlcServerCount && /^[\d,]+$/.test(match[2])) label.dataset.nlcServerCount = match[2].replace(/,/g, "");
      label.dataset.nlcFacetName = name;
      const suffix = Array.from(label.querySelectorAll("span, small, strong"))
        .reverse()
        .find(element => /^\s*\(([\d,]+|…|—)\)\s*$/.test(element.textContent) && !element.children.length);
      if (suffix) suffix.textContent = `(${count.toLocaleString()})`;
      else label.textContent = `${name} (${count.toLocaleString()})`;
      const original = label.dataset.nlcServerCount ? Number(label.dataset.nlcServerCount).toLocaleString() : "unknown";
      label.title = `Nexus count: ${original}; after your local lists: ${count.toLocaleString()}`;
    }
  }

  function markCategoryCountsPending() {
    const container = document.querySelector('[data-e2eid="category-filter"]');
    if (!container) return;
    for (const label of container.querySelectorAll("label[for]")) {
      const match = label.textContent.trim().match(/^(.*?)\s*\(([\d,]+)\)\s*$/);
      if (!match) continue;
      const name = String(label.dataset.nlcFacetName || match[1]).replace(/\s+/g, " ").trim();
      if (Object.prototype.hasOwnProperty.call(curatedCategoryCounts, name)) continue;
      if (!label.dataset.nlcServerCount) label.dataset.nlcServerCount = match[2].replace(/,/g, "");
      label.dataset.nlcFacetName = name;
      const suffix = Array.from(label.querySelectorAll("span, small, strong"))
        .reverse()
        .find(element => /^\s*\([\d,]+\)\s*$/.test(element.textContent) && !element.children.length);
      if (suffix) suffix.textContent = "(…)";
      else label.textContent = `${name} (…)`;
      label.title = "Calculating this count after your local lists…";
    }
  }

  function pagination() {
    const nav = document.createElement("nav");
    nav.className = "nlc-api-pagination";
    nav.dataset.nlcOwned = "true";
    nav.setAttribute("aria-label", "Nexus Local Curator pagination");
    const previous = statusButton("Previous batch", "curated-prev");
    previous.disabled = streamCursorHistory.length === 0;
    const resume = statusButton("Resume backlog", "curated-resume");
    resume.disabled = !savedBacklogCursor ||
      (savedBacklogCursor.page === curatedPage &&
        savedBacklogCursor.index === curatedSourceIndex &&
        savedBacklogCursor.batch === curatedBatchNumber);
    const text = document.createElement("strong");
    text.textContent = `Batch ${curatedBatchNumber.toLocaleString()} · ${sourcePageRangeText()}`;
    const next = statusButton("Next batch", "curated-next");
    next.disabled = !currentBatchNextCursor;
    nav.append(previous, resume, text, next);
    return nav;
  }

  function catalogueHeader() {
    const header = document.createElement("header");
    header.className = "nlc-api-header";
    header.dataset.nlcOwned = "true";
    const identity = document.createElement("div");
    const eyebrow = document.createElement("span");
    eyebrow.textContent = "Nexus Local Curator";
    const title = document.createElement("strong");
    title.textContent = `${curatedVisibleCount.toLocaleString()} unreviewed mods in this batch`;
    identity.append(eyebrow, title);
    const page = document.createElement("div");
    page.className = "nlc-api-header-page";
    page.textContent = `Up to 80 candidates · ${sourcePageRangeText()}`;
    const newest = statusButton("Check newest", "curated-newest");
    newest.disabled = curatedPage === 1 && curatedSourceIndex === 0 && curatedBatchNumber === 1;
    page.appendChild(newest);
    header.append(identity, page);
    return header;
  }

  function sourceNodeIsVisible(node, gameDomainName) {
    const mod = ApiCore.normaliseApiMod(node, gameDomainName);
    const blocked = Core.authorIndexHas(blockedAuthorIndex, mod.author);
    const reviewed = Core.authorIndexHas(reviewedAuthorIndex, mod.author);
    const decision = Core.decisionFor(state, mod);
    const decisionVisible = !decision || (showSkipped && decision.status === "skip");
    return (showBlocked || !blocked) && (showHidden || !reviewed) && decisionVisible;
  }

  function renderCuratedResults(response, gameDomainName, filters) {
    const originals = nativeTiles();
    const existing = document.querySelector("[data-nlc-api-tile], .nlc-api-pagination, .nlc-api-empty, .nlc-api-header");
    const container = (existing && existing.parentElement) || (originals[0] && originals[0].parentElement);
    if (!container) throw new Error("Nexus result grid was not found.");
    curatedTotal = Number(response.totalCount || 0);
    curatedPageCount = curatedTotal ? Math.ceil(curatedTotal / ApiCore.API_BATCH_SIZE) : 0;
    currentBatchSourceEndPage = Math.max(curatedPage, Number(response.streamEndPage || curatedPage));
    const responseHasStats = Number.isFinite(response.hiddenModCount) && Number.isFinite(response.excludedModCount);
    if (responseHasStats) {
      curatedHiddenModCount = Number(response.hiddenModCount);
      curatedExcludedModCount = Number(response.excludedModCount);
      curatedStatsReady = true;
    }
    const sourceNodes = Array.isArray(response.nodes) ? response.nodes.slice(0, ApiCore.API_BATCH_SIZE) : [];
    const nodes = sourceNodes.filter(node => sourceNodeIsVisible(node, gameDomainName));
    curatedVisibleCount = nodes.length;
    const nextDisplay = document.createDocumentFragment();
    nextDisplay.appendChild(catalogueHeader());
    if (nodes.length) {
      for (const node of nodes) nextDisplay.appendChild(apiTile(node, gameDomainName));
    } else {
      const empty = document.createElement("div");
      empty.className = "nlc-api-empty";
      empty.dataset.nlcOwned = "true";
      const message = document.createElement("span");
      message.textContent = response.scanPaused
        ? `No visible mods in source pages ${Number(response.streamStartPage || curatedPage).toLocaleString()}–${Number(response.streamEndPage || curatedPage).toLocaleString()}. Choose Next batch to continue.`
        : "No unreviewed mods remain for the selected filters.";
      empty.appendChild(message);
      nextDisplay.appendChild(empty);
    }
    nextDisplay.appendChild(pagination());
    document.querySelectorAll("[data-nlc-api-tile], .nlc-api-empty, .nlc-api-pagination, .nlc-api-header").forEach(element => element.remove());
    originals.forEach(tile => tile.classList.add("nlc-native-suppressed"));
    container.appendChild(nextDisplay);
    hideFacetSuffixes();
    document.body.classList.add("nlc-curated-active");
    return nodes.length;
  }

  function shouldUseCuratedCatalogue() {
    return Boolean(ApiCore && apiKeyConfigured && listingGame()) &&
      Boolean(state.blockedAuthors.length || state.reviewedAuthors.length || state.modDecisions.length);
  }

  function recordDiagnostics(request, response, error) {
    let extensionVersion = "unknown";
    try {
      extensionVersion = browser.runtime.getManifest().version;
    } catch (_error) {
      // Diagnostics must never interfere with filtering.
    }
    const safe = {
      capturedAt: new Date().toISOString(),
      extensionVersion,
      gameDomainName: request.gameDomainName,
      page: request.page,
      sort: request.sort,
      sortDirection: request.sortDirection,
      filters: request.filters,
      apiKeyConfigured,
      listCounts: {
        hiddenAuthors: state.reviewedAuthors.length,
        excludedAuthors: state.blockedAuthors.length,
        skippedMods: decisionCount("skip"),
        keptMods: decisionCount("keep"),
        trimmedMods: decisionCount("trim")
      },
      response: response && response.ok ? {
        returnedMods: Array.isArray(response.nodes) ? response.nodes.length : 0,
        totalCount: Number(response.totalCount || 0),
        hiddenModCount: Number.isFinite(response.hiddenModCount) ? Number(response.hiddenModCount) : null,
        excludedModCount: Number.isFinite(response.excludedModCount) ? Number(response.excludedModCount) : null,
        transport: response.diagnostics || null
      } : (response ? { status: Number(response.status || 0), transport: response.diagnostics || null } : null),
      error: error ? String(error.message || error) : ""
    };
    try {
      Promise.resolve(browser.storage.local.set({ lastDiagnostics: safe })).catch(console.warn);
    } catch (diagnosticError) {
      console.warn("Nexus Local Curator could not store safe diagnostics", diagnosticError);
    }
  }

  function languageCountsComplete() {
    const names = availableLanguageNames();
    return names.length > 0 && names.every(name => curatedLanguageRefreshed.has(name));
  }

  function categoryCountsComplete() {
    const names = availableCategoryNames();
    return names.length > 0 && names.every(name => curatedCategoryRefreshed.has(name));
  }

  function mergeLanguageCounts(counts, languageSequence, languageContext) {
    if (languageSequence !== curatedLanguageSequence || languageContext !== languageContextSignatureForCatalogue()) return;
    if (!counts || typeof counts !== "object") return;
    curatedLanguageCounts = { ...curatedLanguageCounts, ...counts };
    Object.keys(counts).forEach(name => curatedLanguageRefreshed.add(name));
    curatedLanguageCountsReady = languageCountsComplete();
    updateExactLanguageCounts(curatedLanguageCounts);
    if (!curatedLanguageCountsReady) markLanguageCountsPending();
    scheduleApply();
  }

  async function requestLanguageBatch(names, request, languageSequence, languageContext) {
    try {
      const response = await sendRuntimeMessage({
        type: "nexus-api-language-counts",
        request: { ...request, page: 1, languageFacetNames: names }
      });
      if (response && response.ok) mergeLanguageCounts(response.languageCounts, languageSequence, languageContext);
    } catch (_error) {
      // A later refresh can retry a failed batch without affecting the cards.
    }
  }

  function mergeCategoryCounts(counts, categorySequence, categoryContext) {
    if (categorySequence !== curatedCategorySequence || categoryContext !== categoryContextSignatureForCatalogue()) return;
    if (!counts || typeof counts !== "object") return;
    curatedCategoryCounts = { ...curatedCategoryCounts, ...counts };
    Object.keys(counts).forEach(name => curatedCategoryRefreshed.add(name));
    curatedCategoryCountsReady = categoryCountsComplete();
    updateExactCategoryCounts(curatedCategoryCounts);
    if (!curatedCategoryCountsReady) markCategoryCountsPending();
    scheduleApply();
  }

  async function requestCategoryBatch(names, request, categorySequence, categoryContext) {
    try {
      const response = await sendRuntimeMessage({
        type: "nexus-api-category-counts",
        request: { ...request, page: 1, categoryFacetNames: names }
      });
      if (response && response.ok) mergeCategoryCounts(response.categoryCounts, categorySequence, categoryContext);
    } catch (_error) {
      // A later refresh can retry a failed batch without affecting the cards.
    }
  }

  async function requestBatches(names, size, callback, concurrency = 1) {
    const batches = [];
    for (let index = 0; index < names.length; index += size) batches.push(names.slice(index, index + size));
    let next = 0;
    async function worker() {
      while (next < batches.length) {
        const batch = batches[next];
        next += 1;
        await callback(batch);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  }

  async function requestFacetQueues(languageNames, categoryNames, request, sequences) {
    const languageBatches = [];
    const categoryBatches = [];
    for (let index = 0; index < languageNames.length; index += 4) languageBatches.push(languageNames.slice(index, index + 4));
    for (let index = 0; index < categoryNames.length; index += 4) categoryBatches.push(categoryNames.slice(index, index + 4));
    const length = Math.max(languageBatches.length, categoryBatches.length);
    for (let index = 0; index < length; index += 1) {
      if (languageBatches[index]) {
        await requestLanguageBatch(languageBatches[index], request, sequences.language, sequences.languageContext);
      }
      if (categoryBatches[index]) {
        await requestCategoryBatch(categoryBatches[index], request, sequences.category, sequences.categoryContext);
      }
    }
  }

  function scheduleCuratedStats(request) {
    if (curatedStatsReady && curatedLanguageCountsReady && curatedCategoryCountsReady) return;
    if (curatedStatsTimer) clearTimeout(curatedStatsTimer);
    const context = contextSignatureForCatalogue();
    const sequence = ++curatedStatsSequence;
    const languageContext = languageContextSignatureForCatalogue();
    const languageSequence = curatedLanguageSequence;
    const categoryContext = categoryContextSignatureForCatalogue();
    const categorySequence = curatedCategorySequence;
    curatedStatsTimer = setTimeout(async () => {
      curatedStatsTimer = null;
      try {
        const missingLanguages = curatedLanguageCountsReady
          ? []
          : availableLanguageNames().filter(name => !curatedLanguageRefreshed.has(name));
        const missingCategories = curatedCategoryCountsReady
          ? []
          : availableCategoryNames().filter(name => !curatedCategoryRefreshed.has(name));
        const firstLanguageBatch = missingLanguages.slice(0, 4);
        const response = await sendRuntimeMessage({
          type: "nexus-api-filter-stats",
          request: {
            ...request,
            page: 1,
            languageFacetNames: firstLanguageBatch
          }
        });
        if (response && response.ok) mergeLanguageCounts(response.languageCounts, languageSequence, languageContext);
        requestFacetQueues(missingLanguages.slice(4), missingCategories, request, {
          language: languageSequence,
          languageContext,
          category: categorySequence,
          categoryContext
        }).catch(() => {});
        if (sequence !== curatedStatsSequence || context !== contextSignatureForCatalogue()) return;
        if (!response || !response.ok) return;
        curatedHiddenModCount = Number(response.hiddenModCount || 0);
        curatedExcludedModCount = Number(response.excludedModCount || 0);
        curatedStatsReady = true;
        scheduleApply();
      } catch (_error) {
        // Statistics are optional and must never delay or break the result grid.
      }
    }, 1500);
  }

  async function loadCuratedCatalogue(signature) {
    if (curatedLoading || signature !== desiredCuratedSignature) return;
    curatedLoading = true;
    curatedError = "";
    const sequence = ++curatedSequence;
    const baseRequest = currentCatalogueRequest();
    let response = null;
    const request = {
      ...baseRequest,
      cursor: currentStreamCursor(),
      showBlocked,
      showHidden,
      showSkipped
    };
    showCuratedLoading();
    scheduleApply();
    try {
      response = await sendRuntimeMessage({ type: "nexus-api-batch", request });
      if (sequence !== curatedSequence || signature !== desiredCuratedSignature || response && response.cancelled) return;
      if (!response || !response.ok) throw new Error(response && response.error || "Nexus returned no catalogue data.");
      recordDiagnostics(request, response, null);
      currentBatchNextCursor = response.nextCursor || null;
      currentSourceResponse = response;
      currentBatchSourceEndPage = Number(response.streamEndPage || curatedPage);
      renderCuratedResults(response, baseRequest.gameDomainName, baseRequest.filters);
      loadedCuratedSignature = signature;
    } catch (error) {
      if (sequence === curatedSequence) {
        curatedError = error.message;
        loadedCuratedSignature = signature;
        recordDiagnostics(request, response, error);
        showCuratedError(error.message);
      }
    } finally {
      if (sequence === curatedSequence) curatedLoading = false;
      scheduleApply();
      if (desiredCuratedSignature !== loadedCuratedSignature) scheduleCuratedCatalogue();
    }
  }

  function scheduleCuratedCatalogue(delay = 750, bypassCooldown = false) {
    if (!shouldUseCuratedCatalogue()) {
      if (curatedTimer) clearTimeout(curatedTimer);
      curatedTimer = null;
      desiredCuratedSignature = "";
      loadedCuratedSignature = "";
      curatedError = "";
      catalogueContextSignature = "";
      catalogueQuerySignature = "";
      curatedLanguageContextSignature = "";
      curatedLanguageCounts = {};
      curatedLanguageRefreshed = new Set();
      curatedLanguageCountsReady = false;
      curatedLanguageSequence += 1;
      curatedCategoryContextSignature = "";
      curatedCategoryCounts = {};
      curatedCategoryRefreshed = new Set();
      curatedCategoryCountsReady = false;
      curatedCategorySequence += 1;
      curatedPage = 1;
      if (curatedStatsTimer) clearTimeout(curatedStatsTimer);
      curatedStatsTimer = null;
      curatedStatsSequence += 1;
      curatedStatsReady = false;
      activeStreamContext = "";
      savedBacklogCursor = null;
      currentSourceResponse = null;
      currentBatchNextCursor = null;
      curatedSourceIndex = 0;
      curatedBatchNumber = 1;
      currentBatchSourceEndPage = 1;
      streamCursorHistory = [];
      clearCuratedDisplay();
      return;
    }
    syncStreamCursor();
    if (bypassCooldown) curatedRefreshNotBefore = 0;
    else delay = Math.max(delay, curatedRefreshNotBefore - Date.now());
    const query = querySignatureForCatalogue();
    if (catalogueQuerySignature && query !== catalogueQuerySignature) showCuratedLoading();
    catalogueQuerySignature = query;
    const context = contextSignatureForCatalogue();
    if (catalogueContextSignature && context !== catalogueContextSignature) {
      if (curatedStatsTimer) clearTimeout(curatedStatsTimer);
      curatedStatsTimer = null;
      curatedStatsSequence += 1;
      curatedStatsReady = false;
    }
    catalogueContextSignature = context;
    const languageContext = languageContextSignatureForCatalogue();
    if (curatedLanguageContextSignature && languageContext !== curatedLanguageContextSignature) {
      curatedLanguageRefreshed = new Set();
      curatedLanguageCountsReady = false;
      curatedLanguageSequence += 1;
    }
    curatedLanguageContextSignature = languageContext;
    const categoryContext = categoryContextSignatureForCatalogue();
    if (curatedCategoryContextSignature && categoryContext !== curatedCategoryContextSignature) {
      curatedCategoryRefreshed = new Set();
      curatedCategoryCountsReady = false;
      curatedCategorySequence += 1;
    }
    curatedCategoryContextSignature = categoryContext;
    desiredCuratedSignature = signatureForCatalogue();
    if (desiredCuratedSignature === loadedCuratedSignature || curatedLoading) return;
    if (curatedTimer) clearTimeout(curatedTimer);
    curatedTimer = setTimeout(() => {
      curatedTimer = null;
      loadCuratedCatalogue(desiredCuratedSignature).catch(console.error);
    }, delay);
  }

  function currentStreamCursor() {
    return { page: curatedPage, index: curatedSourceIndex, batch: curatedBatchNumber };
  }

  function moveToStreamCursor(cursor, rememberCurrent, saveProgress = true) {
    if (!cursor) return false;
    if (rememberCurrent) streamCursorHistory.push(currentStreamCursor());
    curatedPage = Math.max(1, Number.parseInt(cursor.page, 10) || 1);
    curatedSourceIndex = Math.max(0, Number.parseInt(cursor.index, 10) || 0);
    curatedBatchNumber = Math.max(1, Number.parseInt(cursor.batch, 10) || 1);
    currentBatchSourceEndPage = curatedPage;
    currentBatchNextCursor = null;
    if (saveProgress) persistStreamCursor();
    currentSourceResponse = null;
    loadedCuratedSignature = "";
    desiredCuratedSignature = "";
    scheduleCuratedCatalogue(0, true);
    return true;
  }

  function startNewestStream() {
    curatedPage = 1;
    curatedSourceIndex = 0;
    curatedBatchNumber = 1;
    currentBatchSourceEndPage = 1;
    currentBatchNextCursor = null;
    currentSourceResponse = null;
    streamCursorHistory = [];
    loadedCuratedSignature = "";
    desiredCuratedSignature = "";
    scheduleCuratedCatalogue(0, true);
  }

  function resumeSavedBacklog() {
    if (!savedBacklogCursor) return false;
    streamCursorHistory = savedBacklogCursor.history.slice(-20);
    return moveToStreamCursor(savedBacklogCursor, false, false);
  }

  function advanceStreamAfterExhaustion() {
    if (streamAdvanceScheduled || curatedLoading || !currentBatchNextCursor || currentSourceResponse && currentSourceResponse.scanPaused) return;
    streamAdvanceScheduled = true;
    setTimeout(() => {
      streamAdvanceScheduled = false;
      if (document.querySelector('[data-nlc-api-tile]:not(.nlc-hidden)')) return;
      moveToStreamCursor(currentBatchNextCursor, true);
    }, 0);
  }

  function apply() {
    if (applying) return;
    const startedAt = performance.now();
    let tileCount = 0;
    applying = true;
    try {
      applyTrackingCentreStatus();
      const authorCatalogue = isAuthorCataloguePage();
      const allTiles = Array.from(document.querySelectorAll(TILE_SELECTOR));
      tileCount = allTiles.length;
      for (const tile of allTiles) {
        routeAuthorLinkToMods(tile.querySelector('a[data-e2eid="user-link"], a[href*="/profile/"], a[href*="/users/"]'));
        const mod = Core.readModTile(tile);
        if (!mod) continue;
        tile.dataset.nlcModKey = mod.key;
        tile.dataset.nlcAuthorId = mod.author.userId || "";
        tile.dataset.nlcAuthorName = String(mod.author.username || "").trim().toLocaleLowerCase();
        const decision = Core.decisionFor(state, mod);
        const shouldHide = (!authorCatalogue && (
          (isAuthorBlocked(mod.author) && !showBlocked) ||
          (isAuthorReviewed(mod.author) && !showHidden)
        )) || Boolean(decision && decision.status === "skip" && !showSkipped);
        tile.classList.toggle("nlc-hidden", shouldHide);
        if (!shouldHide) ensureControls(tile, mod, decision);
      }
      const tiles = document.body.classList.contains("nlc-curated-active")
        ? allTiles.filter(tile => tile.hasAttribute("data-nlc-api-tile"))
        : allTiles.filter(tile => !tile.classList.contains("nlc-native-suppressed"));
      const hidden = tiles.filter(tile => tile.classList.contains("nlc-hidden")).length;
      const counts = {
        totalHidden: hidden,
        hiddenAuthorMods: tiles.filter(tile => {
          const mod = Core.readModTile(tile);
          return mod && isAuthorReviewed(mod.author);
        }).length,
        excludedAuthorMods: tiles.filter(tile => {
          const mod = Core.readModTile(tile);
          return mod && isAuthorBlocked(mod.author);
        }).length
      };
      updatePageStatus(tiles.length, counts);
      updateInlineResultSummary(tiles.length, hidden);
      reportVisiblePageToRelay(tiles);
      updateLoadingIndicator();
      hideFacetSuffixes();
      const emptyCuratedPage = document.body.classList.contains("nlc-curated-active") && tiles.length > 0 && hidden === tiles.length;
      if (emptyCuratedPage) advanceStreamAfterExhaustion();
      else scheduleCuratedCatalogue();
    } finally {
      applying = false;
      const durationMs = performance.now() - startedAt;
      if (durationMs >= 25) reportPerformanceDiagnostic({ phase: "card-recount", durationMs, tileCount });
    }
  }

  // --- Curation relay (127.0.0.1 assistant bridge). Loopback is exempt from
  // mixed-content rules, and the relay answers CORS, so the content script can
  // talk to it directly. Decision polling arms only after a successful page
  // report and disarms after 30 idle minutes, so no timer runs outside an
  // active curation session (or in tests, where the relay is absent).
  const RELAY_BASE = "http://127.0.0.1:38492";
  const RELAY_POLL_MS = 3000;
  const RELAY_IDLE_CUTOFF_MS = 30 * 60 * 1000;
  const RELAY_VALID_DECISIONS = new Set(["keep", "trim", "skip", "unreviewed"]);
  let relayReportTimer = null;
  let lastRelayReportSignature = "";
  let relayPollTimer = null;
  let relayLastActivity = 0;

  async function applyRelayDecisions(decisions) {
    for (const decision of Array.isArray(decisions) ? decisions : []) {
      const mod = decision && decision.mod;
      const status = String(decision && decision.status || "");
      if (!mod || !mod.modId || !RELAY_VALID_DECISIONS.has(status)) continue;
      const game = String(mod.game || "skyrimspecialedition").trim().toLocaleLowerCase();
      const payload = { ...mod, game };
      const key = Core.modDecisionStorageKey(payload);
      enqueuePersistence(key, status === "unreviewed"
        ? { status: "unreviewed", mod: payload }
        : { status: "reviewed", mod: { ...payload, status } });
    }
  }

  function armRelayPolling() {
    relayLastActivity = Date.now();
    if (relayPollTimer) return;
    const tick = async () => {
      relayPollTimer = null;
      if (Date.now() - relayLastActivity > RELAY_IDLE_CUTOFF_MS) return;
      try {
        const response = await fetch(RELAY_BASE + "/decisions");
        if (response.ok) await applyRelayDecisions(await response.json());
      } catch (_error) {
        return; // relay went away; next successful page report re-arms
      }
      relayPollTimer = setTimeout(tick, RELAY_POLL_MS);
    };
    relayPollTimer = setTimeout(tick, 1000);
  }

  function reportVisiblePageToRelay(tiles) {
    if (relayReportTimer) clearTimeout(relayReportTimer);
    relayReportTimer = setTimeout(() => {
      relayReportTimer = null;
      const mods = [];
      for (const tile of tiles) {
        if (tile.classList.contains("nlc-hidden")) continue;
        const mod = Core.readModTile(tile);
        if (!mod) continue;
        const decision = Core.decisionFor(state, mod);
        mods.push({
          game: mod.game,
          modId: mod.modId,
          title: mod.title,
          sourceUrl: mod.sourceUrl,
          author: { username: mod.author.username, userId: mod.author.userId },
          decision: decision ? decision.status : ""
        });
      }
      if (!mods.length) return;
      const signature = location.href + "|" + mods.map(m => `${m.modId}:${m.decision}`).join(",");
      if (signature === lastRelayReportSignature) return;
      fetch(RELAY_BASE + "/page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: location.href, mods, reportedAt: new Date().toISOString() })
      }).then(response => {
        if (!response.ok) return;
        lastRelayReportSignature = signature;
        armRelayPolling();
      }).catch(() => {});
    }, 400);
  }

  function scheduleApply(delay = 60) {
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(() => {
      scheduled = null;
      apply();
    }, delay);
  }

  function modForAction(target) {
    const tile = target.closest(TILE_SELECTOR);
    return tile ? { tile, mod: Core.readModTile(tile) } : { tile: null, mod: null };
  }

  function hideTilesForAuthor(author) {
    if (isAuthorCataloguePage()) {
      scheduleApply(0);
      return;
    }
    const allTiles = Array.from(document.querySelectorAll(TILE_SELECTOR));
    const tiles = document.body.classList.contains("nlc-curated-active")
      ? allTiles.filter(candidate => candidate.hasAttribute("data-nlc-api-tile"))
      : allTiles.filter(candidate => !candidate.classList.contains("nlc-native-suppressed"));
    const userId = String(author && author.userId || "").trim();
    const username = String(author && author.username || "").trim().toLocaleLowerCase();
    for (const candidate of tiles) {
      const sameId = userId && candidate.dataset.nlcAuthorId === userId;
      const sameName = username && candidate.dataset.nlcAuthorName === username;
      if (sameId || sameName) candidate.classList.add("nlc-hidden");
    }
    const hidden = tiles.filter(candidate => candidate.classList.contains("nlc-hidden")).length;
    updatePageStatus(tiles.length, { totalHidden: hidden });
    updateInlineResultSummary(tiles.length, hidden);
    if (tiles.length && hidden === tiles.length) advanceStreamAfterExhaustion();
  }

  function trackingCentreAuthor(cell) {
    if (!cell) return { username: "", userId: "" };
    const link = cell.querySelector('a[href*="/profile/"], a[href*="/users/"]');
    routeAuthorLinkToMods(link);
    let username = String(link && link.textContent || cell.textContent || "").replace(/\s+/g, " ").trim();
    let userId = String(link && (link.dataset.userId || link.dataset.memberId) || "").trim();
    if (link) {
      try {
        const url = new URL(link.href, location.href);
        const profileMatch = url.pathname.match(/^\/profile\/([^/?#]+)/i);
        const userMatch = url.pathname.match(/^\/users\/(\d+)(?:\/|$)/i);
        if (profileMatch) username = decodeURIComponent(profileMatch[1]).trim();
        if (userMatch) userId = userMatch[1];
      } catch (_error) {
        // Visible author text remains a safe username fallback.
      }
    }
    return { username, userId };
  }

  function trackingCentreStatus(author) {
    if (isAuthorBlocked(author)) return { label: "Blocked", className: "nlc-tracking-blocked" };
    if (isAuthorReviewed(author)) return { label: "Hidden", className: "nlc-tracking-hidden" };
    if (author.username || author.userId) return { label: "Good", className: "nlc-tracking-good" };
    return { label: "Unknown", className: "nlc-tracking-unknown" };
  }

  function applyTrackingCentreStatus() {
    if (!/\/mods\/trackingcentre\/?$/i.test(location.pathname)) return;
    for (const table of document.querySelectorAll("table")) {
      const headerRow = table.querySelector("thead tr") ||
        Array.from(table.querySelectorAll("tr")).find(row => row.querySelector("th"));
      if (!headerRow) continue;
      const originalHeaders = Array.from(headerRow.children).filter(cell => !cell.hasAttribute("data-nlc-tracking-status"));
      const authorIndex = originalHeaders.findIndex(cell => /\b(author|uploader|uploaded by)\b/i.test(cell.textContent || ""));
      if (authorIndex < 0) continue;

      let statusHeader = headerRow.querySelector("[data-nlc-tracking-status]");
      if (!statusHeader) {
        statusHeader = document.createElement("th");
        statusHeader.scope = "col";
        statusHeader.textContent = "Local status";
        statusHeader.dataset.nlcTrackingStatus = "header";
        statusHeader.dataset.nlcOwned = "true";
        headerRow.appendChild(statusHeader);
      }

      const rows = table.tBodies.length
        ? Array.from(table.tBodies).flatMap(body => Array.from(body.rows))
        : Array.from(table.querySelectorAll("tr")).filter(row => row !== headerRow);
      for (const row of rows) {
        const originalCells = Array.from(row.children).filter(cell => !cell.hasAttribute("data-nlc-tracking-status"));
        if (!originalCells.length || !originalCells[authorIndex]) continue;
        const author = trackingCentreAuthor(originalCells[authorIndex]);
        const status = trackingCentreStatus(author);
        let statusCell = row.querySelector("[data-nlc-tracking-status]");
        if (!statusCell) {
          statusCell = document.createElement("td");
          statusCell.dataset.nlcTrackingStatus = "cell";
          statusCell.dataset.nlcOwned = "true";
          row.appendChild(statusCell);
        }
        let badge = statusCell.querySelector(".nlc-tracking-status");
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "nlc-tracking-status";
          statusCell.replaceChildren(badge);
        }
        badge.className = `nlc-tracking-status ${status.className}`;
        badge.textContent = status.label;
        badge.title = author.username
          ? `${author.username}: ${status.label} in Nexus Local Curator`
          : status.label;
      }
    }
  }

  document.addEventListener("click", async event => {
    const actionStartedAt = performance.now();
    const target = event.target.closest("[data-nlc-action]");
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const action = target.dataset.nlcAction;
    if (action === "open-options") {
      await sendRuntimeMessage({ type: "open-options" });
      return;
    }
    if (action === "toggle-hidden") {
      showHidden = !showHidden;
      currentSourceResponse = null;
      currentBatchNextCursor = null;
      loadedCuratedSignature = "";
      scheduleApply(0);
      scheduleCuratedCatalogue(0, true);
      return;
    }
    if (action === "toggle-blocked") {
      showBlocked = !showBlocked;
      currentSourceResponse = null;
      currentBatchNextCursor = null;
      loadedCuratedSignature = "";
      scheduleApply(0);
      scheduleCuratedCatalogue(0, true);
      return;
    }
    if (action === "toggle-skipped") {
      showSkipped = !showSkipped;
      currentSourceResponse = null;
      currentBatchNextCursor = null;
      loadedCuratedSignature = "";
      scheduleApply(0);
      scheduleCuratedCatalogue(0, true);
      return;
    }
    if (action === "curated-prev" && streamCursorHistory.length) {
      moveToStreamCursor(streamCursorHistory.pop(), false, false);
      return;
    }
    if (action === "curated-next" && currentBatchNextCursor) {
      moveToStreamCursor(currentBatchNextCursor, true);
      return;
    }
    if (action === "curated-newest") {
      startNewestStream();
      return;
    }
    if (action === "curated-resume") {
      resumeSavedBacklog();
      return;
    }
    if (action === "curated-refresh") {
      startNewestStream();
      return;
    }
    const { tile, mod } = modForAction(target);
    if (!mod) return;
    if (action === "block-author") {
      if (!mod.author.username && !mod.author.userId) return;
      target.disabled = true;
      if (!isAuthorCataloguePage()) tile.classList.add("nlc-hidden");
      const paintedAt = performance.now();
      const updateStartedAt = performance.now();
      const author = applyAuthorDecisionLocally("blocked", mod.author);
      hideTilesForAuthor(mod.author);
      enqueuePersistence(Core.authorDecisionStorageKey(author), { kind: "author", status: "blocked", author });
      reportActionPerformance(action, actionStartedAt, paintedAt, updateStartedAt);
    } else if (action === "review-author") {
      if (!mod.author.username && !mod.author.userId) return;
      target.disabled = true;
      if (!isAuthorCataloguePage()) tile.classList.add("nlc-hidden");
      const paintedAt = performance.now();
      const updateStartedAt = performance.now();
      const author = applyAuthorDecisionLocally("reviewed", mod.author);
      hideTilesForAuthor(mod.author);
      enqueuePersistence(Core.authorDecisionStorageKey(author), { kind: "author", status: "reviewed", author });
      reportActionPerformance(action, actionStartedAt, paintedAt, updateStartedAt);
    } else if (action === "unblock-author" || action === "unreview-author") {
      if (!mod.author.username && !mod.author.userId) return;
      target.disabled = true;
      const updateStartedAt = performance.now();
      const author = applyAuthorDecisionLocally("included", mod.author);
      enqueuePersistence(Core.authorDecisionStorageKey(author), { kind: "author", status: "included", author });
      scheduleApply(0);
      reportActionPerformance(action, actionStartedAt, updateStartedAt, updateStartedAt);
    } else if (action === "unkeep" || action === "untrim" || action === "unskip") {
      const updateStartedAt = performance.now();
      const next = Core.clearDecision(state, mod);
      saveState(next);
      enqueuePersistence(Core.modDecisionStorageKey(mod), { kind: "mod", status: "unreviewed", mod });
      reportActionPerformance(action, actionStartedAt, updateStartedAt, updateStartedAt);
    } else if (Core.VALID_STATUSES.has(action)) {
      const updateStartedAt = performance.now();
      const next = Core.setDecision(state, mod, action);
      saveState(next);
      const decision = Core.decisionFor(next, mod);
      enqueuePersistence(Core.modDecisionStorageKey(decision), { kind: "mod", mod: decision });
      reportActionPerformance(action, actionStartedAt, updateStartedAt, updateStartedAt);
    }
  }, true);

  function forceFilterRefresh() {
    if (curatedStatsTimer) clearTimeout(curatedStatsTimer);
    curatedStatsTimer = null;
    curatedStatsSequence += 1;
    curatedStatsReady = false;
    loadedCuratedSignature = "";
    desiredCuratedSignature = "";
    scheduleApply();
    scheduleCuratedCatalogue(50, true);
  }

  document.addEventListener("click", event => {
    if (!event.target.closest('[data-e2eid="category-filter"], [data-e2eid="language-support-filter"]')) return;
    setTimeout(forceFilterRefresh, 0);
  });

  window.addEventListener("popstate", forceFilterRefresh);
  setInterval(() => {
    if (location.href === observedLocation) return;
    observedLocation = location.href;
    forceFilterRefresh();
  }, 250);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const journalChanges = Object.entries(changes).filter(([key]) =>
      key.startsWith(Core.AUTHOR_DECISION_PREFIX) || key.startsWith(Core.MOD_DECISION_PREFIX)
    );
    if (journalChanges.length) {
      if (journalChanges.every(([, change]) => change.newValue && change.newValue.sourceId === localSourceId)) return;
      loadState().catch(console.error);
      return;
    }
    const stateKeys = ["schemaVersion", "blockedAuthors", "reviewedAuthors", "modDecisions", "settings", "blockedMods", "nexusApiKey"];
    if (stateKeys.some(key => Object.prototype.hasOwnProperty.call(changes, key))) loadState().catch(console.error);
  });

  const observer = new MutationObserver(mutations => {
    if (mutations.some(mutation => Array.from(mutation.addedNodes).some(node =>
      node.nodeType === Node.ELEMENT_NODE && !node.closest?.("[data-nlc-owned]")
    ))) scheduleApply();
  });

  loadState().then(() => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    apply();
  }).catch(console.error);
})();
