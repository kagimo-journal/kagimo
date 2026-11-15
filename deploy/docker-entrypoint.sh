#!/bin/sh
# Container entrypoint. A volume mounted at /data usually arrives owned by root; hand it to
# the service user, then run the server (or an admin command: `journal admin ...`) as it.
set -e
umask 077
mkdir -p /data
chown -R journal:journal /data
chmod 700 /data
exec su-exec journal /usr/local/bin/journal "$@"
