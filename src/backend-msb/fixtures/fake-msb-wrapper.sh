#!/bin/sh
# spawn(msbPath, args) treats msbPath as one executable, so the Node fixture
# script (fake-msb.mjs) needs a real executable in front of it rather than
# trying to smuggle "node fake-msb.mjs" through as a single path string.
exec node "$(dirname "$0")/fake-msb.mjs" "$@"
