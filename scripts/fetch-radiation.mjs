// 공공데이터포털 "한국수력원자력(주)_원자력발전소 실시간 주변 방사선량" API를 호출해
// 웹앱이 읽는 정적 JSON(data/radiation.json)을 만든다.
//
// 사용법: RADIORATE_SERVICE_KEY=... node scripts/fetch-radiation.mjs --prev prev.json --out _site/data/radiation.json
//  - 인증키는 환경변수로만 받는다(GitHub Actions Secrets). 결과 파일에는 절대 기록하지 않는다.
//  - --prev: 직전 배포본의 radiation.json. 호출 실패한 본부는 직전 값을 유지(stale 표시)하고,
//            24시간 추이(history)를 이어 붙이는 데 쓴다.
//  - --sample-dir: 테스트용. <dir>/<genName>.xml 파일을 API 응답 대신 읽는다.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const PLANT_CODES = ['WS', 'KR', 'SU', 'YK', 'UJ'];
const DEFAULT_ENDPOINT = 'https://apis.data.go.kr/B552041/radiorate/getradiorate';
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

function decodeXmlEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function firstTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXmlEntities(m[1]).trim() : null;
}

// <item> 하위의 단순 태그를 모두 key/value로 읽는다. (응답 필드명이 바뀌어도 원본을 보존하기 위함)
function parseItems(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const fields = {};
    for (const f of m[1].matchAll(/<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
      fields[f[1]] = decodeXmlEntities(f[2]).trim();
    }
    items.push(fields);
  }
  return items;
}

function pick(fields, keys) {
  for (const k of keys) {
    if (fields[k] != null && fields[k] !== '') return fields[k];
  }
  return null;
}

// 응답 XML → 측정소 목록. 오류 응답이면 예외.
export function parseResponse(xml) {
  // 공공데이터포털 게이트웨이 오류(인증키 미등록, 트래픽 초과 등)
  const authMsg = firstTag(xml, 'returnAuthMsg');
  const reasonCode = firstTag(xml, 'returnReasonCode');
  if (authMsg || (reasonCode && reasonCode !== '00')) {
    throw new Error(`게이트웨이 오류 ${reasonCode || ''} ${authMsg || firstTag(xml, 'errMsg') || ''}`.trim());
  }
  const resultCode = firstTag(xml, 'resultCode');
  if (resultCode && !['00', '0', '0000'].includes(resultCode)) {
    throw new Error(`API 오류 ${resultCode} ${firstTag(xml, 'resultMsg') || ''}`.trim());
  }

  const warnings = [];
  const stations = [];
  for (const fields of parseItems(xml)) {
    const rawValue = pick(fields, ['value', 'radiorate', 'doseRate']);
    // 응답 값은 μSv/h(예: 0.093). 높은 값도 그대로 표시해야 하므로 환산·상한 제외를 하지 않는다.
    const value = rawValue == null || rawValue === '' ? NaN : Number(rawValue);
    if (!Number.isFinite(value) || value < 0) {
      warnings.push(`값 해석 불가 항목 제외: ${JSON.stringify(fields)}`);
      continue;
    }
    stations.push({
      name: pick(fields, ['name', 'locNo', 'stationCode']) || '',
      expl: pick(fields, ['expl', 'locName', 'stationName']) || pick(fields, ['name']) || '측정소',
      time: pick(fields, ['time', 'measTime', 'dataTime']) || '',
      value: Math.round(value * 1000) / 1000,
      raw: fields
    });
  }

  const totalCount = Number(firstTag(xml, 'totalCount'));
  if (Number.isFinite(totalCount) && totalCount > stations.length) {
    warnings.push(`totalCount(${totalCount})보다 수신 항목(${stations.length})이 적음 — 페이지 파라미터 확인 필요`);
  }
  if (stations.length === 0) {
    throw new Error('응답에 측정값(<item>)이 없습니다.');
  }
  return { stations, warnings };
}

function buildUrl(endpoint, serviceKey, genName) {
  // Encoding 키(%포함)와 Decoding 키 모두 허용: 한 번 디코딩한 뒤 표준 방식으로 다시 인코딩
  let key = serviceKey.trim();
  if (key.includes('%')) {
    try { key = decodeURIComponent(key); } catch { /* 그대로 사용 */ }
  }
  const url = new URL(endpoint);
  url.searchParams.set('serviceKey', key);
  url.searchParams.set('genName', genName);
  return url.toString();
}

async function fetchPlantXml(code, { endpoint, serviceKey, sampleDir }) {
  if (sampleDir) return readFile(path.join(sampleDir, `${code}.xml`), 'utf8');
  if (!serviceKey) throw new Error('인증키(RADIORATE_SERVICE_KEY)가 설정되지 않았습니다.');
  const res = await fetch(buildUrl(endpoint, serviceKey, code), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  return text;
}

async function readJson(file) {
  if (!file) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// 공개 JSON에 남는 오류 메시지에서 인증키(원문·인코딩·디코딩 형태)를 지운다.
function redactKey(message, serviceKey) {
  let out = String(message || '');
  const key = (serviceKey || '').trim();
  if (!key) return out;
  const variants = new Set([key, encodeURIComponent(key)]);
  try { variants.add(decodeURIComponent(key)); } catch { /* ignore */ }
  for (const v of variants) {
    if (v) out = out.split(v).join('***');
  }
  return out;
}

function average(stations) {
  if (!stations.length) return null;
  return Math.round((stations.reduce((s, x) => s + x.value, 0) / stations.length) * 1000) / 1000;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = args.out || 'data/radiation.json';
  const endpoint = process.env.RADIORATE_ENDPOINT || DEFAULT_ENDPOINT;
  const serviceKey = process.env.RADIORATE_SERVICE_KEY || '';
  const prev = await readJson(args.prev);
  const now = new Date();
  const fetchedAt = now.toISOString();

  const plants = {};
  let okCount = 0;
  for (const code of PLANT_CODES) {
    const prevPlant = prev?.plants?.[code];
    try {
      const xml = await fetchPlantXml(code, { endpoint, serviceKey, sampleDir: args['sample-dir'] });
      const { stations, warnings } = parseResponse(xml);
      plants[code] = { ok: true, stale: false, lastSuccessAt: fetchedAt, stations, warnings };
      okCount++;
      console.log(`[${code}] ${stations.length}개 측정소 수신`);
      warnings.forEach(w => console.warn(`[${code}] 경고: ${w}`));
    } catch (err) {
      // 실패 시 직전 수신값을 유지하되 stale로 표시한다. 직전 값도 없으면 빈 목록.
      const message = redactKey(err.message, serviceKey);
      plants[code] = {
        ok: false,
        stale: Boolean(prevPlant?.stations?.length),
        lastSuccessAt: prevPlant?.lastSuccessAt || null,
        stations: prevPlant?.stations || [],
        error: message
      };
      console.error(`[${code}] 수신 실패: ${message}`);
    }
  }

  // 24시간 추이: 이번에 새로 받은 본부 평균만 기록
  const point = { t: fetchedAt };
  for (const code of PLANT_CODES) {
    if (plants[code].ok) point[code] = average(plants[code].stations);
  }
  const history = (Array.isArray(prev?.history) ? prev.history : [])
    .filter(p => now - new Date(p.t) <= HISTORY_WINDOW_MS);
  if (okCount > 0) history.push(point);

  const result = {
    source: '공공데이터포털 한국수력원자력(주)_원자력발전소 실시간 주변 방사선량',
    endpoint,
    fetchedAt,
    plants,
    history
  };
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2));
  console.log(`저장: ${out} (성공 ${okCount}/${PLANT_CODES.length})`);

  // 전 본부 실패면 워크플로를 실패로 표시해 알림을 받게 한다(배포는 직전 값으로 계속 진행).
  if (okCount === 0) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
