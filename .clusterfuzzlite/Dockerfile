# ClusterFuzzLite build image — OpenSSF Scorecard detects fuzzing via this file.
# Uses the OSS-Fuzz JavaScript base builder (Jazzer.js), which provides
# `compile_javascript_fuzzer`. See build.sh for the fuzz targets.
# Digest-pinned (Scorecard Pinned-Dependencies); dependabot's docker ecosystem
# refreshes the pin so it tracks upstream instead of rotting.
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:61d74ab736764e98c8e7017dafd8bdd1129f004177dc38eec08bdbb3dd3ea7d8
COPY . $SRC/hands
WORKDIR $SRC/hands
COPY .clusterfuzzlite/build.sh $SRC/build.sh
