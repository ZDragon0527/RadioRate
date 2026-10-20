# 원자력발전소 실시간 주변 방사선량 모니터링 웹앱

정적 웹앱(HTML 단일 페이지)과, 공공데이터포털 측정값을 주기적으로 수집해 함께 배포하는 GitHub Actions로 구성됩니다.
인증키는 GitHub Secrets에만 보관되며 페이지 소스·데이터 파일에는 포함되지 않습니다.

## 동작 방식

```
GitHub Actions (30분 간격)
  └ scripts/fetch-radiation.mjs ── 공공데이터포털 API 호출(인증키: Secrets)
       └ data/radiation.json 생성 ─┐
  index.html · assets ─────────────┴→ GitHub Pages 배포
방문자 브라우저 → index.html → data/radiation.json 읽기(5분마다 재확인)
```

- 측정값은 **수집된 실측 데이터만** 표시합니다. 시뮬레이션·예시 값은 표시하지 않습니다.
- 어떤 본부의 수집이 실패하면 직전 수집값을 유지하고 화면 상단에 "수신 지연"과 마지막 수집 시각을 안내합니다.
- 24시간 추이 그래프는 수집할 때마다 쌓이는 본부별 평균값으로 그립니다(배포 직후에는 데이터가 적음).
- 0.30 μSv/h(국내 평시 자연방사선 범위 상한)를 넘는 값은 "평시 범위 초과"로 표시합니다.

## 최초 설정 (저장소 관리자)

1. **인증키 등록**: 저장소 Settings → Secrets and variables → Actions → New repository secret
   - Name: `RADIORATE_SERVICE_KEY`
   - Secret: 공공데이터포털 마이페이지의 일반 인증키(Encoding·Decoding 어느 쪽이든 가능)
2. **Pages 설정**: Settings → Pages → Build and deployment → Source를 **GitHub Actions**로 지정
3. **첫 실행**: Actions 탭 → "방사선량 데이터 수집 및 배포" → Run workflow
4. 실행 로그의 "공공데이터포털 API 수집" 단계에서 본부별 수신 결과를 확인합니다.

## 운영 시 확인할 것

- **수집 주기**: `.github/workflows/update-radiation.yml`의 `cron`(기본 30분). 줄이면 API 호출량(1회당 5건)과 Actions 사용 시간이 늘어납니다. 일일 호출 한도는 공공데이터포털 활용신청 상세에서 확인하세요.
- **수집 실패 알림**: 5개 본부 모두 실패하면 워크플로가 실패로 표시됩니다(GitHub 알림 메일).
- **예약 실행 중지**: 저장소에 일정 기간 활동이 없으면 GitHub가 예약 실행을 멈출 수 있습니다. Actions 탭에서 다시 켜면 됩니다.
- **단위**: 응답 값(`value`)을 μSv/h로 보고 변환 없이 표시합니다(실제 응답 예: `0.093`). 원본 응답은 `data/radiation.json`의 `raw` 필드에 보존됩니다.

## 파일 구성

| 파일 | 설명 |
| --- | --- |
| `index.html` | 웹앱 본문 (Tailwind CSS·Chart.js CDN 사용) |
| `scripts/fetch-radiation.mjs` | API 수집 스크립트 (Node 20+, 외부 패키지 없음) |
| `.github/workflows/update-radiation.yml` | 수집 + Pages 배포 워크플로 |
| `assets/hero.jpg`, `assets/icon.svg` | 배너 이미지, 앱 아이콘 |
| `manifest.webmanifest` | 홈 화면 추가(설치형 웹앱)용 매니페스트 |

## 로컬 확인

```bash
RADIORATE_SERVICE_KEY='발급받은키' node scripts/fetch-radiation.mjs --out data/radiation.json
python3 -m http.server 8000   # http://localhost:8000
```

`data/`는 배포 시 생성되므로 저장소에는 커밋하지 않습니다(`.gitignore`).
