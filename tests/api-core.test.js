"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ApiCore = require("../extension/src/api-core.js");

test("builds one API request containing all author and reviewed-mod exclusions", () => {
  const variables = ApiCore.buildModsVariables({
    gameDomainName: "SkyrimSpecialEdition",
    sort: "downloads",
    state: {
      blockedAuthors: [
        { username: "BlockedById", userId: "10" },
        { username: "BlockedByName", userId: "" }
      ],
      reviewedAuthors: [
        { username: "ReviewedById", userId: "20" },
        { username: "blockedbyname", userId: "" }
      ],
      modDecisions: [
        { game: "skyrimspecialedition", modId: "100", status: "keep" },
        { game: "fallout4", modId: "200", status: "skip" },
        { game: "unknown", modId: "300", status: "maybe" }
      ]
    }
  });

  assert.equal(variables.count, 80);
  assert.equal(variables.offset, 0);
  assert.deepEqual(variables.facets, { languageName: [], categoryName: [] });
  assert.deepEqual(variables.filter.gameDomainName, [{ value: "skyrimspecialedition", op: "EQUALS" }]);
  assert.deepEqual(variables.filter.uploaderId, [
    { value: "10", op: "NOT_EQUALS" },
    { value: "20", op: "NOT_EQUALS" }
  ]);
  assert.deepEqual(variables.filter.uploader, [
    { value: "BlockedByName", op: "NOT_EQUALS" },
    { value: "blockedbyname", op: "NOT_EQUALS" }
  ]);
  assert.deepEqual(variables.filter.modId, [
    { value: "100", op: "NOT_EQUALS" },
    { value: "300", op: "NOT_EQUALS" }
  ]);
  assert.equal(variables.baseFilter.uploaderId, undefined);
  assert.deepEqual(variables.excludedOnlyFilter.uploaderId, [{ value: "10", op: "NOT_EQUALS" }]);
  assert.deepEqual(variables.sort, [{ downloads: { direction: "DESC" } }]);
});

test("builds a lightweight stream request without local exclusion arrays", () => {
  const variables = ApiCore.buildStreamVariables({
    gameDomainName: "skyrimspecialedition",
    page: 7,
    state: {
      blockedAuthors: Array.from({ length: 3307 }, (_, index) => ({ userId: String(index + 1) })),
      reviewedAuthors: [{ username: "Reviewed" }],
      modDecisions: [{ game: "skyrimspecialedition", modId: "9", status: "skip" }]
    }
  });
  assert.equal(variables.filter.uploaderId, undefined);
  assert.equal(variables.filter.uploader, undefined);
  assert.equal(variables.filter.modId, undefined);
  assert.equal(variables.offset, 480);
});

test("normalises GraphQL mods into local decisions without trusting markup", () => {
  const mod = ApiCore.normaliseApiMod({
    modId: 123,
    name: "A Mod",
    summary: "Summary",
    category: "Patches",
    downloads: 500,
    endorsements: 20,
    thumbnailUrl: "https://staticdelivery.nexusmods.com/image.jpg",
    uploader: { memberId: 42, name: "Alice" },
    game: { domainName: "skyrimspecialedition" }
  });

  assert.equal(mod.key, "skyrimspecialedition:123");
  assert.equal(mod.author.username, "Alice");
  assert.equal(mod.author.userId, "42");
  assert.equal(mod.author.profileUrl, "https://www.nexusmods.com/users/42?tab=user+files");
  assert.equal(mod.sourceUrl, "https://www.nexusmods.com/skyrimspecialedition/mods/123");
});

test("mirrors Nexus facets, direction, and an 80-result API page", () => {
  const variables = ApiCore.buildModsVariables({
    gameDomainName: "skyrimspecialedition",
    page: 3,
    sort: "newest",
    sortDirection: "asc",
    filters: {
      languageNames: ["Czech"],
      categoryNames: ["Patches"]
    },
    state: {}
  });

  assert.deepEqual(variables.facets, { languageName: ["Czech"], categoryName: ["Patches"] });
  assert.deepEqual(variables.sort, [{ createdAt: { direction: "ASC" } }]);
  assert.equal(variables.offset, 160);
  assert.equal(variables.count, 80);
});
