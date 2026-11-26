const { execFile, spawn } = require('node:child_process');
const { join } = require('node:path');

function forMac(displayId) {
  const input = require('./build/input.node');
  const id = Number(displayId);
  return {
    ready: Promise.resolve(),
    close: () => input.reset(),
    send(message, receipt) {
      const { type, x = 0, y = 0, code, button, down = false, dx, dy } = message;
      switch (type) {
        case 'reset': input.reset(); break;
        case 'key': input.input(id, 0, 0, 0, code, down); break;
        case 'move': input.input(id, 1, x, y, 0, false); break;
        case 'button': input.input(id, 2, x, y, button, down); break;
        case 'wheel':
          input.input(id, 1, x, y, 0, false);
          input.input(id, 3, dx, dy, 0, false);
          break;
      }
      receipt?.();
    },
  };
}

function forWindows(bounds, onError) {
  const args = [bounds.x, bounds.y, bounds.width, bounds.height].map(String);
  const proc = spawn(join(__dirname, 'build/input.exe'), args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let closing = false;
  let started = false;
  let output = '';
  let receiptSequence = 0;
  const receipts = new Map();

  function close() {
    if (closing) return;
    closing = true;
    receipts.clear();
    proc.stdin.destroy();
    const timer = setTimeout(() => proc.kill(), 1500).unref();
    proc.once('close', () => clearTimeout(timer));
  }

  const ready = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      close();
      reject(new Error('Windows 键鼠组件启动超时'));
    }, 3000);
    const fail = () => {
      clearTimeout(deadline);
      if (started) {
        if (!closing) {
          close();
          onError();
        }
      } else {
        reject(new Error('Windows 键鼠组件无法启动'));
      }
    };
    proc.on('error', fail);
    proc.on('close', fail);
    proc.stdin.on('error', fail);
    proc.stdout.on('data', bytes => {
      output += bytes.toString();
      let newline;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline).trim();
        output = output.slice(newline + 1);
        if (!started && line === 'ready') {
          started = true;
          clearTimeout(deadline);
          resolve();
        } else if (started && /^ack \d+$/.test(line)) {
          const id = Number(line.slice(4));
          const callback = receipts.get(id);
          receipts.delete(id);
          callback?.();
        }
      }
    });
  });

  return {
    close, ready,
    send(message, receipt) {
      if (closing) return;
      if (proc.stdin.writableLength > 4096) {
        close();
        onError();
        return;
      }
      if (receipt) {
        const id = ++receiptSequence;
        receipts.set(id, receipt);
        while (receipts.size > 16) receipts.delete(receipts.keys().next().value);
        message = { ...message, receipt: id };
      }
      proc.stdin.write(JSON.stringify(message) + '\n');
    },
  };
}

module.exports = function createInput(capture, bounds, onError) {
  if (process.platform === 'darwin') return forMac(capture.display);
  if (process.platform === 'win32') return forWindows(bounds, onError);
  throw new Error('本机平台不支持原生键鼠控制');
};

module.exports.shortcut = function shortcut(driver, code) {
  const modifier = process.platform === 'darwin' ? 'MetaLeft' : 'ControlLeft';
  driver.send({ type: 'reset' });
  for (const [keyCode, down] of [[modifier, true], [code, true], [code, false], [modifier, false]]) {
    driver.send({ type: 'key', code: keyCode, down });
  }
};

module.exports.lock = async function lock() {
  if (process.platform === 'darwin') {
    if (!require('./build/input.node').lockScreen()) throw new Error('macOS 辅助功能权限未就绪，无法自动锁屏');
    return;
  }
  if (process.platform !== 'win32') throw new Error('此平台不支持会话后锁屏');
  return new Promise((resolve, reject) => {
    execFile(join(__dirname, 'build/input.exe'), ['--lock'], { windowsHide: true }, error => {
      if (error) reject(new Error('Windows 未接受锁屏请求'));
      else resolve();
    });
  });
};
