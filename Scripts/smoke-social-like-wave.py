#!/usr/bin/env python3
"""Wave of likes from distinct users against one post (social notification smoke).

Runs on the API host (uses /etc/flora-ecosystem/flora-api.env). Never prints secrets.

Usage:
  python3 smoke-social-like-wave.py --interval 15 --actors 8
  python3 smoke-social-like-wave.py --post-uuid <uuid> --interval 15 --actors 8 --rounds 1
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from typing import Any
from urllib.parse import quote


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def load_env(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def npgsql_to_url(conn: str) -> str:
    if conn.startswith("postgres"):
        return conn
    parts: dict[str, str] = {}
    for seg in conn.split(";"):
        seg = seg.strip()
        if not seg or "=" not in seg:
            continue
        k, v = seg.split("=", 1)
        parts[k.strip().lower()] = v.strip()
    user = parts.get("username") or parts.get("user id") or "postgres"
    password = parts.get("password") or ""
    host = parts.get("host") or "127.0.0.1"
    port = parts.get("port") or "5432"
    db = parts.get("database") or "postgres"
    return f"postgresql://{quote(user)}:{quote(password)}@{host}:{port}/{db}"


def psql(url: str, sql: str) -> str:
    r = subprocess.run(
        ["psql", url, "-v", "ON_ERROR_STOP=1", "-At", "-F", "|", "-c", sql],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "psql failed")
    return r.stdout.strip()


def issue_access_token(
    secret: str,
    issuer: str,
    audience: str,
    user_uuid: str,
    email: str,
    ttl_sec: int = 3600,
    jti: str | None = None,
) -> str:
    now = int(time.time())
    header = '{"alg":"HS256","typ":"JWT"}'
    # Claim order/names match flora-auth jwt.rs (incl. long-form nameidentifier / emailaddress).
    # jti must match an active flora_core.user_sessions.jwt_id (require_bearer_jwt).
    payload_obj = {
        "sub": user_uuid,
        "email": email,
        "jti": jti or str(uuid.uuid4()),
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": user_uuid,
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": email,
        "exp": now + ttl_sec,
        "iss": issuer,
        "aud": audience,
    }
    payload = json.dumps(payload_obj, separators=(",", ":"), ensure_ascii=False)
    signing_input = f"{b64url(header.encode())}.{b64url(payload.encode())}"
    sig = hmac.new(secret.encode("utf-8"), signing_input.encode("utf-8"), hashlib.sha256).digest()
    return f"{signing_input}.{b64url(sig)}"


def http_json(method: str, url: str, token: str, body: dict[str, Any] | None = None) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            parsed = {"error": raw}
        return e.code, parsed


def main() -> int:
    ap = argparse.ArgumentParser(description="Social like-wave smoke (distinct actors)")
    ap.add_argument("--env-file", default="/etc/flora-ecosystem/flora-api.env")
    ap.add_argument("--api", default="http://127.0.0.1:5290")
    ap.add_argument("--post-uuid", default="")
    ap.add_argument("--actors", type=int, default=8, help="distinct likers")
    ap.add_argument("--interval", type=float, default=15.0, help="seconds between likes")
    ap.add_argument(
        "--rounds",
        type=int,
        default=1,
        help="how many full passes over the actor list (0 = forever)",
    )
    ap.add_argument(
        "--unlike-first",
        action="store_true",
        help="DELETE like before POST (re-enter membership; still one audible / 15m)",
    )
    args = ap.parse_args()

    env = load_env(args.env_file)
    conn = (
        env.get("ConnectionStrings__FloraDatabase")
        or env.get("DATABASE_URL")
        or env.get("Flora__ConnectionString")
    )
    secret = env.get("Jwt__Secret") or env.get("Jwt:Secret")
    if not conn or not secret:
        print("missing ConnectionStrings__FloraDatabase or Jwt__Secret in env", file=sys.stderr)
        return 2
    issuer = env.get("Jwt__Issuer") or env.get("Jwt:Issuer") or "Flora.Auth"
    audience = env.get("Jwt__Audience") or env.get("Jwt:Audience") or "Flora.Ecosystem"
    url = npgsql_to_url(conn)
    api = args.api.rstrip("/")

    if args.post_uuid:
        post_uuid = args.post_uuid.strip()
        row = psql(
            url,
            f"""
            SELECT p.post_uuid::text, p.author_user_uuid::text,
                   COALESCE(ua.username, '')
            FROM flora_core.user_posts p
            LEFT JOIN flora_core.user_accounts ua ON ua.user_uuid = p.author_user_uuid
            WHERE p.post_uuid = '{post_uuid}'::uuid
              AND COALESCE(p.is_deleted, false) = false
            """,
        )
        if not row:
            print(f"post not found: {post_uuid}", file=sys.stderr)
            return 2
        post_uuid, author_uuid, author_name = row.split("|", 2)
    else:
        row = psql(
            url,
            """
            SELECT p.post_uuid::text, p.author_user_uuid::text,
                   COALESCE(ua.username, '')
            FROM flora_core.user_posts p
            LEFT JOIN flora_core.user_accounts ua ON ua.user_uuid = p.author_user_uuid
            WHERE COALESCE(p.is_deleted, false) = false
            ORDER BY p.created_at DESC
            LIMIT 1
            """,
        )
        if not row:
            print("no posts in DB", file=sys.stderr)
            return 2
        post_uuid, author_uuid, author_name = row.split("|", 2)

    actors_raw = psql(
        url,
        f"""
        SELECT ua.user_uuid::text,
               COALESCE(NULLIF(btrim(ua.username), ''), 'user')
        FROM flora_core.user_accounts ua
        WHERE ua.user_uuid <> '{author_uuid}'::uuid
          AND NOT EXISTS (
            SELECT 1 FROM flora_core.post_likes pl
            WHERE pl.post_uuid = '{post_uuid}'::uuid
              AND pl.user_uuid = ua.user_uuid
          )
        ORDER BY ua.created_at DESC NULLS LAST
        LIMIT {int(args.actors)}
        """,
    )
    if not actors_raw:
        # Fall back: any non-author users (will unlike-first automatically).
        actors_raw = psql(
            url,
            f"""
            SELECT ua.user_uuid::text,
                   COALESCE(NULLIF(btrim(ua.username), ''), 'user')
            FROM flora_core.user_accounts ua
            WHERE ua.user_uuid <> '{author_uuid}'::uuid
            ORDER BY ua.created_at DESC NULLS LAST
            LIMIT {int(args.actors)}
            """,
        )
        args.unlike_first = True

    actors = [tuple(line.split("|", 1)) for line in actors_raw.splitlines() if line.strip()]
    if not actors:
        print("no actor users available", file=sys.stderr)
        return 2

    def ensure_session(user_uuid: str) -> str:
        """Insert active user_sessions row; return jwt_id used as access-token jti."""
        jwt_id = str(uuid.uuid4())
        session_id = str(uuid.uuid4())
        # status=0 active — mirrors flora-auth sessions_smoke insert.
        psql(
            url,
            f"""
            INSERT INTO flora_core.user_sessions (
                session_id, user_uuid, agent_hash, ip_address,
                created_at, expires_at, last_activity,
                jwt_id, refresh_token, rotation_id, status,
                csrf_token, hmac_key
            ) VALUES (
                '{session_id}'::uuid, '{user_uuid}'::uuid, 'smoke-like-wave', '127.0.0.1',
                now(), now() + interval '1 day', now(),
                '{jwt_id}', 'smoke-refresh-{session_id}', 0, 0,
                'smoke-csrf', 'smoke-hmac'
            )
            """,
        )
        return jwt_id

    print("=== social like-wave smoke ===")
    print(f"api={api}")
    print(f"post={post_uuid}")
    print(f"author=@{author_name or '?'} ({author_uuid})")
    print(f"actors={len(actors)} interval={args.interval}s rounds={args.rounds} unlike_first={args.unlike_first}")
    print("Watch notifications on the AUTHOR device (inbox + FCM tray).")
    print("Expected: 1 audible in 15m window; later likes SSE/inbox only (same group_key=like:<post>).")
    print("---")

    # Mint one session+token per actor up front (Bearer requires active jwt_id).
    actor_tokens: list[tuple[str, str, str]] = []
    for actor_uuid, username in actors:
        jti = ensure_session(actor_uuid)
        token = issue_access_token(
            secret,
            issuer,
            audience,
            actor_uuid,
            f"{username}@smoke.flora.local",
            jti=jti,
        )
        actor_tokens.append((actor_uuid, username, token))

    author_jti = ensure_session(author_uuid)
    author_token = issue_access_token(
        secret,
        issuer,
        audience,
        author_uuid,
        f"{author_name or 'author'}@smoke.flora.local",
        jti=author_jti,
    )

    round_i = 0
    while args.rounds == 0 or round_i < args.rounds:
        round_i += 1
        for i, (_actor_uuid, username, token) in enumerate(actor_tokens, start=1):
            like_url = f"{api}/api/auth/posts/{post_uuid}/like"
            if args.unlike_first:
                code, body = http_json("DELETE", like_url, token)
                print(f"[r{round_i} {i}/{len(actor_tokens)}] @{username} unlike -> {code} {body}")
                time.sleep(0.4)
            code, body = http_json("POST", like_url, token, {})
            print(f"[r{round_i} {i}/{len(actor_tokens)}] @{username} like   -> {code} {body}")
            if code >= 400:
                print("abort on error", file=sys.stderr)
                return 1
            if i < len(actor_tokens) or (args.rounds == 0 or round_i < args.rounds):
                time.sleep(args.interval)

    code, inbox = http_json("GET", f"{api}/api/auth/notifications?take=5", author_token)
    print("---")
    print(f"author inbox status={code}")
    if isinstance(inbox, dict):
        items = inbox.get("items") or inbox.get("Items") or []
        for it in items[:5]:
            if not isinstance(it, dict):
                continue
            print(
                " ",
                it.get("type") or it.get("Type"),
                "|",
                it.get("text") or it.get("Text"),
                "| group=",
                it.get("groupKey") or it.get("GroupKey"),
            )
    print("done")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        raise SystemExit(130)
