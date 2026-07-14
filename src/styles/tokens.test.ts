import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const indexCss = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
const switchHtml = readFileSync(
  fileURLToPath(new URL('../../public/leocodebox-switch.html', import.meta.url)),
  'utf8',
);

// The two surfaces (React app + standalone switch page) keep their own variable
// systems, but the timing/easing tokens must stay byte-identical so motion feels
// like one product. These tokens guard that contract against drift.
const SHARED_MOTION_TOKENS: Array<[string, string]> = [
  ['--motion-fast', '120ms'],
  ['--motion-base', '200ms'],
  ['--motion-slow', '320ms'],
  ['--ease-out-quint', 'cubic-bezier(0.23, 1, 0.32, 1)'],
  ['--ease-in-out', 'cubic-bezier(0.65, 0, 0.35, 1)'],
];

test('index.css defines the ease + elevation tokens', () => {
  for (const token of ['--ease-out-quint', '--ease-in-out', '--elevation-1', '--elevation-2', '--elevation-3']) {
    assert.ok(indexCss.includes(token), `index.css missing ${token}`);
  }
  assert.ok(/\.skeleton\s*\{/.test(indexCss), 'index.css missing .skeleton base class');
  assert.ok(indexCss.includes('@keyframes skeleton-sweep'), 'index.css missing skeleton-sweep keyframe');
});

test('switch.html carries the same motion/ease token values as index.css', () => {
  for (const [token, value] of SHARED_MOTION_TOKENS) {
    const declaration = `${token}: ${value};`;
    assert.ok(indexCss.includes(declaration), `index.css missing "${declaration}"`);
    assert.ok(switchHtml.includes(declaration), `switch.html missing "${declaration}"`);
  }
});
