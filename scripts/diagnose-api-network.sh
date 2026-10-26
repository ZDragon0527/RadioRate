#!/usr/bin/env bash
# No service key, response body, full environment dump, or authenticated URL is used.
set -u
host=apis.data.go.kr
endpoint="https://${host}/B552041/radiorate/getradiorate"

echo '::group::API DNS / IPv4 / IPv6 진단 (인증 없는 연결 확인)'
for family in ahostsv4 ahostsv6; do
  echo "DNS ${family}:"
  timeout 5 getent "$family" "$host" || echo "DNS 조회 실패 또는 주소 없음: ${family}"
done
for family in -4 -6; do
  echo "curl ${family}:"
  curl -q "$family" --silent --show-error --connect-timeout 5 --max-time 12 \
    --output /dev/null \
    --write-out 'http=%{http_code} remote_ip=%{remote_ip} dns=%{time_namelookup}s connect=%{time_connect}s tls=%{time_appconnect}s total=%{time_total}s ssl_verify=%{ssl_verify_result}\n' \
    "$endpoint"
  echo "curl_exit=$?"
done
echo '인증 없는 요청의 HTTP 오류는 수집 API의 인증·측정값 검증 결과가 아닙니다.'
echo '::endgroup::'
