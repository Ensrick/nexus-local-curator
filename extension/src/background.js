"use strict";

const ApiCore = globalThis.NexusCuratorApiCore;
const API_URL = "https://api.nexusmods.com";
const GRAPHQL_URL = `${API_URL}/v2/graphql`;
const API_PROTOCOL_VERSION = "1.7.1";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_STREAM_SOURCE_PAGES = 50;
const MAX_STREAM_SCAN_MS = 120000;
const APP_VERSION = browser.runtime.getManifest().version;
const AUTHOR_DECISION_PREFIX = "nlcAuthorDecision:";
const MOD_DECISION_PREFIX = "nlcModDecision:";
let pendingLocalPersistence = new Map();
let pendingLocalPersistenceWaiters = [];
let localPersistenceTimer = null;
let cursorPersistenceTail = Promise.resolve();
let performanceDiagnostics = [];
let performanceDiagnosticsTimer = null;
const activeBatchJobs = new Map();
let batchJobSequence = 0;
let pendingManageOperations = [];
let managePersistenceTimer = null;
let managePersistenceInFlight = false;
const MODS_QUERY = `query mods(
  $viewUploaderHidden: Boolean,
  $viewUserBlockedContent: Boolean,
  $facets: ModsFacet,
  $filter: ModsFilter,
  $sort: [ModsSort!],
  $offset: Int,
  $count: Int
) {
  mods(
    viewUploaderHidden: $viewUploaderHidden,
    viewUserBlockedContent: $viewUserBlockedContent,
    facets: $facets,
    filter: $filter,
    sort: $sort,
    offset: $offset,
    count: $count
  ) {
    nodes {
      modId
      name
      summary
      category
      author
      downloads
      endorsements
      createdAt
      updatedAt
      thumbnailUrl
      uploader { memberId name }
      game { domainName }
    }
    nodesCount
    totalCount
  }
}`;
function statsQuery(languageCount) {
  const facetVariables = Array.from({ length: languageCount }, (_, index) => `$languageFacet${index}: ModsFacet`).join(",\n  ");
  const languageFields = Array.from({ length: languageCount }, (_, index) => `
  language${index}: mods(
    viewUploaderHidden: $viewUploaderHidden,
    viewUserBlockedContent: $viewUserBlockedContent,
    facets: $languageFacet${index},
    filter: $filter,
    count: 1
  ) { totalCount }`).join("");
  return `query filterStats(
  $viewUploaderHidden: Boolean,
  $viewUserBlockedContent: Boolean,
  $facets: ModsFacet,
  $filter: ModsFilter,
  $excludedOnlyFilter: ModsFilter,
  $baseFilter: ModsFilter${facetVariables ? `,\n  ${facetVariables}` : ""}
) {
  visible: mods(
    viewUploaderHidden: $viewUploaderHidden,
    viewUserBlockedContent: $viewUserBlockedContent,
    facets: $facets,
    filter: $filter,
    count: 1
  ) { totalCount }
  afterExcluded: mods(
    viewUploaderHidden: $viewUploaderHidden,
    viewUserBlockedContent: $viewUserBlockedContent,
    facets: $facets,
    filter: $excludedOnlyFilter,
    count: 1
  ) { totalCount }
  beforeAuthorFilters: mods(
    viewUploaderHidden: $viewUploaderHidden,
    viewUserBlockedContent: $viewUserBlockedContent,
    facets: $facets,
    filter: $baseFilter,
    count: 1
  ) { totalCount }${languageFields}
}`;
}

function languageCountsQuery(languageCount) {
  const facetVariables = Array.from({ length: languageCount }, (_, index) => `$languageFacet${index}: ModsFacet`).join(",\n  ");
  const fields = Array.from({ length: languageCount }, (_, index) => `
  language${index}: mods(
    viewUploaderHidden: $viewUploaderHidden,
    viewUserBlockedContent: $viewUserBlockedContent,
    facets: $languageFacet${index},
    filter: $filter,
    count: 1
  ) { totalCount }`).join("");
  return `query languageCounts(
  $viewUploaderHidden: Boolean,
  $viewUserBlockedContent: Boolean,
  $filter: ModsFilter${facetVariables ? `,\n  ${facetVariables}` : ""}
) {${fields}
}`;
}

function apiHeaders(apiKey) {
  return {
    apikey: apiKey,
    "Application-Name": "Nexus Local Curator",
    "Application-Version": APP_VERSION,
    "Protocol-Version": API_PROTOCOL_VERSION,
    "Content-Type": "application/json"
  };
}

async function timedFetch(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error(`Nexus did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readApiKey() {
  const stored = await browser.storage.local.get("nexusApiKey");
  return String(stored.nexusApiKey || "").trim();
}

async function validateApiKey(value) {
  const apiKey = String(value || "").trim();
  if (!apiKey) return { ok: false, error: "No API key was provided." };
  const response = await fetch(`${API_URL}/v1/users/validate.json`, { headers: apiHeaders(apiKey) });
  if (!response.ok) return { ok: false, status: response.status, error: `Nexus rejected the API key (${response.status}).` };
  return {
    ok: true,
    limits: {
      dailyRemaining: response.headers.get("x-rl-daily-remaining"),
      hourlyRemaining: response.headers.get("x-rl-hourly-remaining")
    }
  };
}

async function fetchCuratedMods(request, apiKeyOverride) {
  const startedAt = performance.now();
  const apiKey = apiKeyOverride || await readApiKey();
  if (!apiKey) return { ok: false, error: "Import your Nexus API key in Manage first." };
  const built = request && request.mode === "stream"
    ? ApiCore.buildStreamVariables(request)
    : ApiCore.buildModsVariables(request);
  const variables = {
    viewUploaderHidden: built.viewUploaderHidden,
    viewUserBlockedContent: built.viewUserBlockedContent,
    facets: built.facets,
    filter: built.filter,
    sort: built.sort,
    offset: built.offset,
    count: built.count
  };
  const body = JSON.stringify({ query: MODS_QUERY, variables });
  let response;
  try {
    response = await timedFetch(GRAPHQL_URL, {
      method: "POST",
      headers: apiHeaders(apiKey),
      body
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error.message || "Network error.",
      diagnostics: {
        durationMs: Math.round(performance.now() - startedAt),
        requestBytes: body.length,
        failureType: /within \d+ seconds/i.test(error.message || "") ? "timeout" : "network"
      }
    };
  }
  const diagnostics = {
    durationMs: Math.round(performance.now() - startedAt),
    requestBytes: body.length,
    status: response.status,
    hourlyRemaining: response.headers.get("x-rl-hourly-remaining"),
    dailyRemaining: response.headers.get("x-rl-daily-remaining")
  };
  if (response.status === 429) return { ok: false, status: 429, diagnostics, error: "Nexus rate-limited this request. Wait for the API allowance to reset, then try again." };
  if (!response.ok) return { ok: false, status: response.status, diagnostics, error: `Nexus API request failed (${response.status}).` };
  const payload = await response.json();
  diagnostics.durationMs = Math.round(performance.now() - startedAt);
  if (payload.errors && payload.errors.length) return { ok: false, diagnostics, error: payload.errors[0].message || "Nexus returned a GraphQL error." };
  const page = payload.data && payload.data.mods;
  if (!page) return { ok: false, diagnostics, error: "Nexus returned no mod catalogue data." };
  const visibleTotal = Number(page.totalCount || page.nodesCount || 0);
  return {
    ok: true,
    nodes: Array.isArray(page.nodes) ? page.nodes : [],
    totalCount: visibleTotal,
    diagnostics
  };
}

function createBackgroundAuthorIndex(authors) {
  const index = { userIds: new Set(), usernames: new Set() };
  for (const author of Array.isArray(authors) ? authors : []) {
    const userId = String(author && author.userId || "").trim();
    const username = String(author && author.username || "").trim().toLocaleLowerCase();
    if (userId) index.userIds.add(userId);
    if (username) index.usernames.add(username);
  }
  return index;
}

function backgroundAuthorIndexHas(index, author) {
  const userId = String(author && author.userId || "").trim();
  const username = String(author && author.username || "").trim().toLocaleLowerCase();
  return Boolean((userId && index.userIds.has(userId)) || (username && index.usernames.has(username)));
}

function combineLocalStorageSnapshot(stored) {
  return { ...stored, ...Object.fromEntries(pendingLocalPersistence) };
}

async function readLocalFilterSnapshot() {
  const stored = combineLocalStorageSnapshot(await browser.storage.local.get(null));
  const journalBlocked = [];
  const journalReviewed = [];
  const journalIncluded = [];
  const journalModStatuses = new Map();
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith(AUTHOR_DECISION_PREFIX) && value && value.author) {
      if (value.status === "reviewed") journalReviewed.push(value.author);
      else if (value.status === "included") journalIncluded.push(value.author);
      else journalBlocked.push(value.author);
    } else if (key.startsWith(MOD_DECISION_PREFIX) && value && value.mod) {
      const mod = value.mod;
      const modKey = `${String(mod.game || "unknown").trim().toLocaleLowerCase()}:${String(mod.modId || "").trim()}`;
      const status = value.status === "unreviewed" ? "unreviewed" : String(mod.status || "reviewed");
      journalModStatuses.set(modKey, status);
    }
  }

  const journalBlockedIndex = createBackgroundAuthorIndex(journalBlocked);
  const journalReviewedIndex = createBackgroundAuthorIndex(journalReviewed);
  const journalIncludedIndex = createBackgroundAuthorIndex(journalIncluded);
  const blockedAuthors = [
    ...(Array.isArray(stored.blockedAuthors) ? stored.blockedAuthors : []).filter(author =>
      !backgroundAuthorIndexHas(journalReviewedIndex, author) && !backgroundAuthorIndexHas(journalIncludedIndex, author)
    ),
    ...journalBlocked
  ].filter(author => !backgroundAuthorIndexHas(journalIncludedIndex, author));
  const blockedIndex = createBackgroundAuthorIndex(blockedAuthors);
  const reviewedAuthors = [
    ...(Array.isArray(stored.reviewedAuthors) ? stored.reviewedAuthors : []).filter(author =>
      !backgroundAuthorIndexHas(journalBlockedIndex, author) && !backgroundAuthorIndexHas(journalIncludedIndex, author)
    ),
    ...journalReviewed
  ].filter(author =>
    !backgroundAuthorIndexHas(blockedIndex, author) && !backgroundAuthorIndexHas(journalIncludedIndex, author)
  );
  const reviewedIndex = createBackgroundAuthorIndex(reviewedAuthors);
  const modStatuses = new Map();
  for (const mod of Array.isArray(stored.modDecisions) ? stored.modDecisions : []) {
    const key = `${String(mod.game || "unknown").trim().toLocaleLowerCase()}:${String(mod.modId || "").trim()}`;
    modStatuses.set(key, String(mod.status || "reviewed"));
  }
  for (const [key, status] of journalModStatuses) {
    if (status === "unreviewed") modStatuses.delete(key);
    else modStatuses.set(key, status);
  }
  return { blockedIndex, reviewedIndex, modStatuses };
}

function backgroundModStatus(snapshot, mod) {
  const exact = `${String(mod.game || "unknown").trim().toLocaleLowerCase()}:${String(mod.modId || "").trim()}`;
  const unknown = `unknown:${String(mod.modId || "").trim()}`;
  return snapshot.modStatuses.get(exact) || snapshot.modStatuses.get(unknown) || "";
}

function batchJobKey(sender) {
  if (sender && sender.tab && Number.isInteger(sender.tab.id)) return `tab:${sender.tab.id}`;
  return `document:${String(sender && (sender.documentId || sender.url) || "unknown")}`;
}

async function fetchCuratedBatch(request, sender) {
  const apiKey = await readApiKey();
  if (!apiKey) return { ok: false, error: "Import your Nexus API key in Manage first." };
  const filterSnapshot = await readLocalFilterSnapshot();
  const cursor = request && request.cursor && typeof request.cursor === "object" ? request.cursor : {};
  const batchNumber = Math.max(1, Number.parseInt(cursor.batch, 10) || 1);
  let sourcePage = Math.max(1, Number.parseInt(cursor.page, 10) || 1);
  let sourceIndex = Math.max(0, Number.parseInt(cursor.index, 10) || 0);
  const startPage = sourcePage;
  const collected = [];
  let lastResponse = null;
  let pageCount = 0;
  let scannedSourcePages = 0;
  const scanStartedAt = performance.now();
  const jobKey = batchJobKey(sender);
  const jobToken = ++batchJobSequence;
  activeBatchJobs.set(jobKey, jobToken);

  try {
    while (true) {
      if (activeBatchJobs.get(jobKey) !== jobToken) return { ok: false, cancelled: true, error: "Catalogue scan was replaced." };
      const response = await fetchCuratedMods({ ...request, mode: "stream", page: sourcePage }, apiKey);
      if (!response || !response.ok) return response || { ok: false, error: "Nexus returned no catalogue data." };
      lastResponse = response;
      scannedSourcePages += 1;
      pageCount = response.totalCount ? Math.ceil(Number(response.totalCount) / ApiCore.API_BATCH_SIZE) : 0;
      if (pageCount && sourcePage > pageCount) {
        sourcePage = pageCount;
        sourceIndex = 0;
        continue;
      }

      const sourceNodes = Array.isArray(response.nodes) ? response.nodes.slice(0, ApiCore.API_BATCH_SIZE) : [];
      let index = Math.min(sourceIndex, sourceNodes.length);
      for (; index < sourceNodes.length; index += 1) {
        const node = sourceNodes[index];
        const mod = ApiCore.normaliseApiMod(node, request.gameDomainName);
        const blocked = backgroundAuthorIndexHas(filterSnapshot.blockedIndex, mod.author);
        const reviewed = backgroundAuthorIndexHas(filterSnapshot.reviewedIndex, mod.author);
        const modStatus = backgroundModStatus(filterSnapshot, mod);
        const modVisible = !modStatus || (request.showSkipped && modStatus === "skip");
        if ((request.showBlocked || !blocked) && (request.showHidden || !reviewed) && modVisible) {
          collected.push(node);
        }
      }

      if (collected.length) {
        const nextCursor = sourcePage < pageCount
          ? { page: sourcePage + 1, index: 0, batch: batchNumber + 1 }
          : null;
        return {
          ...lastResponse,
          nodes: collected,
          streamStartPage: startPage,
          streamEndPage: sourcePage,
          nextCursor
        };
      }
      if (!pageCount || sourcePage >= pageCount) {
        return {
          ...lastResponse,
          nodes: collected,
          streamStartPage: startPage,
          streamEndPage: sourcePage,
          nextCursor: null
        };
      }
      const nextPage = sourcePage + 1;
      if (scannedSourcePages >= MAX_STREAM_SOURCE_PAGES || performance.now() - scanStartedAt >= MAX_STREAM_SCAN_MS) {
        return {
          ...lastResponse,
          nodes: [],
          streamStartPage: startPage,
          streamEndPage: sourcePage,
          scannedSourcePages,
          scanPaused: true,
          nextCursor: { page: nextPage, index: 0, batch: batchNumber + 1 }
        };
      }
      sourcePage = nextPage;
      sourceIndex = 0;
    }
  } finally {
    if (activeBatchJobs.get(jobKey) === jobToken) activeBatchJobs.delete(jobKey);
  }
}

async function fetchFilterStats(request) {
  const apiKey = await readApiKey();
  if (!apiKey) return { ok: false, error: "Import your Nexus API key in Manage first." };
  const built = ApiCore.buildModsVariables(request);
  const languageNames = Array.from(new Set((Array.isArray(request && request.languageFacetNames) ? request.languageFacetNames : [])
    .map(value => String(value || "").trim())
    .filter(Boolean))).slice(0, 32);
  const variables = {
    viewUploaderHidden: built.viewUploaderHidden,
    viewUserBlockedContent: built.viewUserBlockedContent,
    facets: built.facets,
    filter: built.filter,
    excludedOnlyFilter: built.excludedOnlyFilter,
    baseFilter: built.baseFilter
  };
  languageNames.forEach((name, index) => {
    variables[`languageFacet${index}`] = {
      languageName: [name],
      categoryName: built.facets.categoryName
    };
  });
  const response = await timedFetch(GRAPHQL_URL, {
    method: "POST",
    headers: apiHeaders(apiKey),
    body: JSON.stringify({ query: statsQuery(languageNames.length), variables })
  }, 60000);
  if (!response.ok) return { ok: false, status: response.status, error: `Nexus statistics request failed (${response.status}).` };
  const payload = await response.json();
  if (payload.errors && payload.errors.length) return { ok: false, error: payload.errors[0].message || "Nexus returned a statistics error." };
  const visible = Number(payload.data && payload.data.visible && payload.data.visible.totalCount || 0);
  const afterExcluded = Number(payload.data && payload.data.afterExcluded && payload.data.afterExcluded.totalCount || visible);
  const beforeAuthorFilters = Number(payload.data && payload.data.beforeAuthorFilters && payload.data.beforeAuthorFilters.totalCount || afterExcluded);
  const languageCounts = {};
  languageNames.forEach((name, index) => {
    languageCounts[name] = Number(payload.data && payload.data[`language${index}`] && payload.data[`language${index}`].totalCount || 0);
  });
  return {
    ok: true,
    hiddenModCount: Math.max(0, afterExcluded - visible),
    excludedModCount: Math.max(0, beforeAuthorFilters - afterExcluded),
    languageCounts
  };
}

async function fetchLanguageCounts(request) {
  const apiKey = await readApiKey();
  if (!apiKey) return { ok: false, error: "Import your Nexus API key in Manage first." };
  const languageNames = Array.from(new Set((Array.isArray(request && request.languageFacetNames) ? request.languageFacetNames : [])
    .map(value => String(value || "").trim())
    .filter(Boolean))).slice(0, 8);
  if (!languageNames.length) return { ok: true, languageCounts: {} };
  const built = ApiCore.buildModsVariables(request);
  const variables = {
    viewUploaderHidden: built.viewUploaderHidden,
    viewUserBlockedContent: built.viewUserBlockedContent,
    filter: built.filter
  };
  languageNames.forEach((name, index) => {
    variables[`languageFacet${index}`] = {
      languageName: [name],
      categoryName: built.facets.categoryName
    };
  });
  const response = await timedFetch(GRAPHQL_URL, {
    method: "POST",
    headers: apiHeaders(apiKey),
    body: JSON.stringify({ query: languageCountsQuery(languageNames.length), variables })
  }, 60000);
  if (!response.ok) return { ok: false, status: response.status, error: `Nexus language-count request failed (${response.status}).` };
  const payload = await response.json();
  if (payload.errors && payload.errors.length) return { ok: false, error: payload.errors[0].message || "Nexus returned a language-count error." };
  const languageCounts = {};
  languageNames.forEach((name, index) => {
    languageCounts[name] = Number(payload.data && payload.data[`language${index}`] && payload.data[`language${index}`].totalCount || 0);
  });
  return { ok: true, languageCounts };
}

async function fetchCategoryCounts(request) {
  const apiKey = await readApiKey();
  if (!apiKey) return { ok: false, error: "Import your Nexus API key in Manage first." };
  const categoryNames = Array.from(new Set((Array.isArray(request && request.categoryFacetNames) ? request.categoryFacetNames : [])
    .map(value => String(value || "").trim())
    .filter(Boolean))).slice(0, 8);
  if (!categoryNames.length) return { ok: true, categoryCounts: {} };
  const built = ApiCore.buildModsVariables(request);
  const variables = {
    viewUploaderHidden: built.viewUploaderHidden,
    viewUserBlockedContent: built.viewUserBlockedContent,
    filter: built.filter
  };
  categoryNames.forEach((name, index) => {
    variables[`languageFacet${index}`] = {
      languageName: built.facets.languageName,
      categoryName: [name]
    };
  });
  const response = await timedFetch(GRAPHQL_URL, {
    method: "POST",
    headers: apiHeaders(apiKey),
    body: JSON.stringify({ query: languageCountsQuery(categoryNames.length), variables })
  }, 30000);
  if (!response.ok) return { ok: false, status: response.status, error: `Nexus category-count request failed (${response.status}).` };
  const payload = await response.json();
  if (payload.errors && payload.errors.length) return { ok: false, error: payload.errors[0].message || "Nexus returned a category-count error." };
  const categoryCounts = {};
  categoryNames.forEach((name, index) => {
    categoryCounts[name] = Number(payload.data && payload.data[`language${index}`] && payload.data[`language${index}`].totalCount || 0);
  });
  return { ok: true, categoryCounts };
}

function openCatalog() {
  return browser.tabs.create({ url: browser.runtime.getURL("src/catalog.html") });
}

function recordPerformanceDiagnostic(value) {
  const input = value && typeof value === "object" ? value : {};
  const safe = {
    capturedAt: new Date().toISOString(),
    phase: String(input.phase || "unknown").slice(0, 40),
    action: String(input.action || "").slice(0, 24),
    durationMs: Math.max(0, Math.round(Number(input.durationMs) || 0)),
    clickToPaintMs: Math.max(0, Math.round(Number(input.clickToPaintMs) || 0)),
    stateUpdateMs: Math.max(0, Math.round(Number(input.stateUpdateMs) || 0)),
    tileCount: Math.max(0, Math.round(Number(input.tileCount) || 0))
  };
  performanceDiagnostics.push(safe);
  performanceDiagnostics = performanceDiagnostics.slice(-20);
  if (performanceDiagnosticsTimer) clearTimeout(performanceDiagnosticsTimer);
  performanceDiagnosticsTimer = setTimeout(() => {
    performanceDiagnosticsTimer = null;
    browser.storage.local.set({ performanceDiagnostics }).catch(() => {});
  }, 1000);
  return { ok: true };
}

function persistLocalDelta(message) {
  const key = String(message && message.key || "");
  const value = message && message.value;
  const validPrefix = key.startsWith(AUTHOR_DECISION_PREFIX) || key.startsWith(MOD_DECISION_PREFIX);
  if (!validPrefix || key.length > 512 || !value || typeof value !== "object") {
    return Promise.resolve({ ok: false, error: "Invalid local decision." });
  }
  const safeValue = key.startsWith(AUTHOR_DECISION_PREFIX)
    ? {
        kind: "author",
        status: value.status === "reviewed" ? "reviewed" : (value.status === "included" ? "included" : "blocked"),
        author: {
          username: String(value.author && value.author.username || ""),
          userId: String(value.author && value.author.userId || ""),
          addedAt: String(value.author && value.author.addedAt || new Date().toISOString()),
          sourceUrl: String(value.author && value.author.sourceUrl || "")
        },
        sourceId: String(value.sourceId || "")
      }
    : {
        kind: "mod",
        status: value.status === "unreviewed" ? "unreviewed" : "reviewed",
        mod: value.mod,
        sourceId: String(value.sourceId || "")
      };
  pendingLocalPersistence.set(key, safeValue);
  const result = new Promise(resolve => pendingLocalPersistenceWaiters.push(resolve));
  if (!localPersistenceTimer) localPersistenceTimer = setTimeout(flushLocalPersistence, 1000);
  return result;
}

async function flushLocalPersistence() {
  localPersistenceTimer = null;
  const entries = pendingLocalPersistence;
  const waiters = pendingLocalPersistenceWaiters;
  pendingLocalPersistence = new Map();
  pendingLocalPersistenceWaiters = [];
  const queuedAt = performance.now();
  try {
    await browser.storage.local.set(Object.fromEntries(entries));
    const durationMs = performance.now() - queuedAt;
    if (durationMs >= 25) recordPerformanceDiagnostic({ phase: "background-storage", durationMs });
    waiters.forEach(resolve => resolve({ ok: true }));
  } catch (error) {
    for (const [key, value] of entries) {
      if (!pendingLocalPersistence.has(key)) pendingLocalPersistence.set(key, value);
    }
    pendingLocalPersistenceWaiters.push(...waiters);
    if (!localPersistenceTimer) localPersistenceTimer = setTimeout(flushLocalPersistence, 2000);
    console.error("Nexus Local Curator could not flush its local decision queue", error);
  }
}

function persistStreamCursor(message) {
  const context = String(message && message.context || "");
  const input = message && message.cursor && typeof message.cursor === "object"
    ? message.cursor
    : { page: message && message.page };
  const cursor = {
    page: Math.max(1, Number.parseInt(input.page, 10) || 1),
    index: Math.max(0, Number.parseInt(input.index, 10) || 0),
    batch: Math.max(1, Number.parseInt(input.batch, 10) || 1),
    history: (Array.isArray(input.history) ? input.history : []).slice(-20).map(item => ({
      page: Math.max(1, Number.parseInt(item && item.page, 10) || 1),
      index: Math.max(0, Number.parseInt(item && item.index, 10) || 0),
      batch: Math.max(1, Number.parseInt(item && item.batch, 10) || 1)
    }))
  };
  if (!context || context.length > 4096) return Promise.resolve({ ok: false, error: "Invalid review-stream cursor." });
  const write = async () => {
    const stored = await browser.storage.local.get("streamCursors");
    const cursors = stored.streamCursors && typeof stored.streamCursors === "object" ? stored.streamCursors : {};
    await browser.storage.local.set({ streamCursors: { ...cursors, [context]: cursor } });
  };
  cursorPersistenceTail = cursorPersistenceTail.catch(() => {}).then(write);
  return cursorPersistenceTail.then(() => ({ ok: true }), error => ({ ok: false, error: error.message }));
}

function authorEntryKey(author) {
  const userId = String(author && author.userId || "").trim();
  if (userId) return `id:${userId}`;
  return `name:${String(author && author.username || "").trim().toLocaleLowerCase()}`;
}

function modEntryKey(mod) {
  if (mod && mod.key) return String(mod.key);
  return `${String(mod && mod.game || "unknown").trim().toLocaleLowerCase()}:${String(mod && mod.modId || "").trim()}`;
}

function manageEntryKey(type, entry) {
  return type === "mod" ? modEntryKey(entry) : authorEntryKey(entry);
}

function queueManageOperation(message) {
  const type = String(message && message.entryType || "");
  const operation = String(message && message.operation || "");
  const entry = message && message.entry;
  if (!["author", "reviewed-author", "mod"].includes(type) || !["remove", "restore"].includes(operation) || !entry || typeof entry !== "object") {
    return { ok: false, error: "Invalid Manage operation." };
  }
  const key = manageEntryKey(type, entry);
  if (!key || key.endsWith(":")) return { ok: false, error: "Invalid saved entry." };
  pendingManageOperations.push({ type, operation, entry, key });
  if (!managePersistenceTimer && !managePersistenceInFlight) managePersistenceTimer = setTimeout(flushManageOperations, 250);
  return { ok: true, queued: true };
}

async function flushManageOperations() {
  managePersistenceTimer = null;
  managePersistenceInFlight = true;
  const operations = pendingManageOperations;
  pendingManageOperations = [];
  if (!operations.length) {
    managePersistenceInFlight = false;
    return;
  }
  try {
    const stored = await browser.storage.local.get(["blockedAuthors", "reviewedAuthors", "modDecisions"]);
    const lists = {
      author: Array.isArray(stored.blockedAuthors) ? stored.blockedAuthors : [],
      "reviewed-author": Array.isArray(stored.reviewedAuthors) ? stored.reviewedAuthors : [],
      mod: Array.isArray(stored.modDecisions) ? stored.modDecisions : []
    };
    const changed = new Set();
    let recoveryEntry = null;
    for (const item of operations) {
      const list = lists[item.type];
      const index = list.findIndex(entry => manageEntryKey(item.type, entry) === item.key);
      if (item.operation === "remove" && index >= 0) list.splice(index, 1);
      if (item.operation === "restore" && index < 0) list.push(item.entry);
      changed.add(item.type);
      recoveryEntry = {
        createdAt: new Date().toISOString(),
        entryType: item.type,
        operation: item.operation === "remove" ? "restore" : "remove",
        entry: item.entry
      };
    }
    const update = { recoveryEntry };
    if (changed.has("author")) update.blockedAuthors = lists.author;
    if (changed.has("reviewed-author")) update.reviewedAuthors = lists["reviewed-author"];
    if (changed.has("mod")) update.modDecisions = lists.mod;
    await browser.storage.local.set(update);
  } catch (error) {
    pendingManageOperations = [...operations, ...pendingManageOperations];
    console.error("Nexus Local Curator could not save Manage removals", error);
  } finally {
    managePersistenceInFlight = false;
    if (pendingManageOperations.length && !managePersistenceTimer) {
      managePersistenceTimer = setTimeout(flushManageOperations, 250);
    }
  }
}

// --- Curation relay: local assistant bridge (127.0.0.1 only) ---------------
// A page report arms decision polling; polling disarms after 30 idle minutes
// so no timer survives outside an active curation session.
const RELAY_BASE = "http://127.0.0.1:38492";
const RELAY_POLL_MS = 3000;
const RELAY_IDLE_CUTOFF_MS = 30 * 60 * 1000;
const RELAY_VALID_DECISIONS = new Set(["keep", "trim", "skip", "unreviewed"]);
let relayBackoffUntil = 0;
let relayPollTimer = null;
let relayLastActivity = 0;

async function relayFetch(path, options) {
  if (Date.now() < relayBackoffUntil) return null;
  try {
    const response = await fetch(RELAY_BASE + path, options);
    return response.ok ? response : null;
  } catch (_error) {
    relayBackoffUntil = Date.now() + 15000;
    return null;
  }
}

async function pollRelayDecisions() {
  const response = await relayFetch("/decisions", { method: "GET" });
  if (!response) return;
  let decisions;
  try { decisions = await response.json(); } catch (_error) { return; }
  if (!Array.isArray(decisions)) return;
  for (const decision of decisions) {
    const mod = decision && decision.mod;
    const status = String(decision && decision.status || "");
    if (!mod || !mod.modId || !RELAY_VALID_DECISIONS.has(status)) continue;
    const game = String(mod.game || "skyrimspecialedition").trim().toLocaleLowerCase();
    const key = "nlcModDecision:" + encodeURIComponent(`${game}:${String(mod.modId).trim()}`);
    const payload = { ...mod, game };
    await persistLocalDelta({
      key,
      value: status === "unreviewed"
        ? { status: "unreviewed", mod: payload, sourceId: "curation-relay" }
        : { status: "reviewed", mod: { ...payload, status }, sourceId: "curation-relay" }
    });
  }
}

function armRelayPolling() {
  relayLastActivity = Date.now();
  if (relayPollTimer) return;
  const tick = async () => {
    relayPollTimer = null;
    if (Date.now() - relayLastActivity > RELAY_IDLE_CUTOFF_MS) return;
    try { await pollRelayDecisions(); } catch (_error) {}
    relayPollTimer = setTimeout(tick, RELAY_POLL_MS);
  };
  relayPollTimer = setTimeout(tick, 500);
}

function reportPageToRelay(message) {
  armRelayPolling();
  return relayFetch("/page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: String(message.url || ""),
      mods: Array.isArray(message.mods) ? message.mods : [],
      reportedAt: new Date().toISOString()
    })
  }).then(response => ({ ok: Boolean(response) }));
}

function handleRuntimeMessage(message, sender) {
  if (message && message.type === "open-options") return browser.runtime.openOptionsPage();
  if (message && message.type === "relay-page-report") return reportPageToRelay(message);
  if (message && message.type === "open-catalog") return openCatalog();
  if (message && message.type === "persist-local-delta") return persistLocalDelta(message);
  if (message && message.type === "persist-stream-cursor") return persistStreamCursor(message);
  if (message && message.type === "persist-manage-operation") return queueManageOperation(message);
  if (message && message.type === "record-performance-diagnostic") return recordPerformanceDiagnostic(message.value);
  if (message && message.type === "nexus-api-validate-key") return validateApiKey(message.apiKey);
  if (message && message.type === "nexus-api-batch") return fetchCuratedBatch(message.request, sender);
  if (message && message.type === "nexus-api-mods") return fetchCuratedMods(message.request);
  if (message && message.type === "nexus-api-filter-stats") return fetchFilterStats(message.request);
  if (message && message.type === "nexus-api-language-counts") return fetchLanguageCounts(message.request);
  if (message && message.type === "nexus-api-category-counts") return fetchCategoryCounts(message.request);
  return undefined;
}

// Register the core message listener first so an unrelated optional event hook
// can never leave extension pages without a receiving background handler.
browser.runtime.onMessage.addListener(handleRuntimeMessage);
browser.action.onClicked.addListener(openCatalog);

if (browser.tabs && browser.tabs.onRemoved) {
  browser.tabs.onRemoved.addListener(tabId => {
    activeBatchJobs.delete(`tab:${tabId}`);
  });
}
