import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPlist, renderUnit, renderVbs, LAUNCHD_LABEL } from '../bridge/src/service';

test('launchd plist starts at login, restarts on failure and escapes paths', () => {
  const p = renderPlist('/usr/local/bin/node', '/Users/me/.obspec/bridge/obspec-bridge.mjs', 27123, '/Users/me/A & B/bridge.log');
  assert.match(p, new RegExp(`<string>${LAUNCHD_LABEL}</string>`));
  assert.match(p, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(p, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(p, /<string>run<\/string>\s*<string>--service<\/string>\s*<string>--port<\/string>\s*<string>27123<\/string>/);
  assert.match(p, /A &amp; B/);
});

test('systemd unit and windows startup script carry the same command', () => {
  assert.match(renderUnit('/usr/bin/node', '/home/me/.obspec/bridge/obspec-bridge.mjs', 27123), /ExecStart=\/usr\/bin\/node \/home\/me\/.obspec\/bridge\/obspec-bridge.mjs run --service --port 27123/);
  assert.match(renderVbs('C:\\node.exe', 'C:\\Users\\me\\.obspec\\bridge\\obspec-bridge.mjs', 27123), /""C:\\node.exe"" ""C:\\Users\\me\\.obspec\\bridge\\obspec-bridge.mjs"" run --service --port 27123", 0, False/);
});
