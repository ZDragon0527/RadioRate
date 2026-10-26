import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fetchPlantXml, formatError, retryAfterMs, parseResponse } from './fetch-radiation.mjs';
import { renderSummary } from './summarize-radiation.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./fetch-radiation.mjs', import.meta.url));
const options = { endpoint: 'https://apis.data.go.kr/B552041/radiorate/getradiorate', serviceKey: 'test+/=key' };
const xml = '<response><resultCode>00</resultCode><item><name>A</name><value>0.093</value></item></response>';
const networkError = () => new TypeError('fetch failed', {
  cause: new AggregateError([Object.assign(new Error('connection timed out'), { code: 'UND_ERR_CONNECT_TIMEOUT' })])
});

function harness(fetchImpl) {
  const delays = [], logs = [];
  return { delays, logs, deps: { fetchImpl, sleepImpl: async ms => delays.push(ms), log: s => logs.push(s), random: () => 0 } };
}

test('transient connection failure retries and recovers; records nested cause and duration', async () => {
  let calls = 0;
  const h = harness(async () => { if (++calls < 3) throw networkError(); return new Response(xml); });
  assert.equal(await fetchPlantXml('WS', options, h.deps), xml);
  assert.equal(calls, 3);
  assert.deepEqual(h.delays, [1000, 2000]);
  assert.match(h.logs[0], /1\/3, \d+ms: TypeError: fetch failed.*UND_ERR_CONNECT_TIMEOUT/);
});

test('persistent connection failure stops at three attempts', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; throw networkError(); });
  await assert.rejects(fetchPlantXml('WS', options, h.deps), /fetch failed/);
  assert.equal(calls, 3);
  assert.equal(h.delays.length, 2);
});

test('429 and 5xx retry, respect Retry-After; long Retry-After ends this run', async () => {
  for (const status of [429, 500, 503]) {
    let calls = 0;
    const h = harness(async () => ++calls === 1
      ? new Response('not logged', { status, headers: { 'Retry-After': '3' } }) : new Response(xml));
    assert.equal(await fetchPlantXml('WS', options, h.deps), xml);
    assert.deepEqual(h.delays, [3000]);
  }
  const h = harness(async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
  await assert.rejects(fetchPlantXml('WS', options, h.deps), /HTTP 429/);
  assert.deepEqual(h.delays, []);
  const now = Date.parse('2026-10-26T09:50:00Z');
  assert.equal(retryAfterMs('Mon, 26 Oct 2026 09:50:05 GMT', now), 5000);
  assert.equal(retryAfterMs('bad header', now), null);
});

test('HTTP authentication errors, TLS validation and programmer errors are not retried', async () => {
  for (const makeResponse of [
    () => new Response('secret must not be logged', { status: 401 }),
    () => new Response('secret must not be logged', { status: 403 }),
    () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('TLS certificate'), { code: 'CERT_HAS_EXPIRED' }) }); },
    () => { throw new TypeError('invalid argument'); }
  ]) {
    let calls = 0;
    const h = harness(async () => { calls++; return makeResponse(); });
    await assert.rejects(fetchPlantXml('WS', options, h.deps));
    assert.equal(calls, 1);
    assert.deepEqual(h.delays, []);
    assert.ok(!h.logs.join('\n').includes('secret must not be logged'));
  }
});

test('request timeout is retried, including a failure while reading the body', async () => {
  let calls = 0;
  const h = harness(async (_url, { signal }) => {
    calls++;
    return { ok: true, text: () => new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('test deadline')), 1000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }) };
  });
  await assert.rejects(fetchPlantXml('WS', options, { ...h.deps, timeoutMs: 5 }), { name: 'TimeoutError' });
  assert.equal(calls, 3);
});

test('gateway / XML validation errors are not repeated by the request layer', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return new Response('<returnReasonCode>30</returnReasonCode><returnAuthMsg>INVALID</returnAuthMsg>'); });
  const body = await fetchPlantXml('WS', options, h.deps);
  assert.throws(() => parseResponse(body), /게이트웨이 오류 30/);
  assert.equal(calls, 1);
  assert.throws(() => parseResponse('<response/>'), /측정값/);
});

test('missing service key does not make a request; encoded keys are encoded exactly once', async () => {
  let calls = 0;
  const h = harness(async url => {
    calls++;
    assert.equal(new URL(url).searchParams.get('serviceKey'), options.serviceKey);
    assert.equal(new URL(url).searchParams.get('genName'), 'WS');
    return new Response(xml);
  });
  await assert.rejects(fetchPlantXml('WS', { ...options, serviceKey: ' ' }, h.deps), /설정되지/);
  assert.equal(calls, 0);
  await fetchPlantXml('WS', { ...options, serviceKey: encodeURIComponent(options.serviceKey) }, h.deps);
  assert.equal(calls, 1);
});

test('error formatting masks raw / encoded keys, query strings, URL credentials and cycles', () => {
  const key = 'opaque+/=key';
  const err = networkError();
  err.cause.errors.push(new Error(`${key} ${encodeURIComponent(key)} https://user:pass@example.com/path?unknown=private`));
  err.cause.errors.push(err);
  const message = formatError(err, encodeURIComponent(key));
  assert.match(message, /UND_ERR_CONNECT_TIMEOUT/);
  for (const secret of [key, encodeURIComponent(key), 'user:pass', 'unknown=private']) assert.ok(!message.includes(secret));
});

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'radiorate-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const samples = path.join(dir, 'samples');
  await mkdir(samples);
  for (const code of ['WS', 'KR', 'SU', 'YK', 'UJ']) await writeFile(path.join(samples, `${code}.xml`), xml);
  const output = path.join(dir, 'radiation.json');
  const githubOutput = path.join(dir, 'github-output');
  const env = { ...process.env, RADIORATE_SERVICE_KEY: options.serviceKey, GITHUB_OUTPUT: githubOutput };
  return { dir, samples, output, githubOutput, env };
}

test('CLI full/partial/all-failure runs preserve last success and history; exit 2 only with fallback JSON', async t => {
  const f = await fixture(t);
  const args = ['--sample-dir', f.samples, '--out', f.output];
  await exec(process.execPath, [script, ...args], { env: f.env });
  const prev = path.join(f.dir, 'prev.json');
  await writeFile(prev, await readFile(f.output));
  const first = JSON.parse(await readFile(prev, 'utf8'));
  await writeFile(path.join(f.samples, 'WS.xml'), '<response/>');
  await exec(process.execPath, [script, ...args, '--prev', prev], { env: f.env });
  let data = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(data.plants.WS.stale, true);
  assert.deepEqual(data.plants.WS.stations, first.plants.WS.stations);
  assert.equal(data.plants.WS.lastSuccessAt, first.plants.WS.lastSuccessAt);
  assert.equal(data.plants.KR.ok, true);
  for (const code of ['KR', 'SU', 'YK', 'UJ']) await writeFile(path.join(f.samples, `${code}.xml`), '<response/>');
  await assert.rejects(exec(process.execPath, [script, ...args, '--prev', prev], { env: f.env }), { code: 2 });
  data = JSON.parse(await readFile(f.output, 'utf8'));
  assert.deepEqual(data.history, first.history);
  assert.equal(Object.values(data.plants).every(p => !p.ok && p.stale), true);
  assert.match(await readFile(f.githubOutput, 'utf8'), /ok_count=0\nfailed_count=5/);
});

test('CLI missing previous values remains empty; unexpected write error exits 1', async t => {
  const f = await fixture(t);
  for (const code of ['WS', 'KR', 'SU', 'YK', 'UJ']) await writeFile(path.join(f.samples, `${code}.xml`), '<response/>');
  await assert.rejects(exec(process.execPath, [script, '--sample-dir', f.samples, '--out', f.output], { env: f.env }), { code: 2 });
  const data = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(data.plants.WS.stale, false);
  assert.deepEqual(data.plants.WS.stations, []);
  await rm(f.githubOutput);
  await assert.rejects(exec(process.execPath, [script, '--sample-dir', f.samples, '--out', f.dir], { env: f.env }), { code: 1 });
  await assert.rejects(readFile(f.githubOutput), { code: 'ENOENT' });
});

test('published JSON remains valid and contains no echoed key', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.samples, 'WS.xml'), `<returnAuthMsg>${options.serviceKey}</returnAuthMsg>`);
  await exec(process.execPath, [script, '--sample-dir', f.samples, '--out', f.output], { env: f.env });
  const content = await readFile(f.output, 'utf8');
  assert.ok(!content.includes(options.serviceKey));
  assert.equal(JSON.parse(content).plants.WS.ok, false);
});

test('summary distinguishes fallback / no data / fatal and deployment failure; escapes API text', () => {
  const data = { fetchedAt: '2026-10-26T09:50:00Z', plants: {
    WS: { ok: false, stale: true, stations: [{}], lastSuccessAt: '2026-10-26T09:40:00Z', error: '<script> | error\nnext' },
    KR: { ok: false, stale: false, stations: [], lastSuccessAt: null, error: 'fetch failed' }
  } };
  const opts = { collectionResult: 'all_failed', collectOutcome: 'success', deploymentOutcome: 'failure', diagnosticsOutcome: 'success' };
  const summary = renderSummary(data, opts);
  assert.match(summary, /수집 성공: 0\/2/);
  assert.match(summary, /Pages 배포: failure/);
  assert.match(summary, /직전 값 유지/);
  assert.match(summary, /보존할 값 없음/);
  assert.ok(!summary.includes('<script>'));
  assert.match(summary, /&#124;/);
  const fatal = renderSummary(data, { ...opts, collectionResult: 'fatal' });
  assert.match(fatal, /결과 파일을 생성하지 못했거나/);
  assert.ok(!fatal.includes('직전 값 유지'));
});

test('summary CLI appends to the Actions summary and handles fatal runs without a JSON file', async t => {
  const f = await fixture(t);
  const summaryScript = fileURLToPath(new URL('./summarize-radiation.mjs', import.meta.url));
  const summaryPath = path.join(f.dir, 'summary.md');
  await exec(process.execPath, [script, '--sample-dir', f.samples, '--out', f.output], { env: f.env });
  await writeFile(summaryPath, 'Existing summary\n');
  await exec(process.execPath, [summaryScript, f.output], { env: {
    ...f.env, GITHUB_STEP_SUMMARY: summaryPath, COLLECTION_RESULT: 'success',
    COLLECT_OUTCOME: 'success', DEPLOYMENT_OUTCOME: 'success'
  } });
  assert.match(await readFile(summaryPath, 'utf8'), /Existing summary\n.*\n[\s\S]*수집 성공: 5\/5/);
  await exec(process.execPath, [summaryScript, path.join(f.dir, 'missing.json')], { env: {
    ...f.env, GITHUB_STEP_SUMMARY: summaryPath, COLLECTION_RESULT: 'fatal',
    COLLECT_OUTCOME: 'failure', DEPLOYMENT_OUTCOME: 'skipped'
  } });
  assert.match(await readFile(summaryPath, 'utf8'), /Pages 배포: skipped/);
});
