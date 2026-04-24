#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Adjust the node user's UID/GID if they differ from the runtime request
# and fix volume ownership only when a remap is needed
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

if [ "$changed" = "1" ]; then
    chown -R node:node /paperclip
fi

# Start War Room voice server if enabled
if [ "${WARROOM_ENABLED}" = "true" ]; then
  cd /app/warroom
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
  WARROOM_PORT="${WARROOM_PORT:-7860}" .venv/bin/python server.py &
  cd /app
fi

exec gosu node "$@"
