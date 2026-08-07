"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const Unblock = require("../extension/src/unblock-core.js");

test("finds only author unblock controls inside the blocked-author section", () => {
  const dom = new JSDOM(`
    <section>
      <h2>Blocked tags</h2>
      <button aria-label="Remove Weapons">×</button>
    </section>
    <section id="authors">
      <h2>Currently blocked authors</h2>
      <div><span>Alice</span><button aria-label="Unblock Alice">×</button></div>
      <div><span>Bob</span><button title="Remove Bob">×</button></div>
      <button>Block an author</button>
    </section>`);

  const controls = Unblock.findUnblockControls(dom.window.document);
  assert.equal(controls.length, 2);
  assert.deepEqual(controls.map(Unblock.controlName), ["Unblock Alice ×", "Remove Bob ×"]);
});

test("does not click ambiguous controls when the author section is absent", () => {
  const dom = new JSDOM(`<button aria-label="Remove account">Remove</button>`);
  assert.deepEqual(Unblock.findUnblockControls(dom.window.document), []);
});

test("recognises the symbol-only remove buttons used by Nexus author chips", () => {
  const dom = new JSDOM(`
    <section id="authors">
      <div><span>Currently blocked authors</span></div>
      <div class="author-chip"><span>Alice</span><button>✕</button></div>
      <div class="author-chip"><span>Bob</span><button aria-label="Close">×</button></div>
    </section>`);
  const controls = Unblock.findUnblockControls(dom.window.document);
  assert.equal(controls.length, 2);
});

test("recognises red username buttons in the current Nexus blocked-author list", () => {
  const dom = new JSDOM(`
    <section id="authors">
      <h2>Blocked authors</h2>
      <div class="author-list">
        <button style="background-color: rgb(180, 45, 55)">Alice</button>
        <button class="danger">BobTheBuilder</button>
      </div>
      <button style="background-color: rgb(30, 30, 30)">Block an author</button>
    </section>`);
  const controls = Unblock.findUnblockControls(dom.window.document);
  assert.deepEqual(controls.map(control => control.textContent.trim()), ["Alice", "BobTheBuilder"]);
});

test("recognises the current Nexus Ignored users section", () => {
  const dom = new JSDOM(`
    <section id="ignored-users">
      <h2>Ignored users</h2>
      <p>Ignoring a user hides their content and activity from you.</p>
      <strong>IGNORED USERS</strong>
      <div class="ignored-list">
        <button style="color: rgb(190, 45, 55)">Alice</button>
        <button data-variant="danger">Bob</button>
      </div>
      <button>Ignore a user</button>
    </section>`);
  const controls = Unblock.findUnblockControls(dom.window.document);
  assert.deepEqual(controls.map(control => control.textContent.trim()), ["Alice", "Bob"]);
});

test("excludes a server-provided remove-all control", () => {
  const dom = new JSDOM(`
    <section>
      <h2>Blocked authors</h2>
      <button>Remove all</button>
      <button aria-label="Remove Alice">×</button>
    </section>`);
  const controls = Unblock.findUnblockControls(dom.window.document);
  assert.equal(controls.length, 1);
  assert.match(Unblock.controlName(controls[0]), /Alice/);
});

test("detects visible error notices", () => {
  const dom = new JSDOM(`<div role="alert">Too many requests. Try later.</div>`);
  assert.equal(Unblock.pageShowsFailure(dom.window.document), true);
});
