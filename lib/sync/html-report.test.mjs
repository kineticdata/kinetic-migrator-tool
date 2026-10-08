// lib/sync/html-report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderHtml } from './html-report.mjs';

const INPUT = {
  title: 'Compare dev → prod',
  subtitle: 'raw',
  generatedAt: '2026-01-01T00:00:00.000Z',
  summary: [{ label: 'differs', count: 1 }, { label: 'same', count: 1 }],
  groups: [
    { type: 'teams', items: [
      { key: 'teams/Ops', status: 'differs', diff: [{ path: 'description', from: '<script>alert(1)</script>', to: 'b' }] },
      { key: 'teams/Same', status: 'same', diff: [] },
    ] },
    { type: 'space', items: [{ key: 'space', status: 'same', diff: [] }] },
  ],
  warnings: ['careful & <ok>'],
  errors: [],
};

test('escapeHtml escapes the five HTML-special characters', () => {
  assert.equal(escapeHtml(`<script>alert(1)</script>&"'`), '&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;');
  assert.equal(escapeHtml(undefined), '');
});

test('renderHtml escapes values and pulls in nothing external', () => {
  const html = renderHtml(INPUT);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /careful &amp; &lt;ok&gt;/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /<title>Environment Comparison<\/title>/);
});

test('renderHtml has dark mode, one details per group, and a show-unchanged toggle', () => {
  const html = renderHtml(INPUT);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.equal(html.match(/<details/g).length, 2);
  assert.match(html, /<details open[^>]*>\s*<summary>[^]*teams/);
  assert.match(html, /<details(?! open)[^>]*>\s*<summary>[^]*space/);
  assert.match(html, /<input type="checkbox" id="show-unchanged"(?![^>]*checked)/);
  assert.match(html, /class="item unchanged"[^>]*>[^]*teams\/Same/);
  assert.match(html, /<table/);
});

const toneOf = (status, tone) => {
  const html = renderHtml({ ...INPUT, groups: [{ type: 'teams', items: [{ key: 'teams/X', status, tone, diff: [] }] }] });
  return html.match(/<span class="status ([a-z]+)">/)[1];
};

test('tone: target-only is neutral, source-only and create are added, drift and manual need attention', () => {
  assert.equal(toneOf('only in prod'), 'neutral');
  assert.equal(toneOf('only in dev', 'added'), 'added');
  assert.equal(toneOf('only in prod', 'neutral'), 'neutral');
  assert.equal(toneOf('create'), 'added');
  assert.equal(toneOf('update'), 'changed');
  assert.equal(toneOf('differs'), 'changed');
  assert.equal(toneOf('skip-drift'), 'attention');
  assert.equal(toneOf('manual'), 'attention');
  assert.equal(toneOf('unchanged'), 'unchanged');
});

test('attention tone is defined in light and dark and styled', () => {
  const html = renderHtml(INPUT);
  assert.equal(html.match(/--attention:/g).length, 2);
  assert.equal(html.match(/--attention-bg:/g).length, 2);
  assert.match(html, /\.status\.attention \{/);
});
