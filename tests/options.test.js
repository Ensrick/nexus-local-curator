"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const sourceRoot = path.join(__dirname, "..", "extension", "src");
const html = fs.readFileSync(path.join(sourceRoot, "options.html"), "utf8");
const sharedSource = fs.readFileSync(path.join(sourceRoot, "shared.js"), "utf8");
const optionsSource = fs.readFileSync(path.join(sourceRoot, "options.js"), "utf8");

test("Manage defaults to skipped mods and only renders the selected saved list", async t => {
  const dom = new JSDOM(html, {
    url: "moz-extension://nexus-local-curator/src/options.html",
    runScripts: "outside-only"
  });
  t.after(() => dom.window.close());

  const stored = {
    schemaVersion: 4,
    blockedAuthors: [
      { username: "BlockedOne", userId: "1" },
      { username: "BlockedTwo", userId: "2" }
    ],
    reviewedAuthors: [{ username: "HiddenOne", userId: "3" }],
    modDecisions: [
      { game: "skyrimspecialedition", modId: "10", status: "skip", title: "Skipped mod" },
      { game: "skyrimspecialedition", modId: "11", status: "keep", title: "Kept mod" }
    ],
    settings: { showPageStatus: true }
  };

  dom.window.browser = {
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async value => Object.assign(stored, structuredClone(value)),
        remove: async () => {}
      }
    },
    runtime: {
      getManifest: () => ({ version: "test" }),
      sendMessage: async () => ({ ok: true })
    }
  };

  dom.window.eval(sharedSource);
  dom.window.eval(optionsSource);
  await new Promise(resolve => setTimeout(resolve, 20));

  const document = dom.window.document;
  const view = document.getElementById("manage-view");
  assert.equal(view.value, "skip");
  assert.equal(view.querySelector('option[value="skip"]').textContent, "Skipped mods (1)");
  assert.equal(view.querySelector('option[value="hidden"]').textContent, "Hidden authors (1)");
  assert.equal(view.querySelector('option[value="excluded"]').textContent, "Excluded authors / blocked (2)");
  assert.equal(document.getElementById("excluded-authors-section").hidden, true);
  assert.equal(document.getElementById("authors-body").children.length, 0);
  assert.match(document.getElementById("mods-body").textContent, /Skipped mod/);
  assert.doesNotMatch(document.getElementById("mods-body").textContent, /Kept mod/);

  view.value = "excluded";
  view.dispatchEvent(new dom.window.Event("change"));
  assert.equal(document.getElementById("excluded-authors-section").hidden, false);
  assert.equal(document.getElementById("authors-body").children.length, 2);
  assert.equal(document.getElementById("mods-body").children.length, 0);

  view.value = "hidden";
  view.dispatchEvent(new dom.window.Event("change"));
  assert.equal(document.getElementById("hidden-authors-section").hidden, false);
  assert.match(document.getElementById("reviewed-authors-body").textContent, /HiddenOne/);
  assert.equal(document.getElementById("authors-body").children.length, 0);

  view.value = "all";
  view.dispatchEvent(new dom.window.Event("change"));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(stored.manageView, "all");
  assert.equal(document.getElementById("excluded-authors-section").hidden, false);
  assert.equal(document.getElementById("hidden-authors-section").hidden, false);
  assert.equal(document.getElementById("mod-decisions-section").hidden, false);
  assert.match(document.getElementById("authors-body").textContent, /BlockedOne/);
  assert.match(document.getElementById("reviewed-authors-body").textContent, /HiddenOne/);
  assert.match(document.getElementById("mods-body").textContent, /Skipped mod/);
  assert.match(document.getElementById("mods-body").textContent, /Kept mod/);
});

test("Manage lists trimmed mods in their own counted view", async t => {
  const dom = new JSDOM(html, {
    url: "moz-extension://nexus-local-curator/src/options.html",
    runScripts: "outside-only"
  });
  t.after(() => dom.window.close());

  const stored = {
    schemaVersion: 4,
    blockedAuthors: [],
    reviewedAuthors: [],
    modDecisions: [
      { game: "skyrimspecialedition", modId: "10", status: "skip", title: "Skipped mod" },
      { game: "skyrimspecialedition", modId: "11", status: "keep", title: "Kept mod" },
      { game: "skyrimspecialedition", modId: "12", status: "trim", title: "Trimmed mod", sourceUrl: "https://www.nexusmods.com/skyrimspecialedition/mods/12" },
      { game: "skyrimspecialedition", modId: "13", status: "trim", title: "Another trimmed mod" }
    ],
    settings: { showPageStatus: true }
  };

  dom.window.browser = {
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async value => Object.assign(stored, structuredClone(value)),
        remove: async () => {}
      }
    },
    runtime: {
      getManifest: () => ({ version: "test" }),
      sendMessage: async () => ({ ok: true })
    }
  };

  dom.window.eval(sharedSource);
  dom.window.eval(optionsSource);
  await new Promise(resolve => setTimeout(resolve, 20));

  const document = dom.window.document;
  const view = document.getElementById("manage-view");
  assert.equal(view.querySelector('option[value="trim"]').textContent, "Trimmed mods (2)");
  assert.match(document.getElementById("summary").textContent, /2 trim/);

  view.value = "trim";
  view.dispatchEvent(new dom.window.Event("change"));
  await new Promise(resolve => setTimeout(resolve, 0));

  const body = document.getElementById("mods-body");
  assert.equal(body.children.length, 2);
  assert.match(body.textContent, /Trimmed mod/);
  assert.doesNotMatch(body.textContent, /Kept mod|Skipped mod/);
  assert.equal(body.querySelector(".status-pill").textContent, "Trimmed");
  assert.equal(body.querySelector("a").href, "https://www.nexusmods.com/skyrimspecialedition/mods/12");
  assert.deepEqual(
    Array.from(body.querySelectorAll("[data-remove-type='mod']"), button => button.dataset.removeKey),
    ["skyrimspecialedition:13", "skyrimspecialedition:12"]
  );
  assert.equal(document.getElementById("manage-view-help").textContent, "2 trimmed mods.");

  view.value = "decisions";
  view.dispatchEvent(new dom.window.Event("change"));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(document.getElementById("mods-body").textContent, /Trimmed mod/);
  assert.match(document.getElementById("mods-body").textContent, /Kept mod/);
});

test("Manage removes a hidden author without rebuilding the large table or awaiting storage", async t => {
  const dom = new JSDOM(html, {
    url: "moz-extension://nexus-local-curator/src/options.html",
    runScripts: "outside-only"
  });
  t.after(() => dom.window.close());

  const stored = {
    schemaVersion: 4,
    blockedAuthors: [],
    reviewedAuthors: Array.from({ length: 1200 }, (_, index) => ({
      username: `Hidden${String(index).padStart(4, "0")}`,
      userId: String(index + 1),
      addedAt: "2026-08-14T00:00:00.000Z"
    })),
    modDecisions: [],
    settings: { showPageStatus: true }
  };
  const runtimeMessages = [];
  let storageWrites = 0;
  dom.window.browser = {
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async value => {
          storageWrites += 1;
          Object.assign(stored, structuredClone(value));
        },
        remove: async () => {}
      }
    },
    runtime: {
      getManifest: () => ({ version: "test" }),
      sendMessage: async message => {
        runtimeMessages.push(structuredClone(message));
        return { ok: true, queued: true };
      }
    }
  };

  dom.window.eval(sharedSource);
  dom.window.eval(optionsSource);
  await new Promise(resolve => setTimeout(resolve, 50));

  const document = dom.window.document;
  const view = document.getElementById("manage-view");
  view.value = "hidden";
  view.dispatchEvent(new dom.window.Event("change"));
  await new Promise(resolve => setTimeout(resolve, 0));
  storageWrites = 0;

  const body = document.getElementById("reviewed-authors-body");
  assert.equal(body.children.length, 1200);
  const nextRow = body.children[1];
  const startedAt = performance.now();
  body.querySelector("button").click();
  const clickDurationMs = performance.now() - startedAt;

  assert.equal(body.children.length, 1199);
  assert.equal(body.firstElementChild, nextRow, "existing rows should be retained instead of rebuilt");
  assert.ok(clickDurationMs < 200, `Remove click took ${clickDurationMs.toFixed(1)} ms`);
  assert.equal(storageWrites, 0, "the page must not write the full state during the click");
  assert.equal(document.querySelector('option[value="hidden"]').textContent, "Hidden authors (1,199)");
  assert.equal(runtimeMessages.at(-1).type, "persist-manage-operation");
  assert.equal(runtimeMessages.at(-1).operation, "remove");
  assert.equal(runtimeMessages.at(-1).entry.username, "Hidden0000");
});
