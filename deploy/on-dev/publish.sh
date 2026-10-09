#!/usr/bin/env bash
set -euo pipefail
# Trusted publisher: inspect/load/tag/push only. Never run source or an image.
: "${SOURCE_SHA:?}" "${CONTROLLER_SHA:?}" "${BUILD_ATTEMPT:?}" "${IMAGE:?}" "${PACKAGE_TOKEN:?}"
jq -e --arg repository "$GITHUB_REPOSITORY" --arg sha "$SOURCE_SHA" --arg controller "$CONTROLLER_SHA" \
  --arg run "$GITHUB_RUN_ID" --arg attempt "$BUILD_ATTEMPT" '
  .schemaVersion == 1 and .repository == $repository and .sha == $sha and .controllerSha == $controller and
  .runId == $run and .buildAttempt == $attempt and .platform == "linux/amd64" and
  (.tree | test("^[a-f0-9]{40}$")) and
  (.imageId | test("^sha256:[a-f0-9]{64}$")) and (.archiveSha256 | test("^[a-f0-9]{64}$"))' input/source.json >/dev/null
test "$(sha256sum input/image.tar | cut -d ' ' -f 1)" = "$(jq -r .archiveSha256 input/source.json)"
docker load --input input/image.tar
id=$(jq -r .imageId input/source.json)
tree=$(jq -r .tree input/source.json)
docker image inspect "$id" | jq -e --arg id "$id" --arg sha "$SOURCE_SHA" --arg tree "$tree" \
  --arg controller "$CONTROLLER_SHA" --arg run "$GITHUB_RUN_ID" '
  length == 1 and .[0].Id == $id and .[0].Architecture == "amd64" and .[0].Os == "linux" and .[0].Config.User == "node:node" and
  .[0].Config.Labels["org.opencontainers.image.source"] == "https://github.com/BAWES-Universe/universe-3d" and
  .[0].Config.Labels["org.opencontainers.image.revision"] == $sha and .[0].Config.Labels["net.bawes.source-tree"] == $tree and
  .[0].Config.Labels["net.bawes.controller-sha"] == $controller and
  .[0].Config.Labels["net.bawes.run-id"] == $run' >/dev/null
mkdir -m 0700 "$DOCKER_CONFIG"
trap 'docker logout ghcr.io >/dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT
printf '%s' "$PACKAGE_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
unset PACKAGE_TOKEN
tag="$IMAGE:on-dev-$SOURCE_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
docker tag "$id" "$tag"
docker push "$tag"
docker buildx imagetools inspect "$tag" --format '{{json .Manifest}}' > registry.json
digest=$(jq -er '.digest | select(test("^sha256:[a-f0-9]{64}$"))' registry.json)
pin="$IMAGE@$digest"
docker buildx imagetools inspect "$pin" --raw > manifest.json
jq -e --arg id "$id" '.config.digest == $id' manifest.json >/dev/null
jq --arg pin "$pin" --arg digest "$digest" --arg tag "$tag" '. + {pin:$pin,digest:$digest,tag:$tag,published:true}' input/source.json > release.json
printf 'pin=%s\ndigest=%s\nimage_id=%s\n' "$pin" "$digest" "$id" >> "$GITHUB_OUTPUT"
