(function initialiseNexusCuratorCore(root) {
  "use strict";

  const SCHEMA_VERSION = 4;
  const VALID_STATUSES = new Set(["keep", "maybe", "skip"]);
  const AUTHOR_DECISION_PREFIX = "nlcAuthorDecision:";
  const MOD_DECISION_PREFIX = "nlcModDecision:";

  function normaliseUsername(value) {
    return String(value || "").trim().toLocaleLowerCase();
  }

  function cleanUsername(value) {
    return String(value || "").trim();
  }

  function authorKey(author) {
    if (author && author.userId) return `id:${String(author.userId).trim()}`;
    return `name:${normaliseUsername(author && author.username)}`;
  }

  function createAuthorIndex(authors) {
    const userIds = new Set();
    const usernames = new Set();
    for (const author of Array.isArray(authors) ? authors : []) {
      const userId = String(author && author.userId || "").trim();
      const username = normaliseUsername(author && author.username);
      if (userId) userIds.add(userId);
      if (username) usernames.add(username);
    }
    return { userIds, usernames };
  }

  function authorIndexHas(index, author) {
    const userId = String(author && author.userId || "").trim();
    const username = normaliseUsername(author && author.username);
    return Boolean((userId && index.userIds.has(userId)) || (username && index.usernames.has(username)));
  }

  function modKey(mod) {
    const game = String(mod && mod.game || "unknown").trim().toLocaleLowerCase();
    return `${game}:${String(mod && mod.modId || "").trim()}`;
  }

  function authorDecisionStorageKey(author) {
    return `${AUTHOR_DECISION_PREFIX}${encodeURIComponent(authorKey(author))}`;
  }

  function modDecisionStorageKey(mod) {
    return `${MOD_DECISION_PREFIX}${encodeURIComponent(modKey(mod))}`;
  }

  function parseModUrl(value, baseUrl) {
    try {
      const url = new URL(value, baseUrl || "https://www.nexusmods.com/");
      const match = url.pathname.match(/^\/([^/]+)\/mods\/(\d+)(?:\/|$)/i);
      if (!match) return null;
      return {
        game: decodeURIComponent(match[1]).toLocaleLowerCase(),
        modId: match[2],
        sourceUrl: url.href
      };
    } catch (_error) {
      return null;
    }
  }

  function userIdFromAvatar(value) {
    const match = String(value || "").match(/avatars\.nexusmods\.com\/(\d+)(?:\/|$)/i);
    return match ? match[1] : "";
  }

  function usernameFromProfileUrl(value) {
    try {
      const url = new URL(value, "https://www.nexusmods.com/");
      const match = url.pathname.match(/^\/profile\/([^/?#]+)/i);
      return match ? decodeURIComponent(match[1]).trim() : "";
    } catch (_error) {
      return "";
    }
  }

  function readModTile(tile) {
    if (!tile || typeof tile.querySelector !== "function") return null;
    const titleLink = tile.querySelector('a[data-e2eid="mod-tile-title"], a[href*="/mods/"]');
    const authorLink = tile.querySelector('a[data-e2eid="user-link"], a[href*="/profile/"]');
    if (!titleLink) return null;

    const parsed = parseModUrl(titleLink.href || titleLink.getAttribute("href"));
    if (!parsed) return null;

    const avatar = authorLink && authorLink.querySelector("img");
    const username = authorLink
      ? usernameFromProfileUrl(authorLink.href || authorLink.getAttribute("href")) || cleanUsername(authorLink.textContent)
      : "";

    return {
      key: modKey(parsed),
      game: parsed.game,
      modId: parsed.modId,
      title: cleanUsername(titleLink.textContent),
      sourceUrl: parsed.sourceUrl,
      author: {
        username,
        userId: String(authorLink && authorLink.dataset.nlcUserId || userIdFromAvatar(avatar && avatar.src)).trim(),
        profileUrl: authorLink ? authorLink.href : ""
      }
    };
  }

  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      blockedAuthors: [],
      reviewedAuthors: [],
      modDecisions: [],
      settings: {
        showPageStatus: true
      }
    };
  }

  function normaliseAuthor(value) {
    const input = typeof value === "string" ? { username: value } : (value || {});
    return {
      username: cleanUsername(input.username),
      userId: String(input.userId || "").trim(),
      addedAt: input.addedAt || new Date().toISOString(),
      sourceUrl: String(input.sourceUrl || "")
    };
  }

  function normaliseDecision(value) {
    const input = value || {};
    const status = VALID_STATUSES.has(input.status) ? input.status : "skip";
    const parsed = parseModUrl(input.sourceUrl || "") || {};
    const decision = {
      game: String(input.game || parsed.game || "unknown").trim().toLocaleLowerCase(),
      modId: String(input.modId || parsed.modId || "").trim(),
      title: cleanUsername(input.title),
      author: cleanUsername(input.author),
      status,
      addedAt: input.addedAt || new Date().toISOString(),
      sourceUrl: String(input.sourceUrl || parsed.sourceUrl || "")
    };
    decision.key = modKey(decision);
    return decision;
  }

  function dedupeBy(items, keyFunction) {
    const map = new Map();
    for (const item of items) {
      const key = keyFunction(item);
      if (key && !key.endsWith(":")) map.set(key, item);
    }
    return Array.from(map.values());
  }

  function normaliseState(input) {
    const source = input || {};
    const state = defaultState();
    state.blockedAuthors = dedupeBy(
      (Array.isArray(source.blockedAuthors) ? source.blockedAuthors : []).map(normaliseAuthor).filter(a => a.username || a.userId),
      authorKey
    );
    const blockedAuthorIndex = createAuthorIndex(state.blockedAuthors);
    state.reviewedAuthors = dedupeBy(
      (Array.isArray(source.reviewedAuthors) ? source.reviewedAuthors : []).map(normaliseAuthor).filter(a => a.username || a.userId),
      authorKey
    ).filter(author => !authorIndexHas(blockedAuthorIndex, author));

    const decisions = Array.isArray(source.modDecisions) ? source.modDecisions.map(normaliseDecision) : [];
    for (const oldValue of Array.isArray(source.blockedMods) ? source.blockedMods : []) {
      const parsed = parseModUrl(oldValue);
      if (parsed) decisions.push(normaliseDecision({ ...parsed, status: "skip" }));
      else if (/^\d+$/.test(String(oldValue).trim())) {
        decisions.push(normaliseDecision({ game: "unknown", modId: String(oldValue).trim(), status: "skip" }));
      }
    }
    state.modDecisions = dedupeBy(decisions.filter(d => d.modId), d => d.key);
    state.settings = {
      ...state.settings,
      ...(source.settings && typeof source.settings === "object" ? source.settings : {})
    };
    state.settings.showPageStatus = state.settings.showPageStatus !== false;
    delete state.settings.hideTrackedAuthors;
    delete state.settings.autoAdvanceEmptyPages;
    return state;
  }

  function stateFromStorage(input) {
    const source = input || {};
    const state = normaliseState(source);
    const journalBlocked = [];
    const journalReviewed = [];
    const journalIncluded = [];
    const journalMods = [];
    const journalUnreviewed = new Set();
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith(AUTHOR_DECISION_PREFIX) && value && value.author) {
        const author = normaliseAuthor(value.author);
        if (value.status === "blocked") journalBlocked.push(author);
        else if (value.status === "reviewed") journalReviewed.push(author);
        else if (value.status === "included") journalIncluded.push(author);
      } else if (key.startsWith(MOD_DECISION_PREFIX) && value && value.mod) {
        if (value.status === "unreviewed") {
          const cleared = normaliseDecision({ ...value.mod, status: "skip" });
          journalUnreviewed.add(cleared.key);
          if (cleared.modId) journalUnreviewed.add(`unknown:${cleared.modId}`);
        } else {
          journalMods.push(normaliseDecision(value.mod));
        }
      }
    }
    const blockedJournalIndex = createAuthorIndex(journalBlocked);
    const reviewedJournalIndex = createAuthorIndex(journalReviewed);
    const includedJournalIndex = createAuthorIndex(journalIncluded);
    state.blockedAuthors = dedupeBy([
      ...state.blockedAuthors.filter(author =>
        !authorIndexHas(reviewedJournalIndex, author) && !authorIndexHas(includedJournalIndex, author)
      ),
      ...journalBlocked
    ].filter(author => !authorIndexHas(includedJournalIndex, author)), authorKey);
    const finalBlockedIndex = createAuthorIndex(state.blockedAuthors);
    state.reviewedAuthors = dedupeBy([
      ...state.reviewedAuthors.filter(author =>
        !authorIndexHas(blockedJournalIndex, author) && !authorIndexHas(includedJournalIndex, author)
      ),
      ...journalReviewed
    ].filter(author => !authorIndexHas(includedJournalIndex, author)), authorKey)
      .filter(author => !authorIndexHas(finalBlockedIndex, author));
    state.modDecisions = dedupeBy([
      ...state.modDecisions.filter(decision => !journalUnreviewed.has(decision.key)),
      ...journalMods
    ], decision => decision.key);
    return state;
  }

  function authorsMatch(left, right) {
    const leftId = String(left && left.userId || "").trim();
    const rightId = String(right && right.userId || "").trim();
    if (leftId && rightId && leftId === rightId) return true;
    const leftName = normaliseUsername(left && left.username);
    const rightName = normaliseUsername(right && right.username);
    return Boolean(leftName) && leftName === rightName;
  }

  function isAuthorBlocked(state, author) {
    return state.blockedAuthors.some(blocked => authorsMatch(blocked, author));
  }

  function isAuthorReviewed(state, author) {
    return state.reviewedAuthors.some(reviewed => authorsMatch(reviewed, author));
  }

  function decisionFor(state, mod) {
    const exactKey = modKey(mod);
    return state.modDecisions.find(item => item.key === exactKey) ||
      state.modDecisions.find(item => item.game === "unknown" && item.modId === String(mod.modId));
  }

  function stateForUpdate(state) {
    const source = state && state.schemaVersion === SCHEMA_VERSION ? state : normaliseState(state);
    return {
      ...source,
      schemaVersion: SCHEMA_VERSION,
      blockedAuthors: [...source.blockedAuthors],
      reviewedAuthors: [...source.reviewedAuthors],
      modDecisions: [...source.modDecisions],
      settings: { ...source.settings }
    };
  }

  function blockAuthor(state, author, sourceUrl) {
    const next = stateForUpdate(state);
    const item = normaliseAuthor({ ...author, sourceUrl: sourceUrl || author.profileUrl || "" });
    const existing = next.blockedAuthors.findIndex(value => {
      if (item.userId && value.userId === item.userId) return true;
      const itemName = normaliseUsername(item.username);
      return itemName && normaliseUsername(value.username) === itemName;
    });
    if (existing >= 0) next.blockedAuthors[existing] = { ...next.blockedAuthors[existing], ...item };
    else next.blockedAuthors.push(item);
    next.reviewedAuthors = next.reviewedAuthors.filter(value => !authorsMatch(value, item));
    return next;
  }

  function reviewAuthor(state, author, sourceUrl) {
    const next = stateForUpdate(state);
    const item = normaliseAuthor({ ...author, sourceUrl: sourceUrl || author.profileUrl || "" });
    const existing = next.reviewedAuthors.findIndex(value => authorsMatch(value, item));
    if (existing >= 0) next.reviewedAuthors[existing] = { ...next.reviewedAuthors[existing], ...item };
    else next.reviewedAuthors.push(item);
    next.blockedAuthors = next.blockedAuthors.filter(value => !authorsMatch(value, item));
    return next;
  }

  function setDecision(state, mod, status) {
    if (!VALID_STATUSES.has(status)) throw new Error(`Unsupported status: ${status}`);
    const next = stateForUpdate(state);
    const item = normaliseDecision({
      ...mod,
      author: mod.author && mod.author.username ? mod.author.username : mod.author,
      status
    });
    const index = next.modDecisions.findIndex(value => value.key === item.key);
    if (index >= 0) next.modDecisions[index] = item;
    else next.modDecisions.push(item);
    return next;
  }

  function clearDecision(state, mod) {
    const next = stateForUpdate(state);
    const exactKey = modKey(mod);
    const modId = String(mod && mod.modId || "").trim();
    next.modDecisions = next.modDecisions.filter(item =>
      item.key !== exactKey && !(modId && item.game === "unknown" && item.modId === modId)
    );
    return next;
  }

  function csvEscape(value) {
    const text = String(value == null ? "" : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function stateToCsv(input) {
    const state = normaliseState(input);
    const header = ["record_type", "username", "user_id", "game", "mod_id", "status", "title", "author", "added_at", "source_url"];
    const rows = [header];
    for (const author of state.blockedAuthors) {
      rows.push(["blocked_author", author.username, author.userId, "", "", "", "", "", author.addedAt, author.sourceUrl]);
    }
    for (const author of state.reviewedAuthors) {
      rows.push(["reviewed_author", author.username, author.userId, "", "", "", "", "", author.addedAt, author.sourceUrl]);
    }
    for (const mod of state.modDecisions) {
      rows.push(["mod_decision", "", "", mod.game, mod.modId, mod.status, mod.title, mod.author, mod.addedAt, mod.sourceUrl]);
    }
    return rows.map(row => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
  }

  function publicBlocklistCsv(input) {
    const source = normaliseState(input);
    return stateToCsv({
      ...defaultState(),
      blockedAuthors: source.blockedAuthors
    });
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    const source = String(text || "");
    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if (quoted) {
        if (char === '"' && source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n") {
        row.push(field.replace(/\r$/, ""));
        if (row.some(value => value !== "")) rows.push(row);
        row = [];
        field = "";
      } else field += char;
    }
    row.push(field.replace(/\r$/, ""));
    if (row.some(value => value !== "")) rows.push(row);
    return rows;
  }

  function csvToState(text, baseState) {
    const rows = parseCsv(text);
    if (!rows.length) return normaliseState(baseState);
    const headers = rows.shift().map(value => value.trim().toLocaleLowerCase());
    let state = normaliseState(baseState);
    for (const values of rows) {
      const record = {};
      headers.forEach((header, index) => { record[header] = values[index] || ""; });
      if (record.record_type === "blocked_author" && (record.username || record.user_id)) {
        state = blockAuthor(state, {
          username: record.username,
          userId: record.user_id,
          addedAt: record.added_at,
          profileUrl: record.source_url
        });
      } else if (record.record_type === "reviewed_author" && (record.username || record.user_id)) {
        state = reviewAuthor(state, {
          username: record.username,
          userId: record.user_id,
          addedAt: record.added_at,
          profileUrl: record.source_url
        });
      } else if (record.record_type === "mod_decision" && record.mod_id && VALID_STATUSES.has(record.status)) {
        state = setDecision(state, {
          game: record.game,
          modId: record.mod_id,
          title: record.title,
          author: record.author,
          sourceUrl: record.source_url,
          addedAt: record.added_at
        }, record.status);
      }
    }
    return state;
  }

  const api = {
    SCHEMA_VERSION,
    VALID_STATUSES,
    AUTHOR_DECISION_PREFIX,
    MOD_DECISION_PREFIX,
    authorIndexHas,
    authorDecisionStorageKey,
    authorKey,
    authorsMatch,
    blockAuthor,
    clearDecision,
    createAuthorIndex,
    csvToState,
    decisionFor,
    defaultState,
    isAuthorBlocked,
    isAuthorReviewed,
    modKey,
    modDecisionStorageKey,
    normaliseState,
    normaliseUsername,
    parseCsv,
    parseModUrl,
    publicBlocklistCsv,
    readModTile,
    reviewAuthor,
    setDecision,
    stateFromStorage,
    stateToCsv,
    userIdFromAvatar,
    usernameFromProfileUrl
  };

  root.NexusCuratorCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
