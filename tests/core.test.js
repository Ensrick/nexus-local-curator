"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const Core = require("../extension/src/shared.js");

test("parses Nexus mod URLs", () => {
  assert.deepEqual(Core.parseModUrl("https://www.nexusmods.com/skyrimspecialedition/mods/170344?tab=files"), {
    game: "skyrimspecialedition",
    modId: "170344",
    sourceUrl: "https://www.nexusmods.com/skyrimspecialedition/mods/170344?tab=files"
  });
  assert.equal(Core.parseModUrl("https://www.nexusmods.com/profile/example"), null);
});

test("reads author and mod identity from a Nexus tile", () => {
  const dom = new JSDOM(`
    <div data-e2eid="mod-tile">
      <a data-e2eid="mod-tile-title" href="https://www.nexusmods.com/skyrimspecialedition/mods/42">Useful Mod</a>
      <a data-e2eid="user-link" href="https://www.nexusmods.com/profile/SomeAuthor">
        <img src="https://avatars.nexusmods.com/123456/100"><span>SomeAuthor</span>
      </a>
    </div>`, { url: "https://www.nexusmods.com/skyrimspecialedition/mods" });
  const result = Core.readModTile(dom.window.document.querySelector("[data-e2eid=mod-tile]"));
  assert.equal(result.key, "skyrimspecialedition:42");
  assert.equal(result.author.username, "SomeAuthor");
  assert.equal(result.author.userId, "123456");
});

test("migrates the prototype string arrays", () => {
  const state = Core.normaliseState({
    blockedAuthors: ["Alice", "alice", "Bob"],
    blockedMods: ["https://www.nexusmods.com/skyrimspecialedition/mods/12", "34"]
  });
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.blockedAuthors.length, 2);
  assert.equal(state.modDecisions.length, 2);
  assert.equal(state.modDecisions.find(item => item.modId === "12").status, "skip");
});

test("matches blocked authors by ID or case-insensitive username", () => {
  const state = Core.normaliseState({
    blockedAuthors: [{ username: "OldName", userId: "99" }]
  });
  assert.equal(Core.isAuthorBlocked(state, { username: "oldname" }), true);
  assert.equal(Core.isAuthorBlocked(state, { username: "NewName", userId: "99" }), true);
  assert.equal(Core.isAuthorBlocked(state, { username: "Other", userId: "100" }), false);
});

test("indexes large author lists by either public ID or username", () => {
  const index = Core.createAuthorIndex([
    { username: "OldName", userId: "99" },
    { username: "NameOnly" }
  ]);
  assert.equal(Core.authorIndexHas(index, { username: "NewName", userId: "99" }), true);
  assert.equal(Core.authorIndexHas(index, { username: "oldname" }), true);
  assert.equal(Core.authorIndexHas(index, { username: "NAMEONLY" }), true);
  assert.equal(Core.authorIndexHas(index, { username: "Other", userId: "100" }), false);
});

test("replays per-author and per-mod storage decisions over the legacy arrays", () => {
  const blocked = { username: "QueuedBlock", userId: "20", addedAt: "2026-01-01T00:00:00.000Z" };
  const reviewed = { username: "WasBlocked", userId: "10", addedAt: "2026-01-01T00:00:00.000Z" };
  const mod = { game: "skyrimspecialedition", modId: "42", status: "keep", title: "Queued Mod" };
  const stored = {
    schemaVersion: Core.SCHEMA_VERSION,
    blockedAuthors: [{ username: "WasBlocked", userId: "10" }],
    reviewedAuthors: [],
    modDecisions: [],
    [Core.authorDecisionStorageKey(blocked)]: { status: "blocked", author: blocked },
    [Core.authorDecisionStorageKey(reviewed)]: { status: "reviewed", author: reviewed },
    [Core.modDecisionStorageKey(mod)]: { mod }
  };
  const state = Core.stateFromStorage(stored);
  assert.equal(Core.isAuthorBlocked(state, blocked), true);
  assert.equal(Core.isAuthorBlocked(state, reviewed), false);
  assert.equal(Core.isAuthorReviewed(state, reviewed), true);
  assert.equal(Core.decisionFor(state, mod).status, "keep");
});

test("an unreviewed journal decision clears an accidental Keep", () => {
  const kept = { game: "skyrimspecialedition", modId: "42", status: "keep", title: "Accidental Keep" };
  const other = { game: "skyrimspecialedition", modId: "43", status: "keep", title: "Intentional Keep" };
  const stored = {
    schemaVersion: Core.SCHEMA_VERSION,
    blockedAuthors: [],
    reviewedAuthors: [],
    modDecisions: [kept, other],
    [Core.modDecisionStorageKey(kept)]: { kind: "mod", status: "unreviewed", mod: kept }
  };

  const state = Core.stateFromStorage(stored);
  assert.equal(Core.decisionFor(state, kept), undefined);
  assert.equal(Core.decisionFor(state, other).status, "keep");
});

test("an included journal decision clears legacy blocked or hidden author entries", () => {
  const included = { username: "RestoredAuthor", userId: "30" };
  const stored = {
    schemaVersion: Core.SCHEMA_VERSION,
    blockedAuthors: [included],
    reviewedAuthors: [{ username: "HiddenLegacy", userId: "40" }],
    modDecisions: [],
    [Core.authorDecisionStorageKey(included)]: { status: "included", author: included },
    [Core.authorDecisionStorageKey({ username: "HiddenLegacy", userId: "40" })]: {
      status: "included",
      author: { username: "HiddenLegacy", userId: "40" }
    }
  };
  const state = Core.stateFromStorage(stored);
  assert.equal(Core.isAuthorBlocked(state, included), false);
  assert.equal(Core.isAuthorReviewed(state, { username: "HiddenLegacy", userId: "40" }), false);
});

test("keeps reviewed and excluded authors in separate, mutually exclusive lists", () => {
  let state = Core.reviewAuthor(Core.defaultState(), { username: "Alice", userId: "10" }, "manual");
  assert.equal(Core.isAuthorReviewed(state, { username: "ALICE" }), true);
  assert.equal(Core.isAuthorBlocked(state, { username: "Alice" }), false);

  state = Core.blockAuthor(state, { username: "Alice", userId: "10" }, "manual");
  assert.equal(Core.isAuthorReviewed(state, { username: "Alice" }), false);
  assert.equal(Core.isAuthorBlocked(state, { username: "Alice" }), true);
});

test("CSV export and import preserve quoted values and decisions", () => {
  let state = Core.blockAuthor(Core.defaultState(), { username: 'Comma, "Name"', userId: "7" }, "manual");
  state = Core.setDecision(state, {
    game: "skyrimspecialedition",
    modId: "55",
    title: "A Mod, Revised",
    author: { username: "Author" },
    sourceUrl: "https://www.nexusmods.com/skyrimspecialedition/mods/55"
  }, "keep");
  state = Core.reviewAuthor(state, { username: "ReviewedAuthor", userId: "88" }, "manual");
  const restored = Core.csvToState(Core.stateToCsv(state));
  assert.equal(restored.blockedAuthors[0].username, 'Comma, "Name"');
  assert.equal(restored.modDecisions[0].title, "A Mod, Revised");
  assert.equal(restored.modDecisions[0].author, "Author");
  assert.equal(restored.modDecisions[0].status, "keep");
  assert.equal(restored.reviewedAuthors[0].username, "ReviewedAuthor");
});

test("public blocklist export cannot contain private lists, decisions, or API keys", () => {
  const csv = Core.publicBlocklistCsv({
    nexusApiKey: "DO-NOT-EXPORT-THIS-KEY",
    blockedAuthors: [{ username: "PublicExcluded", userId: "7" }],
    reviewedAuthors: [{ username: "PrivateHidden", userId: "8" }],
    modDecisions: [{ game: "skyrimspecialedition", modId: "9", status: "keep", title: "Private Keep" }]
  });
  assert.match(csv, /blocked_author,PublicExcluded,7/);
  assert.doesNotMatch(csv, /DO-NOT-EXPORT|PrivateHidden|Private Keep|reviewed_author|mod_decision/);
});
