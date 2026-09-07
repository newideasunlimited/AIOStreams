#!/usr/bin/env bash
set -euo pipefail

encode_id(){ python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
has_playable_url(){ jq -e '.streams | type == "array" and any(.url? | type == "string" and length > 0)' "$1" >/dev/null; }

MEDIAFLOW_STARTED=0
cleanup(){ if [ "$MEDIAFLOW_STARTED" -eq 1 ]; then docker rm -f mediaflow-qa >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT

if ! curl -fsS http://127.0.0.1:8888/health >/dev/null 2>&1; then
  docker run -d --name mediaflow-qa -p 8888:8888 \
    -e ENABLE_TRANSCODE=true -e TRANSCODE_PREFER_GPU=false \
    mhdzumair/mediaflow-proxy:latest >/dev/null
  MEDIAFLOW_STARTED=1
  for _ in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:8888/health >/dev/null 2>&1; then break; fi
    sleep 2
  done
fi
curl -fsS http://127.0.0.1:8888/health | jq -e '.status == "healthy"' >/dev/null

cat >/tmp/create-user.json <<'JSON'
{
  "config": {
    "services": [],
    "presets": [],
    "formatter": { "id": "prism", "definition": { "name": "", "description": "" } },
    "sortCriteria": { "global": [] },
    "checkOwned": true,
    "autoRemoveDownloads": false
  },
  "password": "master-qa-password"
}
JSON

curl -fsS -H 'Content-Type: application/json' --data-binary @/tmp/create-user.json \
  http://127.0.0.1:3000/api/v1/user -o /tmp/create-user-response.json
UUID="$(jq -r '.data.uuid // empty' /tmp/create-user-response.json)"
ENCRYPTED_PASSWORD="$(jq -r '.data.encryptedPassword // empty' /tmp/create-user-response.json)"
test -n "$UUID"; test -n "$ENCRYPTED_PASSWORD"
BASE="http://127.0.0.1:3000/stremio/$UUID/$ENCRYPTED_PASSWORD"

curl -fsS -D /tmp/manifest.headers "$BASE/manifest.json" -o /tmp/master-manifest.json
grep -qi '^cache-control:.*no-store' /tmp/manifest.headers
jq -e '.version == "99.0.115"' /tmp/master-manifest.json

LIVE_CATALOG_ID="$(jq -r '.catalogs[] | select(.name == "Live TV" and .type == "tv") | .id' /tmp/master-manifest.json | head -n1)"
RADIO_CATALOG_ID="$(jq -r '.catalogs[] | select(.name == "Radio" and .type == "other") | .id' /tmp/master-manifest.json | head -n1)"
PORN_CATALOG_ID="$(jq -r '.catalogs[] | select(.name == "Porn" and .type == "movie") | .id' /tmp/master-manifest.json | head -n1)"
test -n "$LIVE_CATALOG_ID"; test -n "$RADIO_CATALOG_ID"; test -n "$PORN_CATALOG_ID"
[[ "$LIVE_CATALOG_ID" == *.master-live-tv ]]
[[ "$RADIO_CATALOG_ID" == *.master-radio ]]
[[ "$PORN_CATALOG_ID" == *.master-adult ]]
jq -e '[.catalogs[] | select(.name == "Live TV" or .name == "Radio" or .name == "Porn") | .extra[]? | select(.isRequired == true)] | length == 0' /tmp/master-manifest.json
python3 - <<'PY'
import json
c=json.load(open('/tmp/master-manifest.json'))['catalogs']
last=[(x.get('name'),x.get('type')) for x in c[-3:]]
expected=[('Live TV','tv'),('Radio','other'),('Porn','movie')]
if last != expected: raise SystemExit(f'Wrong final Board rows: {last}')
PY

ELIVE="$(encode_id "$LIVE_CATALOG_ID")"; ERADIO="$(encode_id "$RADIO_CATALOG_ID")"; EPORN="$(encode_id "$PORN_CATALOG_ID")"

curl -fsS "$BASE/catalog/tv/$ELIVE.json" -o /tmp/live-tv.json
jq -e '.metas | type=="array" and length>0' /tmp/live-tv.json
for ID in ustv-priority-phx-abc15 ustv-priority-phx-fox10 ustv-priority-phx-12news ustv-priority-phx-azfamily; do
  jq -e --arg id "$ID" '.metas | any(.id==$id)' /tmp/live-tv.json >/dev/null
done
POSTER="$(jq -r '.metas[] | select(.id=="ustv-priority-phx-abc15") | .poster // empty' /tmp/live-tv.json | head -n1)"
test -n "$POSTER"
curl -fsS -D /tmp/poster.headers "$POSTER" -o /tmp/poster.bin
grep -qi '^content-type: image/' /tmp/poster.headers
test -s /tmp/poster.bin

curl -fsS "$BASE/meta/tv/ustv-priority-phx-abc15.json" -o /tmp/tv-meta.json
jq -e '.meta.id == "ustv-priority-phx-abc15"' /tmp/tv-meta.json
curl -fsS "$BASE/stream/tv/ustv-priority-phx-abc15.json" -o /tmp/tv-streams.json
has_playable_url /tmp/tv-streams.json
jq -e '.streams | any(.url? | contains("/proxy/stream") and contains("transcode=true"))' /tmp/tv-streams.json
jq -e '.streams | any(.url? | contains("/proxy/hls/manifest.m3u8"))' /tmp/tv-streams.json

UPSTREAM_OK=0
while IFS= read -r ID; do
  [ -n "$ID" ] || continue
  case "$ID" in ustv-priority-*) continue ;; esac
  EID="$(encode_id "$ID")"
  if curl -fsS --max-time 20 "$BASE/stream/tv/$EID.json" -o /tmp/upstream.json && has_playable_url /tmp/upstream.json; then UPSTREAM_OK=1; break; fi
done < <(jq -r '.metas[0:40][]?.id' /tmp/live-tv.json)
[ "$UPSTREAM_OK" -eq 1 ]

curl -fsS "$BASE/catalog/other/$ERADIO.json" -o /tmp/radio.json
jq -e '.metas | type=="array" and length>0' /tmp/radio.json
RADIO_ID="$(jq -r '.metas[0].id // empty' /tmp/radio.json)"; test -n "$RADIO_ID"
ERADIO_ID="$(encode_id "$RADIO_ID")"
curl -fsS "$BASE/meta/other/$ERADIO_ID.json" -o /tmp/radio-meta.json
jq -e '.meta != null' /tmp/radio-meta.json
curl -fsS "$BASE/stream/other/$ERADIO_ID.json" -o /tmp/radio-streams.json
has_playable_url /tmp/radio-streams.json

curl -fsS "$BASE/catalog/movie/$EPORN.json" -o /tmp/porn.json
jq -e '.metas | type=="array" and length>0' /tmp/porn.json
PORN_META_OK=0; PORN_STREAM_OK=0
while IFS= read -r ID; do
  [ -n "$ID" ] || continue
  EID="$(encode_id "$ID")"
  if [ "$PORN_META_OK" -eq 0 ] && curl -fsS --max-time 15 "$BASE/meta/movie/$EID.json" -o /tmp/porn-meta.json && jq -e '.meta != null' /tmp/porn-meta.json >/dev/null; then PORN_META_OK=1; fi
  if curl -fsS --max-time 25 "$BASE/stream/movie/$EID.json" -o /tmp/porn-streams.json && has_playable_url /tmp/porn-streams.json; then PORN_STREAM_OK=1; break; fi
done < <(jq -r '.metas[0:12][]?.id' /tmp/porn.json)
[ "$PORN_META_OK" -eq 1 ]; [ "$PORN_STREAM_OK" -eq 1 ]

curl -fsS --max-time 25 \
  'http://127.0.0.1:8888/proxy/hls/manifest.m3u8?d=https%3A%2F%2Fdevstreaming-cdn.apple.com%2Fvideos%2Fstreaming%2Fexamples%2Fimg_bipbop_adv_example_fmp4%2Fmaster.m3u8&force_playlist_proxy=true' \
  -o /tmp/mediaflow-hls.m3u8
grep -q '#EXTM3U' /tmp/mediaflow-hls.m3u8
curl -fsSI --max-time 35 \
  'http://127.0.0.1:8888/proxy/stream?d=https%3A%2F%2Fdevstreaming-cdn.apple.com%2Fvideos%2Fstreaming%2Fexamples%2Fimg_bipbop_adv_example_fmp4%2Fmaster.m3u8&transcode=true' \
  -o /tmp/mediaflow-stream.headers
grep -Eq '^HTTP/.* (200|206)' /tmp/mediaflow-stream.headers

echo 'FULL MASTER QA PASSED: Board order, catalog/meta/stream routes, TV source fallbacks, live MediaFlow HLS+continuous transcode, Radio Browser failover, adult catalog/meta/playback.'
