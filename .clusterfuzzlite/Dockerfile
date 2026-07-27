# ClusterFuzzLite build image — OpenSSF Scorecard detects fuzzing via this file.
# Uses the OSS-Fuzz JavaScript base builder (Jazzer.js), which provides
# `compile_javascript_fuzzer`. See build.sh for the fuzz targets.
# Digest-pinned (Scorecard Pinned-Dependencies); dependabot's docker ecosystem
# refreshes the pin so it tracks upstream instead of rotting.
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:82ac7524df3474ea0003250393300a72b9191e213b7c22aa0c42107ca75d5dfc
COPY . $SRC/hands
WORKDIR $SRC/hands
COPY .clusterfuzzlite/build.sh $SRC/build.sh
