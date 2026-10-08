#!/usr/bin/env bash
set -euo pipefail
# Run one already-present exact image with disposable data and no network or
# registry/deployment credentials. Shared by pre-deploy and PR-only CI smoke.
image=${1:?usage: container-smoke.sh EXACT_IMAGE_REFERENCE}
: "${SOURCE_SHA:?}" "${IMAGE_ID:?}" "${BUILD_ATTEMPT:?}"
[[ "$IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]]
[[ "$image" == "$IMAGE_ID" || "$image" =~ ^ghcr.io/bawes-universe/universe-3d@sha256:[a-f0-9]{64}$ ]]
test "$(docker image inspect "$image" --format '{{.Id}}')" = "$IMAGE_ID"
name="universe-on-dev-smoke-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" --pull never --network none --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges --ulimit nproc=128:128 --memory 768m --cpus 1 \
  --tmpfs /data:rw,nosuid,uid=1000,gid=1000,mode=0700,size=128m \
  -e UNIVERSE_MODE=local -e UNIVERSE_BIND_ADDRESS=127.0.0.1 -e UNIVERSE_TLS_MODE=local-http -e UNIVERSE_COOKIE_SECURE=socket "$image"
healthy=false
for attempt in $(seq 1 45); do
  if docker exec "$name" node scripts/healthcheck.mjs; then healthy=true; break; fi
  sleep 1
done
test "$healthy" = true
# Server's own /api/health must expose the build identity; port 4190 is on fetch's
# blocked-port list, so use node:http. This code is trusted workflow source.
docker exec -e EXPECT_SHA="$SOURCE_SHA" -e EXPECT_RUN="$GITHUB_RUN_ID" -e EXPECT_ATTEMPT="$BUILD_ATTEMPT" "$name" node --input-type=module -e '
  import http from "node:http";
  const get = path => new Promise((resolve,reject) => {
    const req=http.get("http://127.0.0.1:4190"+path,{signal:AbortSignal.timeout(5000)},res=>{
      let text=""; res.on("data",chunk=>{text+=chunk;if(text.length>1048576)req.destroy(new Error("response too large"));});
      res.on("end",()=>res.statusCode===200?resolve(text):reject(new Error("HTTP "+res.statusCode)));res.on("error",reject);
    });req.on("error",reject);
  });
  const health=JSON.parse(await get("/api/health"));
  if(process.getuid()!==1000 || health.ok!==true || health.build?.revision!==process.env.EXPECT_SHA || health.build?.runId!==process.env.EXPECT_RUN || health.build?.buildAttempt!==process.env.EXPECT_ATTEMPT)process.exit(1);
  if(!(await get("/")).includes("/main.js"))process.exit(2);'
