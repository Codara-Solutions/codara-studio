#!/bin/sh
# The test passes its public key in AUTHORIZED_KEY; host keys are made fresh.
set -e
printf '%s\n' "$AUTHORIZED_KEY" > /home/dev/.ssh/authorized_keys
chown dev:dev /home/dev/.ssh/authorized_keys
chmod 600 /home/dev/.ssh/authorized_keys
ssh-keygen -A >/dev/null
exec /usr/sbin/sshd -D -e
