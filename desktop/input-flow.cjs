function forwardInput(driver, state, data, receipt, now = performance.now()) {
  const { type, x, y, down, code, button, dx, dy } = data;
  let message;
  if (type === 'reset') message = { type };
  else if (type === 'key' && typeof code === 'string' && /^[A-Za-z0-9]{1,24}$/.test(code) && typeof down === 'boolean') {
    message = { type, code, down };
  } else if (typeof x === 'number' && typeof y === 'number' && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
    if (type === 'move') message = { type, x, y };
    else if (type === 'button' && Number.isInteger(button) && button >= 0 && button <= 2 && typeof down === 'boolean') {
      message = { type, x, y, button, down };
    } else if (type === 'wheel' && Number.isFinite(dx) && Number.isFinite(dy)) message = { type, x, y, dx, dy };
  }
  if (!message) return false;
  const motion = type === 'move' || type === 'wheel';
  const bucket = motion ? 'motionAllowance' : 'reliableAllowance';
  const previous = motion ? 'lastMotion' : 'lastReliable';
  state[bucket] = Math.min(240, (state[bucket] ?? 240) + Math.max(0, now - (state[previous] ?? now)) * 0.18);
  state[previous] = now;
  if (type !== 'reset' && down !== false && state[bucket] < 1) {
    state.rateLimited = (state.rateLimited ?? 0) + 1;
    return false;
  }
  state[bucket] = Math.max(0, state[bucket] - 1);
  state.dispatched = (state.dispatched ?? 0) + 1;
  driver.send(message, receipt);
  return true;
}

module.exports = forwardInput;
