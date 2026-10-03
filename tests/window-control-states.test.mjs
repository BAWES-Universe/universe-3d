import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowControlStates } from '../src/window-control-states.js';

function button() {
  const attributes = new Map([['aria-label', 'Original accessible name']]), writes = [];
  return {
    attributes, writes, disabled: false, onclick() {},
    setAttribute(name, value) { attributes.set(name, value); writes.push([name, value]); },
  };
}

test('current supported surfaces synchronize independently of stale active flags', () => {
  const buttons = Object.fromEntries(['chat', 'people', 'profile', 'explore', 'connect', 'express'].map(name => [name, button()]));
  const state = { socialOpen: false, socialTab: 'chat', placesOpen: false, mediaOpen: false, expressOpen: false };
  const sync = createWindowControlStates([
    ...[['chat', 'chat'], ['people', 'people'], ['profile', 'settings']].map(([name, tab]) => ({
      button: buttons[name], controls: 'social', isOpen: () => state.socialOpen && state.socialTab === tab,
    })),
    { button: buttons.explore, controls: 'places', isOpen: () => state.placesOpen },
    { button: buttons.connect, controls: 'media', isOpen: () => state.mediaOpen },
    { button: buttons.express, controls: 'express', isOpen: () => state.expressOpen },
  ]);
  const expanded = () => Object.fromEntries(Object.entries(buttons).map(([name, node]) => [name, node.attributes.get('aria-expanded')]));
  assert.equal(sync(), 0);
  state.socialOpen = true;
  assert.equal(sync(), 1);
  assert.equal(expanded().chat, 'true');
  state.socialTab = 'people';
  assert.equal(sync(), 2);
  assert.equal(expanded().chat, 'false');
  assert.equal(expanded().people, 'true');
  state.socialTab = 'settings';
  state.mediaOpen = true;
  state.expressOpen = true;
  assert.equal(sync(), 4);
  assert.equal(expanded().profile, 'true');
  assert.equal(expanded().connect, 'true');
  assert.equal(expanded().express, 'true');
  state.socialOpen = false;
  state.placesOpen = true;
  assert.equal(sync(), 2);
  assert.equal(expanded().profile, 'false');
  assert.equal(expanded().explore, 'true');
  for (const [name, node] of Object.entries(buttons)) {
    assert.equal(node.attributes.get('aria-controls'), ['chat', 'people', 'profile'].includes(name) ? 'social' : { explore: 'places', connect: 'media', express: 'express' }[name]);
    assert.equal(node.attributes.has('data-window-control'), true);
    assert.equal(node.attributes.get('aria-label'), 'Original accessible name');
    assert.equal(node.attributes.has('aria-pressed'), false);
  }
});

test('repeated frame polls write nothing and preserve native disabled, handlers and existing attributes', () => {
  const node = button(), originalHandler = node.onclick;
  node.disabled = true;
  node.attributes.set('class', 'active');
  node.attributes.set('aria-pressed', 'true');
  let visible = true;
  const sync = createWindowControlStates([{ button: node, controls: 'panel', isOpen: () => visible }]);
  assert.equal(sync(), 1);
  node.writes.length = 0;
  for (let frame = 0; frame < 600; frame++) assert.equal(sync(), 0);
  assert.deepEqual(node.writes, []);
  visible = false;
  assert.equal(sync(), 1);
  assert.deepEqual(node.writes, [['aria-expanded', 'false']]);
  assert.equal(node.disabled, true);
  assert.equal(node.onclick, originalHandler);
  assert.equal(node.attributes.get('class'), 'active');
  assert.equal(node.attributes.get('aria-pressed'), 'true');
});

test('an unavailable surface closes its indicator without interrupting other controls', () => {
  const first = button(), second = button();
  let unavailable = false, secondOpen = false;
  const sync = createWindowControlStates([
    { button: first, controls: 'first-panel', isOpen: () => { if (unavailable) throw Error('Disposed'); return true; } },
    { button: second, controls: 'second-panel', isOpen: () => secondOpen },
  ]);
  assert.equal(sync(), 1);
  unavailable = true; secondOpen = true;
  assert.equal(sync(), 2);
  assert.equal(first.attributes.get('aria-expanded'), 'false');
  assert.equal(second.attributes.get('aria-expanded'), 'true');
  unavailable = false;
  assert.equal(sync(), 1);
  assert.equal(first.attributes.get('aria-expanded'), 'true');
});

test('invalid bindings fail before partially marking a control', () => {
  const node = button();
  assert.throws(() => createWindowControlStates([
    { button: node, controls: 'real-panel', isOpen: () => false },
    { button: button(), controls: '', isOpen: () => false },
  ]), TypeError);
  assert.deepEqual(node.writes, []);
});
