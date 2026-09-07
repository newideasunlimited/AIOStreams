#!/usr/bin/env bash
set -euo pipefail

encode_id(){ python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

cat >/tmp/create-tv-user.json <<'JSON'
{
  "config": {
    "services": [],
    "presets": [],
    "formatter": { "id": "prism", "definition": { "name": "", "description": "" } },
    "sortCriteria": { "global": [] },
    "checkOwned": true,
    "autoRemoveDownloads": false
  },
  "password": "master-tv-qa"
}
JSON

curl -fsS -H 'Content-Type: application/json' --data-binary @/tmp/create-tv-user.json \
  http://127.0.0.1:3000/api/v1/user -o /tmp/create-tv-user-response.json
UUID="$(jq -r '.data.uuid // empty' /tmp/create-tv-user-response.json)"
PASSWORD="$(jq -r '.data.encryptedPassword // empty' /tmp/create-tv-user-response.json)"
test -n "$UUID"; test -n "$PASSWORD"
BASE="http://127.0.0.1:3000/stremio/$UUID/$PASSWORD"

curl -fsS "$BASE/manifest.json" -o /tmp/tv-manifest.json
LIVE_ID="$(jq -r '.catalogs[] | select(.name=="Live TV" and .type=="tv") | .id' /tmp/tv-manifest.json | head -n1)"
test -n "$LIVE_ID"
ELIVE="$(encode_id "$LIVE_ID")"

curl -fsS "$BASE/catalog/tv/$ELIVE.json" -o /tmp/tv-catalog.json
ADULT_SWIM_POSTER="$(jq -r '.metas[] | select(.id=="ustv-priority-adult-swim") | .poster // empty' /tmp/tv-catalog.json | head -n1)"
test -n "$ADULT_SWIM_POSTER"
[[ "$ADULT_SWIM_POSTER" == *"/master-static/live-tv/ustv-priority-adult-swim.svg" ]]
curl -fsS "$ADULT_SWIM_POSTER" -o /tmp/adult-swim-art.svg
grep -q '\[as\]' /tmp/adult-swim-art.svg
grep -q 'Adult Swim' /tmp/adult-swim-art.svg

curl -fsS "$BASE/stream/tv/ustv-priority-adult-swim.json" -o /tmp/adult-swim-streams.json
jq -e '.streams | type=="array" and length>=3' /tmp/adult-swim-streams.json >/dev/null
jq -e '.streams | all(.behaviorHints.notWebReady == true)' /tmp/adult-swim-streams.json >/dev/null
jq -e '.streams | any(.name | contains("Direct"))' /tmp/adult-swim-streams.json >/dev/null
jq -e '.streams | any(.url | contains("live-stream.primary.v2.m3u8"))' /tmp/adult-swim-streams.json >/dev/null

for ID in ustv-priority-phx-abc15 ustv-priority-phx-fox10 ustv-priority-phx-12news ustv-priority-phx-azfamily; do
  curl -fsS "$BASE/stream/tv/$ID.json" -o /tmp/one-tv-stream.json
  jq -e '.streams | type=="array" and length>0 and all(.behaviorHints.notWebReady == true)' /tmp/one-tv-stream.json >/dev/null
done

echo 'LIVE TV SEMANTICS QA PASSED: Adult Swim artwork present and every Master Live TV transport is notWebReady=true.'
