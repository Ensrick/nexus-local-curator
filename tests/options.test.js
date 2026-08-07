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
