"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const sourceRoot = path.join(__dirname, "..", "extension", "src");
const apiCoreSource = fs.readFileSync(path.join(sourceRoot, "api-core.js"), "utf8");
const sharedSource = fs.readFileSync(path.join(sourceRoot, "shared.js"), "utf8");
const contentSource = fs.readFileSync(path.join(sourceRoot, "content.js"), "utf8");

function tile(id, author, userId) {
  return `<div class="tile" data-e2eid="mod-tile">
    <div><a href="https://www.nexusmods.com/skyrimspecialedition/mods/${id}"></a></div>
    <div>
      <a data-e2eid="mod-tile-title" href="https://www.nexusmods.com/skyrimspecialedition/mods/${id}">Mod ${id}</a>
      <a data-e2eid="user-link" href="https://www.nexusmods.com/profile/${author}?gameId=1704">
        <img data-testid="user-link-avatar" src="https://avatars.nexusmods.com/${userId}/100"><span>${author}</span>
      </a>
    </div>
    <div class="original-footer"></div>
  </div>`;
}

test("content script hides blocked authors, reflows cards, and adds live controls", async t => {
  const dom = new JSDOM(`<!doctype html><body>
    <div data-e2eid="result-count">116,940 results</div>
    <div class="mods-grid">${tile(1, "Alice", 10)}${tile(2, "Bob", 20)}</div>
  </body>`, {
    url: "https://www.nexusmods.com/games/skyrimspecialedition/mods",
    runScripts: "outside-only"
  });
  t.after(() => dom.window.close());

  let stored = {
    schemaVersion: 3,
    blockedAuthors: [{ username: "Alice", userId: "10", addedAt: "2026-01-01T00:00:00.000Z" }],
    reviewedAuthors: [],
    modDecisions: [],
    settings: { showPageStatus: true }
  };
  dom.window.browser = {
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async value => { stored = { ...stored, ...structuredClone(value) }; },
        clear: async () => { stored = {}; }
      },
      onChanged: { addListener: () => {} }
    },
    runtime: {
      sendMessage: async message => {
        if (message.type === "persist-local-delta") {
          stored[message.key] = structuredClone(message.value);
          return { ok: true };
        }
        return {};
      }
    }
  };

  dom.window.eval(sharedSource);
  dom.window.eval(contentSource);
  await new Promise(resolve => setTimeout(resolve, 140));

  const tiles = dom.window.document.querySelectorAll('[data-e2eid="mod-tile"]');
  assert.equal(tiles[0].classList.contains("nlc-hidden"), true);
  assert.equal(tiles[1].classList.contains("nlc-hidden"), false);
  assert.equal(tiles[1].querySelector('[data-e2eid="user-link"]').hostname, "www.nexusmods.com");
  assert.equal(tiles[1].querySelector('[data-e2eid="user-link"]').pathname, "/profile/Bob/mods");
  assert.equal(new URL(tiles[1].querySelector('[data-e2eid="user-link"]').href).searchParams.get("gameId"), "1704");
  assert.equal(tiles[1].querySelectorAll(".nlc-controls button").length, 4);
  assert.match(dom.window.document.querySelector(".nlc-result-summary").textContent, /2 loaded · 1 hidden locally/);
  assert.match(dom.window.document.querySelector("#nlc-page-status").textContent, /1 shown · 0 hidden authors · 1 excluded authors/);
  assert.equal(dom.window.document.querySelector('[data-nlc-action="toggle-skipped"]').textContent, "Show Skipped");

  const blockBob = tiles[1].querySelector('[data-nlc-action="block-author"]');
  blockBob.click();
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(tiles[1].classList.contains("nlc-hidden"), true);
  assert.equal(dom.window.NexusCuratorCore.stateFromStorage(stored).blockedAuthors.length, 2);

});

test("hides cards from explicitly reviewed authors while leaving other authors visible", async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div data-e2eid="result-count">2 results</div>
    <div class="mods-grid">${tile(10, "Alice", 10)}${tile(11, "Bob", 20)}</div>
  </body>`, {
    url: "https://www.nexusmods.com/games/skyrimspecialedition/mods",
    runScripts: "outside-only"
  });

  const stored = {
    schemaVersion: 3,
    blockedAuthors: [],
    reviewedAuthors: [{ username: "Alice", userId: "10", addedAt: "2026-01-01T00:00:00.000Z" }],
    modDecisions: [],
    settings: { showPageStatus: true }
  };
  dom.window.browser = {
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async () => {},
        clear: async () => {}
      },
      onChanged: { addListener: () => {} }
    },
    runtime: { sendMessage: async () => {} }
  };

  dom.window.eval(sharedSource);
  dom.window.eval(contentSource);
  await new Promise(resolve => setTimeout(resolve, 140));

  const tiles = dom.window.document.querySelectorAll('[data-e2eid="mod-tile"]');
  assert.equal(tiles[0].classList.contains("nlc-hidden"), true);
  assert.equal(tiles[1].classList.contains("nlc-hidden"), false);
  assert.match(dom.window.document.querySelector("#nlc-page-status").textContent, /1 hidden authors/);
  dom.window.close();
});

test("author catalogues ignore author-level filters but still hide individually skipped mods", async t => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="mods-grid">${tile(10, "BlockedAuthor", 10)}${tile(11, "BlockedAuthor", 10)}</div>
  </body>`, {
    url: "https://www.nexusmods.com/profile/BlockedAuthor/mods",
    runScripts: "outside-only"
  });
  t.after(() => dom.window.close());

  const stored = {
    schemaVersion: 4,
    blockedAuthors: [{ username: "BlockedAuthor", userId: "10" }],
    reviewedAuthors: [],
    modDecisions: [{
      game: "skyrimspecialedition",
      modId: "11",
      title: "Mod 11",
      author: "BlockedAuthor",
      status: "skip"
    }],
    settings: { showPageStatus: true }
  };
  dom.window.browser = {
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async value => Object.assign(stored, structuredClone(value)),
        clear: async () => {}
      },
      onChanged: { addListener: () => {} }
    },
    runtime: { sendMessage: async () => ({ ok: true }) }
  };

  dom.window.eval(sharedSource);
  dom.window.eval(contentSource);
  await new Promise(resolve => setTimeout(resolve, 150));

  const tiles = dom.window.document.querySelectorAll('[data-e2eid="mod-tile"]');
  assert.equal(tiles[0].classList.contains("nlc-hidden"), false);
  assert.equal(tiles[1].classList.contains("nlc-hidden"), true);
  assert.equal(tiles[0].querySelector(".nlc-block-author").textContent, "Include");

  dom.window.document.querySelector('[data-nlc-action="toggle-skipped"]').click();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(tiles[1].classList.contains("nlc-hidden"), false);
  assert.equal(tiles[1].querySelector('[data-nlc-action="unskip"]').textContent, "Unskip");

  tiles[1].querySelector('[data-nlc-action="unskip"]').click();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(tiles[1].querySelector('[data-nlc-action="skip"]').textContent, "Skip");

  tiles[0].querySelector('[data-nlc-action="unblock-author"]').click();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(tiles[0].querySelector(".nlc-block-author").textContent, "Exclude");

  tiles[0].querySelector('[data-nlc-action="review-author"]').click();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(tiles[0].classList.contains("nlc-hidden"), false);
  assert.equal(tiles[0].querySelector(".nlc-review-author").textContent, "Unhide");

  tiles[0].querySelector('[data-nlc-action="unreview-author"]').click();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(tiles[0].querySelector(".nlc-review-author").textContent, "Hide");

  tiles[0].querySelector('[data-nlc-action="keep"]').click();
  await new Promise(resolve => setTimeout(resolve, 320));
  const unkeep = tiles[0].querySelector('[data-nlc-action="unkeep"]');
  assert.equal(unkeep.textContent, "Unkeep");
  unkeep.click();
  await new Promise(resolve => setTimeout(resolve, 320));
  assert.equal(tiles[0].querySelector('[data-nlc-action="keep"]').textContent, "Keep");
});

test("adds Blocked, Hidden, and Good statuses to the Tracking Centre author table", async t => {
  const dom = new JSDOM(`<!doctype html><body>
    <table id="tracked-mods">
      <thead><tr><th>Mod</th><th>Author</th><th>Updated</th></tr></thead>
      <tbody>
        <tr><td>Blocked mod</td><td><a href="https://www.nexusmods.com/profile/BlockedAuthor">BlockedAuthor</a></td><td>Today</td></tr>
        <tr><td>Hidden mod</td><td><a href="https://www.nexusmods.com/users/20">HiddenAuthor</a></td><td>Today</td></tr>
        <tr><td>Good mod</td><td><a href="https://www.nexusmods.com/profile/GoodAuthor">GoodAuthor</a></td><td>Today</td></tr>
      </tbody>
    </table>
  </body>`, {
    url: "https://www.nexusmods.com/skyrimspecialedition/mods/trackingcentre",
    runScripts: "outside-only"
  });
  t.after(() => dom.window.close());

  const stored = {
    schemaVersion: 4,
    blockedAuthors: [{ username: "BlockedAuthor", userId: "10" }],
    reviewedAuthors: [{ username: "HiddenAuthor", userId: "20" }],
    modDecisions: [],
    settings: { showPageStatus: true }
  };
  dom.window.browser = {
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async value => Object.assign(stored, structuredClone(value)),
        clear: async () => {}
      },
      onChanged: { addListener: () => {} }
    },
    runtime: { sendMessage: async () => ({ ok: true }) }
  };

  dom.window.eval(sharedSource);
  dom.window.eval(contentSource);
  await new Promise(resolve => setTimeout(resolve, 150));

  assert.equal(dom.window.document.querySelector("thead th:last-child").textContent, "Local status");
  assert.deepEqual(
    Array.from(dom.window.document.querySelectorAll("tbody [data-nlc-tracking-status]")).map(cell => cell.textContent),
    ["Blocked", "Hidden", "Good"]
  );
  assert.equal(
    dom.window.document.querySelector('tbody a[href*="/profile/BlockedAuthor"]').pathname,
    "/profile/BlockedAuthor/mods"
  );

  const row = dom.window.document.createElement("tr");
  row.innerHTML = '<td>Dynamic mod</td><td><a href="https://www.nexusmods.com/profile/GoodAuthor">GoodAuthor</a></td><td>Today</td>';
  dom.window.document.querySelector("tbody").appendChild(row);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(row.querySelector("[data-nlc-tracking-status]").textContent, "Good");
  assert.equal(dom.window.document.querySelectorAll("thead [data-nlc-tracking-status]").length, 1);
});

test("excluding with thousands of saved authors stays on the lightweight interaction path", async t => {
  const dom = new JSDOM(`<!doctype html><body>
    <div data-e2eid="result-count">1 result</div>
    <div class="mods-grid">${tile(10, "FreshAuthor", 99999)}</div>
  </body>`, {
    url: "https://www.nexusmods.com/games/skyrimspecialedition/mods",
    runScripts: "outside-only"
  });
  t.after(() => dom.window.close());

  const stored = {
    schemaVersion: 4,
    blockedAuthors: Array.from({ length: 3307 }, (_value, index) => ({
      username: `Blocked${index}`,
      userId: String(index + 1)
    })),
    reviewedAuthors: [],
    modDecisions: [],
    settings: { showPageStatus: true }
  };
  dom.window.browser = {
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async value => Object.assign(stored, structuredClone(value)),
        clear: async () => {}
      },
      onChanged: { addListener: () => {} }
    },
    runtime: {
      sendMessage: async message => {
        if (message.type === "persist-local-delta") {
          stored[message.key] = structuredClone(message.value);
          return { ok: true };
        }
        return { ok: true };
      }
    }
  };

  dom.window.eval(sharedSource);
  dom.window.eval(contentSource);
  await new Promise(resolve => setTimeout(resolve, 200));
  const button = dom.window.document.querySelector('[data-nlc-action="block-author"]');
  const startedAt = performance.now();
  button.click();
  const clickDuration = performance.now() - startedAt;

  assert.equal(dom.window.document.querySelector('[data-e2eid="mod-tile"]').classList.contains("nlc-hidden"), true);
  assert.match(dom.window.document.querySelector("#nlc-page-status").textContent, /3,308 excluded authors/);
  assert.ok(clickDuration < 250, `Exclude foreground work took ${clickDuration.toFixed(1)}ms`);

  dom.window.document.body.appendChild(dom.window.document.createElement("aside"));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(dom.window.document.querySelector('[data-nlc-action="block-author"]'), button);
});

test("never changes Nexus pagination when every loaded result is hidden", async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div data-e2eid="result-count">40 results</div>
    <div class="mods-grid">${tile(20, "Alice", 10)}</div>
    <input aria-label="Jump to page" value="1">
    <button aria-label="Go to next page">Next</button>
  </body>`, {
    url: "https://www.nexusmods.com/games/skyrimspecialedition/mods?sort=createdAt",
    runScripts: "outside-only"
  });

  const stored = {
    schemaVersion: 3,
    blockedAuthors: [{ username: "Alice", userId: "10", addedAt: "2026-01-01T00:00:00.000Z" }],
    reviewedAuthors: [],
    modDecisions: [],
    settings: { showPageStatus: true }
  };
  dom.window.browser = {
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async () => {},
        clear: async () => {}
      },
      onChanged: { addListener: () => {} }
    },
    runtime: { sendMessage: async () => {} }
  };
  let nextClicks = 0;
  dom.window.document.querySelector('[aria-label="Go to next page"]').addEventListener("click", () => { nextClicks += 1; });

  dom.window.eval(sharedSource);
  dom.window.eval(contentSource);
  await new Promise(resolve => setTimeout(resolve, 1050));

  assert.equal(nextClicks, 0);
  assert.match(dom.window.document.querySelector("#nlc-page-status").textContent, /0 shown .*1 excluded authors/);
  dom.window.close();
});

test("compacts an empty filtered Nexus page into API survivors with visibility controls", async t => {
  const dom = new JSDOM(`<!doctype html><body>
    <div data-e2eid="result-count">353 results</div>
    <div data-e2eid="language-support-filter">
      <span id="czech-filter" data-e2eid="checkbox-filter-czech" role="checkbox" aria-checked="true"></span>
      <label for="czech-filter"><span>Czech</span><span>(353)</span></label>
      <span id="portuguese-filter" data-e2eid="checkbox-filter-portuguese" role="checkbox" aria-checked="false"></span>
      <label for="portuguese-filter"><span>Portuguese</span><span>(3,353)</span></label>
      <span id="mandarin-filter" data-e2eid="checkbox-filter-mandarin" role="checkbox" aria-checked="false"></span>
      <label for="mandarin-filter"><span>Mandarin</span><span>(7,293)</span></label>
    </div>
    <div data-e2eid="category-filter">
      <span id="save-games-filter" data-e2eid="checkbox-filter-save-games" role="checkbox" aria-checked="false"></span>
      <label for="save-games-filter"><span>Save Games</span><span>(197)</span></label>
    </div>
    <div class="mods-grid">${tile(20, "BlockedAuthor", 10)}</div>
    <nav aria-label="Pagination navigation"><button aria-label="Go to next page">Next</button></nav>
  </body>`, {
    // Nexus flips the checkbox before its SPA updates the address bar.
    url: "https://www.nexusmods.com/games/skyrimspecialedition/mods",
    runScripts: "outside-only"
  });
  t.after(() => dom.window.close());

  const stored = {
    schemaVersion: 4,
    nexusApiKey: "configured",
    blockedAuthors: [{ username: "BlockedAuthor", userId: "10", addedAt: "2026-01-01T00:00:00.000Z" }],
    reviewedAuthors: [],
    modDecisions: [],
    settings: { showPageStatus: true }
  };
  const requests = [];
  let disconnectedBatchAttempts = 0;
  dom.window.browser = {
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async () => {},
        clear: async () => {}
      },
      onChanged: { addListener: () => {} }
    },
    runtime: {
      getManifest: () => ({ version: "test" }),
      sendMessage: async message => {
        requests.push(message);
        if (message.type === "nexus-api-filter-stats") {
          return {
            ok: true,
            hiddenModCount: 14,
            excludedModCount: 120,
            languageCounts: {}
          };
        }
        if (message.type === "nexus-api-language-counts") {
          return { ok: true, languageCounts: { Czech: 1, Portuguese: 0, Mandarin: 0 } };
        }
        if (message.type === "nexus-api-category-counts") {
          return { ok: true, categoryCounts: { "Save Games": 0 } };
        }
        if (message.type !== "nexus-api-batch") return {};
        disconnectedBatchAttempts += 1;
        if (disconnectedBatchAttempts === 1) {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        if (Array.from(message.request.filters.languageNames).includes("Portuguese")) {
          return {
            ok: true,
            totalCount: 0,
            facetsData: { languageName: { Portuguese: 3353 } },
            nodes: [],
            streamEndPage: 1,
            nextCursor: null
          };
        }
        return {
          ok: true,
          totalCount: 163,
          facetsData: { languageName: { Czech: 353 } },
          streamEndPage: 1,
          nextCursor: { page: 2, index: 0, batch: 2 },
          nodes: [{
            modId: 30,
            name: "Czech Survivor",
            summary: "Available after local filtering",
            category: "Translations",
            downloads: 12,
            endorsements: 2,
            uploader: { memberId: 30, name: "AllowedAuthor" },
            game: { domainName: "skyrimspecialedition" }
          }]
        };
      }
    }
  };

  dom.window.eval(apiCoreSource);
  dom.window.eval(sharedSource);
  dom.window.eval(contentSource);
  await new Promise(resolve => setTimeout(resolve, 1500));

  assert.equal(requests.some(message => message.type === "nexus-api-batch"), true);
  assert.equal(disconnectedBatchAttempts >= 2, true);
  const firstStreamRequest = requests.find(message => message.type === "nexus-api-batch").request;
  assert.equal(firstStreamRequest.mode, "stream");
  assert.equal(Object.prototype.hasOwnProperty.call(firstStreamRequest, "state"), false);
  assert.deepEqual(Array.from(firstStreamRequest.filters.languageNames), ["Czech"]);
  assert.equal(dom.window.document.body.classList.contains("nlc-curated-active"), true);
  assert.equal(dom.window.document.querySelector('[data-nlc-api-tile="true"]') !== null, true);
  assert.equal(dom.window.document.querySelector('[data-e2eid="mod-tile"]:not([data-nlc-api-tile])').classList.contains("nlc-native-suppressed"), true);
  assert.match(dom.window.document.querySelector(".nlc-result-summary").textContent, /163 source mods · Batch 1 · source page 1 of 3/);
  assert.equal(dom.window.document.querySelector(".nlc-api-pagination strong").textContent, "Batch 1 · source page 1 of 3");
  assert.match(dom.window.document.querySelector(".nlc-api-header").textContent, /1 unreviewed mods in this batch/);
  assert.equal(dom.window.document.querySelector('label[for="czech-filter"] span:last-child').classList.contains("nlc-facet-count-suppressed"), true);
  assert.match(dom.window.document.querySelector("#nlc-page-status").textContent, /0 hidden authors · 1 excluded authors/);
  assert.equal(dom.window.document.querySelector('[data-nlc-action="toggle-hidden"]').textContent, "Show Hidden");
  assert.equal(dom.window.document.querySelector('[data-nlc-action="toggle-blocked"]').textContent, "Show Blocked");

  dom.window.document.getElementById("czech-filter").setAttribute("aria-checked", "false");
  const portuguese = dom.window.document.getElementById("portuguese-filter");
  portuguese.setAttribute("aria-checked", "true");
  portuguese.click();
  await new Promise(resolve => setTimeout(resolve, 1000));
  const apiRequests = requests.filter(message => message.type === "nexus-api-batch");
  assert.deepEqual(Array.from(apiRequests.at(-1).request.filters.languageNames), ["Portuguese"]);
  assert.equal(dom.window.document.querySelector('label[for="portuguese-filter"] span:last-child').classList.contains("nlc-facet-count-suppressed"), true);
  assert.equal(dom.window.document.querySelector('label[for="mandarin-filter"] span:last-child').classList.contains("nlc-facet-count-suppressed"), true);
  assert.equal(dom.window.document.querySelector('label[for="save-games-filter"] span:last-child').classList.contains("nlc-facet-count-suppressed"), true);
  assert.equal(dom.window.document.querySelector(".nlc-api-pagination strong").textContent, "Batch 1 · no source pages");
  assert.match(dom.window.document.querySelector("#nlc-page-status").textContent, /1 excluded authors/);
});

test("review stream returns partial results immediately and advances to the next nonempty source page", async t => {
  const dom = new JSDOM(`<!doctype html><body>
    <div data-e2eid="result-count">160 results</div>
    <div class="mods-grid">${tile(1, "NativeAuthor", 1)}</div>
  </body>`, {
    url: "https://www.nexusmods.com/games/skyrimspecialedition/mods?sort=createdAt",
    runScripts: "outside-only"
  });
  t.after(() => dom.window.close());

  const stored = {
    schemaVersion: 4,
    nexusApiKey: "configured",
    blockedAuthors: [{ username: "AlreadyReviewed", userId: "999" }],
    reviewedAuthors: [],
    modDecisions: [],
    settings: { showPageStatus: true }
  };
  const sourcePages = [];
  dom.window.browser = {
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async value => Object.assign(stored, structuredClone(value)),
        clear: async () => {}
      },
      onChanged: { addListener: () => {} }
    },
    runtime: {
      getManifest: () => ({ version: "test" }),
      sendMessage: async message => {
        if (message.type === "persist-local-delta") {
          stored[message.key] = structuredClone(message.value);
          return { ok: true };
        }
        if (message.type === "persist-stream-cursor" || message.type === "record-performance-diagnostic") return { ok: true };
        if (message.type !== "nexus-api-batch") return {};
        const page = message.request.cursor.page;
        sourcePages.push(page);
        return {
          ok: true,
          totalCount: 160,
          streamEndPage: page === 1 ? 4 : 5,
          nextCursor: page === 1 ? { page: 5, index: 0, batch: 2 } : null,
          nodes: Array.from({ length: page === 1 ? 3 : 2 }, (_value, index) => ({
            modId: page * 100 + index,
            name: page === 1 ? `First partial result ${index}` : `Next partial result ${index}`,
            uploader: { memberId: page === 1 ? 10 : 20, name: page === 1 ? "BatchAuthor" : "NextAuthor" },
            game: { domainName: "skyrimspecialedition" }
          }))
        };
      }
    }
  };

  dom.window.eval(apiCoreSource);
  dom.window.eval(sharedSource);
  dom.window.eval(contentSource);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(sourcePages, [1]);
  assert.equal(dom.window.document.querySelectorAll('[data-nlc-api-tile="true"]').length, 3);

  dom.window.document.querySelector('[data-nlc-api-tile="true"] [data-nlc-action="block-author"]').click();
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.deepEqual(sourcePages, [1, 5]);
  assert.equal(dom.window.document.querySelectorAll('[data-nlc-api-tile="true"]').length, 2);
  assert.match(dom.window.document.querySelector('[data-nlc-api-tile="true"]').textContent, /Next partial result/);
});

test("saved backlog cursors never suppress a fresh page-one check and retain previous-batch history", async t => {
  const dom = new JSDOM(`<!doctype html><body>
    <div data-e2eid="result-count">4,000 results</div>
    <div class="mods-grid">${tile(1, "NativeAuthor", 1)}</div>
  </body>`, {
    url: "https://www.nexusmods.com/games/skyrimspecialedition/mods?sort=createdAt",
    runScripts: "outside-only"
  });
  t.after(() => dom.window.close());

  const context = JSON.stringify({
    mode: "stream",
    gameDomainName: "skyrimspecialedition",
    sort: "newest",
    sortDirection: "",
    filters: { languageNames: [], categoryNames: [] }
  });
  const stored = {
    schemaVersion: 4,
    nexusApiKey: "configured",
    blockedAuthors: [{ username: "AlreadyReviewed", userId: "999" }],
    reviewedAuthors: [],
    modDecisions: [],
    settings: { showPageStatus: true },
    streamCursors: {
      [context]: {
        page: 40,
        index: 0,
        batch: 12,
        history: [{ page: 30, index: 0, batch: 11 }]
      }
    }
  };
  const sourcePages = [];
  dom.window.browser = {
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async value => Object.assign(stored, structuredClone(value)),
        clear: async () => {}
      },
      onChanged: { addListener: () => {} }
    },
    runtime: {
      getManifest: () => ({ version: "test" }),
      sendMessage: async message => {
        if (message.type === "persist-stream-cursor" || message.type === "record-performance-diagnostic") return { ok: true };
        if (message.type !== "nexus-api-batch") return {};
        const page = message.request.cursor.page;
        sourcePages.push(page);
        return {
          ok: true,
          totalCount: 4000,
          streamEndPage: page,
          nextCursor: page === 1 ? { page: 2, index: 0, batch: 2 } : null,
          nodes: [{
            modId: page * 100,
            name: `Visible candidate from page ${page}`,
            uploader: { memberId: page, name: `Author${page}` },
            game: { domainName: "skyrimspecialedition" }
          }]
        };
      }
    }
  };

  dom.window.eval(apiCoreSource);
  dom.window.eval(sharedSource);
  dom.window.eval(contentSource);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(sourcePages, [1]);

  const resume = dom.window.document.querySelector('[data-nlc-action="curated-resume"]');
  assert.equal(resume.disabled, false);
  resume.click();
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.deepEqual(sourcePages, [1, 40]);

  const previous = dom.window.document.querySelector('[data-nlc-action="curated-prev"]');
  assert.equal(previous.disabled, false);
  previous.click();
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.deepEqual(sourcePages, [1, 40, 30]);
});

test("review stream automatically skips source pages that are already empty locally", async t => {
  const dom = new JSDOM(`<!doctype html><body>
    <div data-e2eid="result-count">160 results</div>
    <div class="mods-grid">${tile(1, "NativeAuthor", 1)}</div>
  </body>`, {
    url: "https://www.nexusmods.com/games/skyrimspecialedition/mods?sort=createdAt",
    runScripts: "outside-only"
  });
  t.after(() => dom.window.close());

  const stored = {
    schemaVersion: 4,
    nexusApiKey: "configured",
    blockedAuthors: [{ username: "AlreadyReviewed", userId: "999" }],
    reviewedAuthors: [],
    modDecisions: [],
    settings: { showPageStatus: true }
  };
  const sourcePages = [];
  dom.window.browser = {
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async value => Object.assign(stored, structuredClone(value)),
        clear: async () => {}
      },
      onChanged: { addListener: () => {} }
    },
    runtime: {
      getManifest: () => ({ version: "test" }),
      sendMessage: async message => {
        if (message.type === "persist-stream-cursor" || message.type === "record-performance-diagnostic") return { ok: true };
        if (message.type !== "nexus-api-batch") return {};
        sourcePages.push(message.request.cursor.page);
        return {
          ok: true,
          totalCount: 160,
          streamEndPage: 2,
          nextCursor: null,
          nodes: [{
            modId: 20,
            name: "Visible candidate",
            uploader: {
              memberId: 20,
              name: "VisibleAuthor"
            },
            game: { domainName: "skyrimspecialedition" }
          }]
        };
      }
    }
  };

  dom.window.eval(apiCoreSource);
  dom.window.eval(sharedSource);
  dom.window.eval(contentSource);
  await new Promise(resolve => setTimeout(resolve, 1200));

  assert.deepEqual(sourcePages, [1]);
  assert.match(dom.window.document.querySelector('[data-nlc-api-tile="true"]').textContent, /Visible candidate/);
  assert.equal(dom.window.document.body.textContent.includes("Continue to next source page"), false);
});
