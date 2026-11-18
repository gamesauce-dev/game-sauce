#!/usr/bin/env bash
# every language: bash build-all.sh   ->  game-sauce-intro-<lang>.mp4
cd "$(dirname "$0")"
for l in en de es fr it pt ja zh; do bash build.sh $l game-sauce-intro-$l.mp4 | grep duration | sed "s/^/$l /"; done
