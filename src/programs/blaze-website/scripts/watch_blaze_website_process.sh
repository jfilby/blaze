#!/bin/bash

set -u

ENV_NAME="blaze-website"
BLAZE_WEBSITE_LOCK_FILE="/tmp/blaze-website-${ENV_NAME}.lock"
PROGRAM_DIR="/opt/blaze/src/programs/blaze-website"
SECRETS_DIR="/opt/secrets/blaze"
CHECK_INTERVAL=7

while true; do
    RUNNING=0

    if [[ -f "$BLAZE_WEBSITE_LOCK_FILE" ]]; then
        PID=$(cat "$BLAZE_WEBSITE_LOCK_FILE" 2>/dev/null || true)

        if [[ "$PID" =~ ^[0-9]+$ ]] && kill -0 "$PID" 2>/dev/null; then
            RUNNING=1
        else
            rm -f "$BLAZE_WEBSITE_LOCK_FILE"
        fi
    fi

    if [[ "$RUNNING" -eq 0 ]]; then
        cd "$SECRETS_DIR" || {
            echo "Cannot access $SECRETS_DIR"
            sleep "$CHECK_INTERVAL"
            continue
        }

        # Load production environment
        source ./production.sh

        cd "$PROGRAM_DIR" || {
            echo "Cannot access $PROGRAM_DIR"
            sleep "$CHECK_INTERVAL"
            continue
        }

        # Start in the background and record the PID
        nohup ./blaze-website &
        PID=$!
        echo "$PID" > "$BLAZE_WEBSITE_LOCK_FILE"

        echo "Started blaze-website (PID $PID)"

        # Allow startup to fail before the next check
        sleep 1
        if ! kill -0 "$PID" 2>/dev/null; then
            echo "blaze-website failed to start"
            rm -f "$BLAZE_WEBSITE_LOCK_FILE"
        fi
    fi

    sleep "$CHECK_INTERVAL"
done
