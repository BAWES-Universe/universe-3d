#!/usr/bin/env bash
set -euo pipefail
: "${PIN:?}" "${SOURCE_SHA:?}" "${IMAGE_ID:?}" "${BUILD_ATTEMPT:?}"
[[ "$PIN" =~ ^ghcr.io/bawes-universe/universe-3d@sha256:[a-f0-9]{64}$ ]]
# Anonymous pull of the already public package. No registry or Coolify credential.
docker pull "$PIN"
bash deploy/on-dev/container-smoke.sh "$PIN"
