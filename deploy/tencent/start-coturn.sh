#!/bin/sh
set -eu

turn_port="${TURN_PORT:-3478}"

if [ -n "${TURN_SHARED_SECRET:-}" ]; then
  : "${PEERDESK_HOST:?Set PEERDESK_HOST in .env}"
  : "${TURN_EXTERNAL_IP:?Set TURN_EXTERNAL_IP to the public/private IP mapping}"

  IFS=/ read -r public_ip private_ip <<EOF
$TURN_EXTERNAL_IP
EOF
  if [ -z "$private_ip" ]; then
    private_ip="$public_ip"
  fi

  config_file=$(mktemp)
  chmod 600 "$config_file"
  cat > "$config_file" <<EOF
listening-port=$turn_port
listening-ip=$private_ip
relay-ip=$private_ip
min-port=${TURN_MIN_PORT:-49160}
max-port=${TURN_MAX_PORT:-49200}
realm=$PEERDESK_HOST
external-ip=$TURN_EXTERNAL_IP
pidfile=/var/tmp/turnserver.pid
use-auth-secret
static-auth-secret=$TURN_SHARED_SECRET
fingerprint
no-tls
no-tcp-relay
log-file=stdout
EOF
  unset TURN_SHARED_SECRET
  exec turnserver -c "$config_file"
fi

exec turnserver -n --stun-only --listening-port="$turn_port" \
  --no-tcp --no-tls --log-file=stdout
