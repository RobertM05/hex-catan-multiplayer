# Multi-Instance Horizontal Scaling & Redis Architecture (SCALE-02)

## Overview
Hex Catan Multiplayer supports multi-instance horizontal scaling across multiple container instances or servers.
Inter-instance communication is coordinated through **Redis (or Valkey)** for:
1. **Socket.IO Pub/Sub broadcasting:** Sockets connected to instance A and instance B receive shared room events (`room_state`, `game_state`, chat, etc.).
2. **Distributed Rate Limiting:** Sliding window limits (room creation, chat bursts, socket actions) are synchronized across all instances using atomic Redis Lua scripts.
3. **Graceful Standalone Fallback:** When `REDIS_URL` is omitted, the application runs standalone with in-memory adapters and zero external dependencies.

---

## Configuration

Set the `REDIS_URL` environment variable in your deployment environment or `.env`:

```bash
# Redis connection URI
REDIS_URL=redis://default:secret@redis.internal:6379/0
```

When `REDIS_URL` is defined, the server initializes `@socket.io/redis-adapter` with connected `pubClient` and `subClient`, and attaches the distributed rate limiter.

---

## Reverse Proxy & Sticky Sessions (Session Affinity)

Socket.IO requires sticky sessions (session affinity) during HTTP long-polling transport handshakes so that the initial handshake requests and subsequent upgrade to WebSocket route to the same server node.

### 1. Nginx Configuration

Ensure `ip_hash` or cookie-based sticky sessions are enabled in upstream blocks:

```nginx
upstream hex_catan_backend {
    # Sticky session via IP hash (or use sticky cookie if using Nginx Plus)
    ip_hash;

    server node1.internal:3000 max_fails=3 fail_timeout=30s;
    server node2.internal:3000 max_fails=3 fail_timeout=30s;
    server node3.internal:3000 max_fails=3 fail_timeout=30s;
}

server {
    listen 80;
    server_name catan.example.com;

    location / {
        proxy_pass http://hex_catan_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket timeouts
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

### 2. Cloudflare Load Balancer (Session Affinity)

If deploying behind Cloudflare:
1. Navigate to **Traffic** > **Load Balancing** > **Pools**.
2. Under **Session Affinity**, choose **Client IP Affinity** or **Cookie Affinity** (`__cf_bm`).
3. Set the Session Affinity TTL to `3600` seconds (1 hour).
4. Sockets connecting with the affinity cookie will consistently route to their assigned node for the match duration.

---

## Distributed Rate Limiting

The distributed rate limiter uses atomic Redis Lua scripts (`ZREMRANGEBYSCORE` + `ZCARD` + `ZADD` + `PEXPIRE`) to ensure zero race conditions across concurrent requests:

| Action | Limit | Window | Key Structure |
|---|---|---|---|
| `create_room` | 5 requests | 60 seconds | `catan:rl:create:<ip>` |
| `send_chat` | 5 messages | 3 seconds | `catan:rl:chat:<playerId\|socketId>` |
| `game_action` | 25 actions | 5 seconds | `catan:rl:action:<socketId>` |
