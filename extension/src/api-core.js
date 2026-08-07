(function initialiseNexusApiCore(root) {
  "use strict";

  const API_BATCH_SIZE = 80;
  const SORTS = Object.freeze({
    newest: { createdAt: { direction: "DESC" } },
    oldest: { createdAt: { direction: "ASC" } },
    updated: { updatedAt: { direction: "DESC" } },
    downloads: { downloads: { direction: "DESC" } },
    endorsements: { endorsements: { direction: "DESC" } },
    name: { name: { direction: "ASC" } }
  });

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function authorExclusionsFor(authors) {
    const userIds = unique(authors.map(author => String(author && author.userId || "").trim()));
    const usernames = unique(authors
      .filter(author => !String(author && author.userId || "").trim())
      .map(author => String(author && author.username || "").trim()));
    return { userIds, usernames };
  }

  function authorExclusions(state) {
    return authorExclusionsFor([
      ...(Array.isArray(state && state.blockedAuthors) ? state.blockedAuthors : []),
      ...(Array.isArray(state && state.reviewedAuthors) ? state.reviewedAuthors : [])
    ]);
  }

  function addAuthorExclusions(filter, exclusions) {
    const next = { ...filter };
    if (exclusions.userIds.length) next.uploaderId = [...(next.uploaderId || []), ...notEquals(exclusions.userIds)];
    if (exclusions.usernames.length) next.uploader = [...(next.uploader || []), ...notEquals(exclusions.usernames)];
    return next;
  }

  function excludedModIds(state, gameDomainName) {
    const game = String(gameDomainName || "").trim().toLocaleLowerCase();
    return unique((Array.isArray(state && state.modDecisions) ? state.modDecisions : [])
      .filter(mod => mod && (mod.game === game || mod.game === "unknown"))
      .map(mod => String(mod.modId || "").trim()));
  }

  function notEquals(values) {
    return values.map(value => ({ value, op: "NOT_EQUALS" }));
  }

  function equals(values) {
    return unique(values.map(value => String(value || "").trim()))
      .map(value => ({ value, op: "EQUALS" }));
  }

  function buildModsVariables(request) {
    const input = request || {};
    const gameDomainName = String(input.gameDomainName || "skyrimspecialedition").trim().toLocaleLowerCase();
    const state = input.state || {};
    const baseFilter = {
      op: "AND",
      gameDomainName: [{ value: gameDomainName, op: "EQUALS" }]
    };
    const requestedFilters = input.filters || {};
    const facets = {
      languageName: unique(Array.isArray(requestedFilters.languageNames) ? requestedFilters.languageNames : []),
      categoryName: unique(Array.isArray(requestedFilters.categoryNames) ? requestedFilters.categoryNames : [])
    };
    const modIds = excludedModIds(state, gameDomainName);
    if (modIds.length) baseFilter.modId = notEquals(modIds);
    const blocked = authorExclusionsFor(Array.isArray(state.blockedAuthors) ? state.blockedAuthors : []);
    const reviewed = authorExclusionsFor(Array.isArray(state.reviewedAuthors) ? state.reviewedAuthors : []);
    const excludedOnlyFilter = addAuthorExclusions(baseFilter, blocked);
    const filter = addAuthorExclusions(excludedOnlyFilter, reviewed);

    const sort = SORTS[input.sort] || SORTS.newest;
    const direction = String(input.sortDirection || "").toLocaleUpperCase();
    const sortWithDirection = direction === "ASC" || direction === "DESC"
      ? Object.fromEntries(Object.entries(sort).map(([key, value]) => [key, { ...value, direction }]))
      : sort;
    const page = Math.max(1, Number.parseInt(input.page, 10) || 1);

    return {
      viewUploaderHidden: false,
      viewUserBlockedContent: true,
      facets,
      filter,
      excludedOnlyFilter,
      baseFilter,
      sort: [sortWithDirection],
      offset: (page - 1) * API_BATCH_SIZE,
      count: API_BATCH_SIZE
    };
  }

  function buildStreamVariables(request) {
    return buildModsVariables({
      ...(request || {}),
      state: { blockedAuthors: [], reviewedAuthors: [], modDecisions: [] }
    });
  }

  function normaliseApiMod(value, fallbackGame) {
    const input = value || {};
    const uploader = input.uploader || {};
    const game = String(input.game && input.game.domainName || fallbackGame || "unknown").trim().toLocaleLowerCase();
    const modId = String(input.modId || "").trim();
    const username = String(uploader.name || input.author || "").trim();
    return {
      key: `${game}:${modId}`,
      game,
      modId,
      title: String(input.name || `Mod ${modId}`).trim(),
      summary: String(input.summary || "").trim(),
      category: String(input.category || "").trim(),
      downloads: Number(input.downloads || 0),
      endorsements: Number(input.endorsements || 0),
      createdAt: String(input.createdAt || ""),
      updatedAt: String(input.updatedAt || ""),
      thumbnailUrl: String(input.thumbnailUrl || input.thumbnailLargeUrl || ""),
      sourceUrl: `https://www.nexusmods.com/${encodeURIComponent(game)}/mods/${encodeURIComponent(modId)}`,
      author: {
        username,
        userId: String(uploader.memberId || "").trim(),
        profileUrl: uploader.memberId
          ? `https://www.nexusmods.com/users/${encodeURIComponent(String(uploader.memberId).trim())}?tab=user+files`
          : username
            ? `https://www.nexusmods.com/profile/${encodeURIComponent(username)}/mods`
            : ""
      }
    };
  }

  const api = {
    API_BATCH_SIZE,
    SORTS,
    authorExclusions,
    buildModsVariables,
    buildStreamVariables,
    excludedModIds,
    normaliseApiMod
  };

  root.NexusCuratorApiCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
