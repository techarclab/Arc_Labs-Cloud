# EMQX 5.8.x node config for ARC Cloud.
# Rendered to /opt/emqx/etc/base.hocon at container start (see docker-compose.yml):
# __INTERNAL_HOOK_TOKEN__ is replaced with $INTERNAL_HOOK_TOKEN and __API_HOOKS_URL__ with $API_HOOKS_URL
# (default http://api:3001) by infra/emqx/entrypoint.sh.

# ---------- Listeners ----------
# Devices: MQTT over TLS only.
listeners.ssl.default {
  bind = "0.0.0.0:8883"
  max_connections = 100000
  ssl_options {
    cacertfile = "/opt/emqx/etc/certs/arc/ca.crt"
    certfile   = "/opt/emqx/etc/certs/arc/server.crt"
    keyfile    = "/opt/emqx/etc/certs/arc/server.key"
    versions   = ["tlsv1.3", "tlsv1.2"]
    verify     = verify_none        # devices authenticate with per-device username/password over TLS
  }
}

# Plain TCP is for the ingestion worker inside the private network only.
# docker-compose publishes it on 127.0.0.1 for local debugging; never expose it publicly.
listeners.tcp.default {
  bind = "0.0.0.0:1883"
}

listeners.ws.default.enable = false
listeners.wss.default.enable = false

mqtt {
  max_packet_size = 16KB
  max_clientid_len = 64
  max_topic_levels = 8
  retain_available = false
}

# ---------- Authentication: every client is checked by the ARC API ----------
authentication = [
  {
    mechanism = password_based
    backend = http
    enable = true
    method = post
    url = "__API_HOOKS_URL__/internal/mqtt/authenticate"
    body {
      username = "${username}"
      password = "${password}"
      clientid = "${clientid}"
    }
    headers {
      "content-type" = "application/json"
      "x-internal-token" = "__INTERNAL_HOOK_TOKEN__"
    }
    request_timeout = 5s
    pool_size = 8
  }
]

# ---------- Authorization: topic ACL decided by the ARC API ----------
authorization {
  no_match = deny
  deny_action = disconnect
  cache {
    enable = true
    max_size = 32
    ttl = 30s
  }
  sources = [
    {
      type = http
      enable = true
      method = post
      url = "__API_HOOKS_URL__/internal/mqtt/authorize"
      body {
        username = "${username}"
        clientid = "${clientid}"
        topic = "${topic}"
        action = "${action}"
      }
      headers {
        "content-type" = "application/json"
        "x-internal-token" = "__INTERNAL_HOOK_TOKEN__"
      }
      request_timeout = 5s
    }
  ]
}

# ---------- Client connect/disconnect events → online/offline ----------
sys_topics {
  sys_msg_interval = 1m
  sys_event_messages {
    client_connected = true
    client_disconnected = true
    client_subscribed = false
    client_unsubscribed = false
  }
}

# Local admin UI on http://127.0.0.1:18083 (change the default password on first login).
dashboard.listeners.http.bind = 18083
