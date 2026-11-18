#!/usr/bin/env bash
# the closing scene in every language (the tagline differs); needs the test server on 8795
cd "$(dirname "$0")"
for l in de es fr it pt ja zh; do
  source "captions/$l.sh"
  node render-end.cjs http://localhost:8795/ 5.2 "$TAG" "$l" | tail -1
done
