import assert from 'node:assert/strict';
import test from 'node:test';
import forwardInput from '../desktop/input-flow.cjs';
import { InputReceiver } from '../public/input.js';
import { SessionPerformance, remotePerformanceSample } from '../public/performance.js';

function receiver() {
  const dispatched = [];
  const counters = { stale: 0, barrier: 0, deferred: 0, replayed: 0 };
  const input = new InputReceiver(7, message => dispatched.push(message.sequence), counters);
  const send = (type, sequence, after, epoch = 7) => input.receive({ type, sequence, after, epoch });
  return { dispatched, counters, send };
}

test('newest early drag motion is dispatched after its reliable edge', () => {
  const { dispatched, counters, send } = receiver();
  send('move', 3, 1);
  send('move', 4, 1);
  send('move', 2, 1);
  assert.deepEqual(dispatched, []);
  send('button', 1);
  assert.deepEqual(dispatched, [1, 4]);
  assert.equal(counters.replayed, 1);
  send('move', 3, 1);
  send('button', 5);
  send('move', 6, 1);
  assert.deepEqual(dispatched, [1, 4, 5]);
});

test('release, reset, epoch change and obsolete motion preserve input ordering', () => {
  const { dispatched, send } = receiver();
  send('move', 3, 1, 6);
  send('move', 3, 1);
  send('button', 1);
  send('button', 2);
  send('move', 7, 4);
  send('reset', 6);
  send('button', 4);
  send('move', 8, -1);
  assert.deepEqual(dispatched, [1, 3, 2, 6]);
});

test('motion saturation preserves reliable keys and button releases', () => {
  const sent = [];
  const state = {};
  const driver = { send: (message, receipt) => { sent.push(message); receipt?.(); } };
  for (let index = 0; index < 500; index++) forwardInput(driver, state, { type: 'move', x: .5, y: .5 }, undefined, 0);
  assert.equal(sent.length, 240);
  assert.equal(forwardInput(driver, state, { type: 'button', x: .5, y: .5, button: 0, down: true }, undefined, 0), true);
  for (let index = 0; index < 500; index++) forwardInput(driver, state, { type: 'key', code: 'KeyA', down: true }, undefined, 0);
  let receipt = false;
  assert.equal(forwardInput(driver, state, { type: 'button', x: .5, y: .5, button: 0, down: false }, () => { receipt = true; }, 0), true);
  assert.equal(receipt, true);
  assert.equal(forwardInput(driver, state, { type: 'key', code: 'KeyA', down: false }, undefined, 0), true);
  assert.equal(forwardInput(driver, state, { type: 'reset' }, undefined, 0), true);
  assert.equal(forwardInput(driver, state, { type: 'move', x: Infinity, y: .5 }, undefined, 2000), false);
  assert.equal(forwardInput(driver, state, { type: 'move', x: .5, y: .5 }, undefined, 2000), true);
});

test('performance summaries bound history and sanitize remote metadata', () => {
  const performance = new SessionPerformance({}, true);
  for (let index = 0; index < 800; index++) {
    performance.record({ rtt: index });
    performance.recordInputRoundTrip(index, index / 2);
  }
  const summary = performance.summary();
  assert.equal(summary.samples.length, 600);
  assert.equal(summary.input.roundTripMs.count, 256);
  assert.equal(summary.input.roundTripMs.max, 799);
  assert.deepEqual(remotePerformanceSample({ stats: { encodeMsPerFrame: 2, rtt: -3, secret: 'hidden' },
    capture: { main: { callbackFrames: 12, secret: 'hidden' } } }),
  { stats: { encodeMsPerFrame: 2 }, capture: { main: { callbackFrames: 12 } } });
  performance.close();
});
