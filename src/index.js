/**
 * Job Book — Cloudflare Worker.
 *
 * Serves the app behind a shared passphrase, and syncs records between
 * two team members' devices through D1. Records are JSON blobs with a
 * millisecond `updatedAt`; whichever write is newer wins, so the two
 * phones converge without either clobbering the other.
 *
 * Secrets (set with `wrangler secret put`):
 *   PASSPHRASE      the shared passphrase
 *   SESSION_SECRET  random string used to sign the session cookie
 */

import APP_HTML from "./app.html";
import LOGIN_HTML from "./login.html";

const COOKIE = "jb_session";
const SESSION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days for a trusted work device
const TABLES = ["clients", "visits", "notes"];

/* ------------------------------------------------------------------ auth */

const enc = new TextEncoder();

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function mintSession(env) {
  const expiry = String(Date.now() + SESSION_MS);
  return `${expiry}.${await hmac(env.SESSION_SECRET, expiry)}`;
}

async function sessionValid(env, token) {
  if (!token || !env.SESSION_SECRET || !env.PASSPHRASE) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return false;
  const expiry = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(expiry) || Number(expiry) < Date.now()) return false;
  return constantTimeEqual(sig, await hmac(env.SESSION_SECRET, expiry));
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function sessionCookie(token) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}`;
}

/* --------------------------------------------------------------- storage */

async function readSince(env, since) {
  const out = { clients: [], visits: [], settings: null, now: Date.now() };

  for (const table of TABLES) {
    const { results } = await env.DB
      .prepare(`SELECT data FROM ${table} WHERE updated_at > ?1 ORDER BY updated_at`)
      .bind(since).all();
    out[table] = results.map((row) => JSON.parse(row.data));
  }

  const { results } = await env.DB
    .prepare("SELECT data FROM settings WHERE id = 'app' AND updated_at > ?1")
    .bind(since).all();
  if (results.length) out.settings = JSON.parse(results[0].data);

  return out;
}

async function applyChanges(env, changes) {
  const statements = [];

  for (const table of TABLES) {
    for (const record of changes?.[table] || []) {
      if (!record || typeof record.id !== "string") continue;
      const stamp = Number(record.updatedAt) || Date.now();
      // A tombstoned note takes its photo with it — an attachment has no
      // life of its own once the note that carried it is gone. Folded into
      // the same batch as the note write itself, so both commit together.
      // A stale tombstone must not erase a newer note's still-live photo.
      if (table === "notes" && record.deleted && record.photoId) {
        statements.push(env.DB.prepare(
          "DELETE FROM photos WHERE id = ?1 AND NOT EXISTS " +
          "(SELECT 1 FROM notes WHERE id = ?2 AND updated_at >= ?3)"
        ).bind(record.photoId, record.id, stamp));
      }
      statements.push(
        env.DB.prepare(
          `INSERT INTO ${table} (id, data, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
           WHERE excluded.updated_at > ${table}.updated_at`
        ).bind(record.id, JSON.stringify(record), stamp)
      );
    }
  }

  const settings = changes?.settings;
  if (settings && Number(settings.updatedAt)) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO settings (id, data, updated_at) VALUES ('app', ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
         WHERE excluded.updated_at > settings.updated_at`
      ).bind(JSON.stringify(settings), Number(settings.updatedAt))
    );
  }

  if (statements.length) await env.DB.batch(statements);
  return statements.length;
}

/* ----------------------------------------------------------------- photos */
/* Stored in D1 as a BLOB column rather than R2 — R2 needs a card on file
   to activate even for free-tier usage, and this app's volume (a handful
   of compressed photos a week) sits nowhere near D1's free storage cap. */

const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // client already compresses to ~1600px JPEG

async function handlePhotoUpload(request, env) {
  const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim();
  if (!contentType.startsWith("image/")) return json({ error: "not_an_image" }, 400);

  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_PHOTO_BYTES) return json({ error: "too_large" }, 413);

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_PHOTO_BYTES) return json({ error: "too_large" }, 413);

  const key = `p-${crypto.randomUUID()}`;
  await env.DB.prepare(
    "INSERT INTO photos (id, content_type, data, created_at) VALUES (?1, ?2, ?3, ?4)"
  ).bind(key, contentType, bytes, Date.now()).run();
  return json({ key });
}

async function handlePhotoGet(key, env) {
  const row = await env.DB.prepare("SELECT content_type, data FROM photos WHERE id = ?1").bind(key).first();
  if (!row) return new Response("Not found", { status: 404 });
  // A BLOB column can come back as a plain byte-value Array rather than an
  // ArrayBuffer/Uint8Array — Response silently drops a bare Array as a body,
  // so it's always normalised through Uint8Array first, which accepts any
  // of the shapes D1 might hand back.
  return new Response(new Uint8Array(row.data), {
    headers: {
      "Content-Type": row.content_type || "application/octet-stream",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

/* ---------------------------------------------------------------- routes */

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

const html = (body, status = 200, headers = {}) =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      ...headers,
    },
  });

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function loginPage(error) {
  const block = error ? `<div class="err">${escapeHtml(error)}</div>` : "";
  return LOGIN_HTML.replace("{{ERROR}}", block);
}

async function handleLogin(request, env) {
  const form = await request.formData().catch(() => null);
  const supplied = form?.get("passphrase");

  if (!env.PASSPHRASE || !env.SESSION_SECRET) {
    return html(loginPage("The app isn't set up yet — its passphrase secret is missing."), 500);
  }
  if (typeof supplied !== "string" || !constantTimeEqual(supplied, env.PASSPHRASE)) {
    await new Promise((r) => setTimeout(r, 600)); // blunt the guessing rate
    return html(loginPage("That passphrase didn't match. Try again."), 401);
  }

  return new Response(null, {
    status: 303,
    headers: { Location: "/", "Set-Cookie": sessionCookie(await mintSession(env)) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const authed = await sessionValid(env, readCookie(request, COOKIE));

    if (path === "/login" && request.method === "POST") return handleLogin(request, env);

    if (path === "/logout") {
      return new Response(null, {
        status: 303,
        headers: { Location: "/", "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` },
      });
    }

    if (path === "/") {
      if (!authed) return html(loginPage());
      return html(APP_HTML);
    }

    if (path.startsWith("/api/")) {
      if (!authed) return json({ error: "not_signed_in" }, 401);

      if (path === "/api/state" && request.method === "GET") {
        const since = Number(url.searchParams.get("since")) || 0;
        return json(await readSince(env, since));
      }

      if (path === "/api/sync" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return json({ error: "bad_request" }, 400);
        await applyChanges(env, body.changes || {});
        return json(await readSince(env, Number(body.since) || 0));
      }

      if (path === "/api/photo" && request.method === "POST") {
        return handlePhotoUpload(request, env);
      }

      if (path.startsWith("/api/photo/") && request.method === "GET") {
        return handlePhotoGet(path.slice("/api/photo/".length), env);
      }

      return json({ error: "not_found" }, 404);
    }

    return new Response("Not found", { status: 404 });
  },
};
