#!/bin/zsh
# Read Tab Mixer's log from the macOS unified log.
#   tools/logs.sh            last 10 minutes
#   tools/logs.sh 30m        last 30 minutes
#   tools/logs.sh follow     live stream
#   tools/logs.sh errors     last 10 minutes, errors only
# Line format:  p:<profile> [t<tab>/f<frame> top <origin>] LEVEL event {data}
# Categories (src): inject, bridge, bg, popup, native.
# Only warnings, errors and Dump snapshots are logged by default; set
# VERBOSE = true in the extension's JS files to log every event.
PRED='subsystem == "com.bezalel.tabmixer"'

case "${1:-10m}" in
  follow) exec /usr/bin/log stream --level debug --style compact --predicate "$PRED" ;;
  errors) /usr/bin/log show --last 10m --info --debug --style compact \
            --predicate "$PRED AND messageType == error" ;;
  *)      /usr/bin/log show --last "${1:-10m}" --info --debug --style compact \
            --predicate "$PRED" ;;
esac
