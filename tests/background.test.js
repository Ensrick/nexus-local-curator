"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourceRoot = path.join(__dirname, "..", "extension", "src");
const apiCoreSource = fs.readFileSync(path.join(sourceRoot, "api-core.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(sourceRoot, "background.js"), "utf8");

test("an empty review scan pauses after fifty 80-result source pages", async () => {
  let messageListener = null;
  let requestCount = 0;
  const stored = {
    nexusApiKey: "configured",
    blockedAuthors: [{ username: "BlockedAuthor", userId: "999" }],
    reviewedAuthors: [],
    modDecisions: []
  };
  const context = {
    AbortController,
    URL,
    console,
    performance,
    setTimeout,
    clearTimeout,
    browser: {
      runtime: {
        getManifest: () => ({ version: "test" }),
        onMessage: { addListener: listener => { messageListener = listener; } },
        openOptionsPage: async () => {}
      },
      action: { onClicked: { addListener: () => {} } },
      tabs: {
        create: async () => ({}),
        onRemoved: { addListener: () => {} }
      },
      storage: {
        local: {
          get: async key => key === "nexusApiKey" ? { nexusApiKey: stored.nexusApiKey } : structuredClone(stored),
          set: async () => {}
        }
      }
    },
    fetch: async (_url, options) => {
      requestCount += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.variables.count, 80);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          data: {
            mods: {
              totalCount: 136000,
              nodes: [{
                modId: requestCount,
                name: `Blocked mod ${requestCount}`,
                uploader: { memberId: 999, name: "BlockedAuthor" },
                game: { domainName: "skyrimspecialedition" }
              }]
            }
          }
        })
      };
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(apiCoreSource, context);
  vm.runInContext(backgroundSource, context);

  assert.equal(typeof messageListener, "function");
  const response = await messageListener({
    type: "nexus-api-batch",
    request: {
      mode: "stream",
      gameDomainName: "skyrimspecialedition",
      cursor: { page: 1, index: 0, batch: 1 }
    }
  }, { tab: { id: 10 } });

  assert.equal(requestCount, 50);
  assert.equal(response.ok, true);
  assert.equal(response.scanPaused, true);
  assert.equal(response.streamStartPage, 1);
  assert.equal(response.streamEndPage, 50);
  assert.equal(response.nextCursor.page, 51);
  assert.equal(response.nodes.length, 0);
});

test("the review stream treats a trimmed mod as decided, exactly like a kept mod", async () => {
  let messageListener = null;
  const stored = {
    nexusApiKey: "configured",
    blockedAuthors: [],
    reviewedAuthors: [],
    modDecisions: [
      { game: "skyrimspecialedition", modId: "1", status: "keep" },
      { game: "skyrimspecialedition", modId: "2", status: "trim" },
      { game: "skyrimspecialedition", modId: "3", status: "skip" }
    ]
  };
  const node = modId => ({
    modId,
    name: `Mod ${modId}`,
    uploader: { memberId: modId * 10, name: `Author${modId}` },
    game: { domainName: "skyrimspecialedition" }
  });
  const context = {
    AbortController,
    URL,
    console,
    performance,
    setTimeout,
    clearTimeout,
    browser: {
      runtime: {
        getManifest: () => ({ version: "test" }),
        onMessage: { addListener: listener => { messageListener = listener; } },
        openOptionsPage: async () => {}
      },
      action: { onClicked: { addListener: () => {} } },
      tabs: {
        create: async () => ({}),
        onRemoved: { addListener: () => {} }
      },
      storage: {
        local: {
          get: async key => key === "nexusApiKey" ? { nexusApiKey: stored.nexusApiKey } : structuredClone(stored),
          set: async () => {}
        }
      }
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        data: { mods: { totalCount: 4, nodes: [node(1), node(2), node(3), node(4)] } }
      })
    })
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(apiCoreSource, context);
  vm.runInContext(backgroundSource, context);

  const request = {
    mode: "stream",
    gameDomainName: "skyrimspecialedition",
    cursor: { page: 1, index: 0, batch: 1 }
  };
  const hidden = await messageListener({ type: "nexus-api-batch", request }, { tab: { id: 20 } });
  assert.deepEqual(
    Array.from(hidden.nodes, item => item.modId),
    [4],
    "keep, trim, and skip are all decided"
  );

  const withSkipped = await messageListener({
    type: "nexus-api-batch",
    request: { ...request, showSkipped: true }
  }, { tab: { id: 21 } });
  assert.deepEqual(
    Array.from(withSkipped.nodes, item => item.modId),
    [3, 4],
    "Show Skipped reveals only skipped mods, never trimmed or kept ones"
  );
});

test("Manage removals are consolidated into one background storage update", async () => {
  let messageListener = null;
  let storageWrites = 0;
  const stored = {
    blockedAuthors: [
      { username: "BlockedOne", userId: "1" },
      { username: "BlockedTwo", userId: "2" }
    ],
    reviewedAuthors: [
      { username: "HiddenOne", userId: "3" },
      { username: "HiddenTwo", userId: "4" }
    ],
    modDecisions: []
  };
  const context = {
    AbortController,
    URL,
    console,
    performance,
    setTimeout,
    clearTimeout,
    browser: {
      runtime: {
        getManifest: () => ({ version: "test" }),
        onMessage: { addListener: listener => { messageListener = listener; } },
        openOptionsPage: async () => {}
      },
      action: { onClicked: { addListener: () => {} } },
      tabs: {
        create: async () => ({}),
        onRemoved: { addListener: () => {} }
      },
      storage: {
        local: {
          get: async keys => Object.fromEntries(keys.map(key => [key, structuredClone(stored[key])])),
          set: async value => {
            storageWrites += 1;
            Object.assign(stored, structuredClone(value));
          }
        }
      }
    },
    fetch: async () => { throw new Error("Unexpected fetch"); }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(apiCoreSource, context);
  vm.runInContext(backgroundSource, context);

  const first = messageListener({
    type: "persist-manage-operation",
    entryType: "author",
    operation: "remove",
    entry: stored.blockedAuthors[0]
  }, {});
  const second = messageListener({
    type: "persist-manage-operation",
    entryType: "reviewed-author",
    operation: "remove",
    entry: stored.reviewedAuthors[0]
  }, {});

  assert.equal(first.queued, true);
  assert.equal(second.queued, true);
  assert.equal(storageWrites, 0);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(storageWrites, 1);
  assert.deepEqual(stored.blockedAuthors.map(author => author.username), ["BlockedTwo"]);
  assert.deepEqual(stored.reviewedAuthors.map(author => author.username), ["HiddenTwo"]);
  assert.equal(stored.recoveryEntry.entry.username, "HiddenOne");
  assert.equal(stored.recoveryEntry.operation, "restore");
});
