import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function cell(value) {
  return String(value ?? '없음').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/`/g, '&#96;')
    .replace(/[\r\n]/g, ' ');
}

export function renderSummary(data, { collectionResult, collectOutcome, deploymentOutcome, diagnosticsOutcome }) {
  const lines = ['## 방사선량 수집 및 배포', '',
    `- 수집 단계: ${cell(collectOutcome || 'skipped')}`,
    `- Pages 배포: ${cell(deploymentOutcome || 'skipped')}`,
    `- 네트워크 진단: ${cell(diagnosticsOutcome || 'skipped')}`];
  if (!data || !['success', 'all_failed'].includes(collectionResult)) {
    lines.push('- 수집 결과 파일을 생성하지 못했거나 수집이 실행되지 않았습니다. 수집·선행 단계 로그를 확인하세요.');
  } else {
    const plants = Object.entries(data.plants);
    const ok = plants.filter(([, p]) => p.ok).length;
    lines.push(`- 수집 성공: ${ok}/${plants.length}`,
      `- 이번 수집 시도: ${cell(data.fetchedAt)} (UTC)`,
      '- 아래 마지막 성공 시각은 UTC이며, 한국 시각은 9시간을 더합니다.', '',
      '| 본부 | 수집 결과 | 측정소 수 | 마지막 성공 시각 | 실패 사유 |',
      '| --- | --- | ---: | --- | --- |');
    for (const [code, p] of plants) {
      const status = p.ok ? '성공' : p.stale ? '실패 · 직전 값 유지' : '실패 · 보존할 값 없음';
      lines.push(`| ${cell(code)} | ${status} | ${p.stations.length} | ${cell(p.lastSuccessAt)} | ${cell(p.error || '—')} |`);
    }
    if (ok === 0) lines.push('', '전 본부 수집 실패로 작업은 실패 처리됩니다. 배포 성공 여부는 위 Pages 배포 결과를 확인하세요.');
  }
  return lines.join('\n') + '\n';
}

async function main() {
  let data = null;
  if (['success', 'all_failed'].includes(process.env.COLLECTION_RESULT)) {
    data = JSON.parse(await readFile(process.argv[2], 'utf8'));
  }
  const summary = renderSummary(data, {
    collectionResult: process.env.COLLECTION_RESULT,
    collectOutcome: process.env.COLLECT_OUTCOME,
    deploymentOutcome: process.env.DEPLOYMENT_OUTCOME,
    diagnosticsOutcome: process.env.DIAGNOSTICS_OUTCOME
  });
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('수집·배포 결과 요약을 생성하지 못했습니다. 각 단계 로그를 확인하세요.');
    process.exitCode = 1;
  });
}
