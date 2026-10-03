/* End-to-end check against a running `wrangler dev` on :8788. */
const BASE = "http://127.0.0.1:8788";
const PASS = "local test passphrase";

let failures = 0;
const ok = (cond, label, extra) => {
  console.log((cond ? "ok   " : "FAIL ") + label + (extra && !cond ? "  -> " + extra : ""));
  if (!cond) failures++;
};

async function waitForServer(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + "/", { redirect: "manual" });
      if (r.status) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function cookieFrom(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")];
  const hit = (raw || []).find((c) => c && c.startsWith("jb_session="));
  return hit ? hit.split(";")[0] : null;
}

(async () => {
  if (!(await waitForServer())) { console.error("server never came up"); process.exit(1); }

  // --- unauthenticated -------------------------------------------------
  let res = await fetch(BASE + "/");
  let body = await res.text();
  ok(res.status === 200 && body.includes("Passphrase"), "GET / shows the login page when signed out");
  ok(!body.includes("Sample Client 1"), "login page leaks no client data");

  res = await fetch(BASE + "/api/state");
  ok(res.status === 401, "GET /api/state is refused when signed out", "got " + res.status);

  // --- wrong passphrase ------------------------------------------------
  res = await fetch(BASE + "/login", {
    method: "POST", redirect: "manual",
    body: new URLSearchParams({ passphrase: "wrong" }),
  });
  ok(res.status === 401, "wrong passphrase is rejected", "got " + res.status);
  ok(!cookieFrom(res), "wrong passphrase sets no session cookie");

  // --- correct passphrase ----------------------------------------------
  res = await fetch(BASE + "/login", {
    method: "POST", redirect: "manual",
    body: new URLSearchParams({ passphrase: PASS }),
  });
  const cookie = cookieFrom(res);
  ok(res.status === 303 && !!cookie, "correct passphrase signs in", "status " + res.status);
  const auth = { Cookie: cookie };

  // --- the app itself ---------------------------------------------------
  res = await fetch(BASE + "/", { headers: auth });
  body = await res.text();
  ok(res.status === 200 && body.includes("Job Book"), "GET / serves the app once signed in");
  ok(body.includes("id=\"view\"") && body.includes("function render()"), "app markup and script are intact");

  // --- seeded data ------------------------------------------------------
  res = await fetch(BASE + "/api/state?since=0", { headers: auth });
  let data = await res.json();
  ok(data.clients.length === 8, "8 clients seeded", "got " + data.clients.length);
  const seededVisits = ["v-1", "v-2", "v-3", "v-4", "v-5"];
  ok(seededVisits.every((id) => data.visits.some((v) => v.id === id)),
     "all 5 seeded visits are present");
  ok(!!data.settings && data.settings.nextInvoiceNo === 103, "settings seeded");
  ok(data.clients.every((c) => typeof c.wantsInvoice === "boolean"),
     "every client carries an invoicing preference");

  const sampleClientOne = data.clients.find((c) => c.id === "c-sample-1");
  ok(sampleClientOne && sampleClientOne.rate === 60 && sampleClientOne.hours === 4, "Sample Client 1's rate and hours survived the round trip");
  ok(sampleClientOne && sampleClientOne.days.join(",") === "Mon,Fri", "array fields survive JSON storage");

  // --- writing a change -------------------------------------------------
  const stamp = Date.now();
  const newVisit = {
    id: "v-test-1", clientId: "c-sample-2", date: "2026-08-26", hours: 3, amount: 150,
    status: "done", crew: "Teammate", notes: "Test run.", invoiceNo: "", invoiced: false,
    paid: false, updatedAt: stamp,
  };
  res = await fetch(BASE + "/api/sync", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ since: 0, changes: { visits: [newVisit] } }),
  });
  data = await res.json();
  ok(res.status === 200, "sync accepts a new visit");
  ok(data.visits.some((v) => v.id === "v-test-1"), "the new visit comes back in the same response");

  // --- the other phone sees it -----------------------------------------
  res = await fetch(BASE + "/api/state?since=" + (stamp - 1), { headers: auth });
  data = await res.json();
  ok(data.visits.length === 1 && data.visits[0].id === "v-test-1",
     "an incremental poll returns only what changed", "got " + data.visits.length + " visits");

  // --- last-write-wins --------------------------------------------------
  await fetch(BASE + "/api/sync", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ since: 0, changes: { visits: [{ ...newVisit, notes: "STALE", updatedAt: stamp - 5000 }] } }),
  });
  res = await fetch(BASE + "/api/state?since=0", { headers: auth });
  data = await res.json();
  let v = data.visits.find((x) => x.id === "v-test-1");
  ok(v && v.notes === "Test run.", "an older write does not overwrite a newer one", "notes = " + (v && v.notes));

  await fetch(BASE + "/api/sync", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ since: 0, changes: { visits: [{ ...newVisit, notes: "FRESH", updatedAt: stamp + 5000 }] } }),
  });
  res = await fetch(BASE + "/api/state?since=0", { headers: auth });
  data = await res.json();
  v = data.visits.find((x) => x.id === "v-test-1");
  ok(v && v.notes === "FRESH", "a newer write does overwrite", "notes = " + (v && v.notes));

  // --- deletion travels -------------------------------------------------
  await fetch(BASE + "/api/sync", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ since: 0, changes: { visits: [{ ...newVisit, deleted: true, updatedAt: stamp + 9000 }] } }),
  });
  res = await fetch(BASE + "/api/state?since=0", { headers: auth });
  data = await res.json();
  v = data.visits.find((x) => x.id === "v-test-1");
  ok(v && v.deleted === true, "a delete travels as a tombstone rather than vanishing");

  // --- notes ------------------------------------------------------------
  res = await fetch(BASE + "/api/state?since=0", { headers: auth });
  data = await res.json();
  ok(Array.isArray(data.notes) && data.notes.length === 4, "4 notes seeded",
     "got " + (data.notes || []).length);
  ok(data.notes.some((n) => n.visitId === "" && n.clientId === "c-sample-2"),
     "a standing client note (no visit) round-trips");

  // Two people writing notes on the same visit at the same moment must both
  // survive — this is why notes are their own records, not a shared field.
  const t = Date.now();
  await fetch(BASE + "/api/sync", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ since: 0, changes: { notes: [
      { id: "n-teammate", clientId: "c-sample-1", visitId: "v-3", by: "Teammate",
        text: "Oven done, ran out of spray.", at: t, updatedAt: t },
    ] } }),
  });
  await fetch(BASE + "/api/sync", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ since: 0, changes: { notes: [
      { id: "n-owner", clientId: "c-sample-1", visitId: "v-3", by: "Owner",
        text: "Chased payment again.", at: t + 1, updatedAt: t + 1 },
    ] } }),
  });
  res = await fetch(BASE + "/api/state?since=0", { headers: auth });
  data = await res.json();
  const onV3 = data.notes.filter((n) => n.visitId === "v-3" && !n.deleted);
  ok(onV3.length === 2, "simultaneous notes from both people both survive",
     "got " + onV3.length);
  ok(onV3.some((n) => n.by === "Teammate") && onV3.some((n) => n.by === "Owner"),
     "each note keeps its own author");

  // Editing one note must not disturb the other.
  await fetch(BASE + "/api/sync", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ since: 0, changes: { notes: [
      { id: "n-teammate", clientId: "c-sample-1", visitId: "v-3", by: "Teammate",
        text: "Oven done. Bring spray next time.", at: t, updatedAt: t + 9000 },
    ] } }),
  });
  res = await fetch(BASE + "/api/state?since=0", { headers: auth });
  data = await res.json();
  const teammateNote = data.notes.find((n) => n.id === "n-teammate");
  const ownerNote = data.notes.find((n) => n.id === "n-owner");
  ok(teammateNote && /Bring spray/.test(teammateNote.text), "a note edit lands");
  ok(ownerNote && ownerNote.text === "Chased payment again.", "the other person's note is untouched");

  // --- forged cookie ----------------------------------------------------
  res = await fetch(BASE + "/api/state", { headers: { Cookie: "jb_session=" + (Date.now() + 99999) + ".forged" } });
  ok(res.status === 401, "a forged session cookie is refused", "got " + res.status);

  // --- new client (add) --------------------------------------------------
  const newClient = {
    id: "c-test-1", name: "Test Client", status: "active", wantsInvoice: false,
    service: "Weekly Home Assistant Match", plan: "weekly", days: ["Mon"],
    hours: 2, rate: 50, anchor: null, jobNo: "", crew: "Teammate",
    phone: "0400000000", email: "test@example.com", billTo: "", address: "1 Test St",
    suburb: "Testville", window: "", pets: "", access: "", priorities: "", home: "",
    notes: "", flag: "", updatedAt: Date.now(),
  };
  res = await fetch(BASE + "/api/sync", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ since: 0, changes: { clients: [newClient] } }),
  });
  data = await res.json();
  ok(res.status === 200 && data.clients.some((c) => c.id === "c-test-1"), "a new client can be added");

  res = await fetch(BASE + "/api/state?since=0", { headers: auth });
  data = await res.json();
  ok(data.clients.length === 9, "the new client persists across a fresh read", "got " + data.clients.length);

  // --- remove client (moves to former, does not delete) -------------------
  await fetch(BASE + "/api/sync", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ since: 0, changes: { clients: [{ ...newClient, status: "ended", updatedAt: Date.now() }] } }),
  });
  res = await fetch(BASE + "/api/state?since=0", { headers: auth });
  data = await res.json();
  const removed = data.clients.find((c) => c.id === "c-test-1");
  ok(removed && removed.status === "ended", "removing a client sets status to ended, not deleted");
  ok(removed && removed.name === "Test Client", "the removed client's data is intact, not wiped");

  // --- one-off scheduled visit ---------------------------------------------
  const oneOff = {
    id: "v-oneoff-1", clientId: "c-sample-2", date: "2026-09-06", hours: 3, amount: 150,
    status: "scheduled", crew: "Teammate", invoiceNo: "", invoiced: false, paid: false,
    paidAt: "", updatedAt: Date.now(),
  };
  res = await fetch(BASE + "/api/sync", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ since: 0, changes: { visits: [oneOff] } }),
  });
  data = await res.json();
  ok(data.visits.some((v) => v.id === "v-oneoff-1" && v.status === "scheduled"),
     "a one-off scheduled visit round-trips with its own status");

  // --- moving an occurrence: suppress old date, add new date ---------------
  const moveStamp = Date.now();
  await fetch(BASE + "/api/sync", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ since: 0, changes: { visits: [
      { id: "v-move-old", clientId: "c-sample-7", date: "2026-09-04", hours: 0, amount: 0,
        status: "skipped", crew: "Teammate", invoiceNo: "", invoiced: false, paid: false, paidAt: "", updatedAt: moveStamp },
      { id: "v-move-new", clientId: "c-sample-7", date: "2026-09-06", hours: 2, amount: 100,
        status: "scheduled", crew: "Teammate", invoiceNo: "", invoiced: false, paid: false, paidAt: "", updatedAt: moveStamp },
    ] } }),
  });
  res = await fetch(BASE + "/api/state?since=0", { headers: auth });
  data = await res.json();
  const oldSide = data.visits.find((v) => v.id === "v-move-old");
  const newSide = data.visits.find((v) => v.id === "v-move-new");
  ok(oldSide && oldSide.status === "skipped", "moving an occurrence suppresses the old date");
  ok(newSide && newSide.status === "scheduled" && newSide.date === "2026-09-06", "and schedules the new date");

  // --- photos on notes ---------------------------------------------------
  // A well-known minimal valid 1x1 transparent PNG (67 bytes).
  const TINY_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );

  res = await fetch(BASE + "/api/photo", {
    method: "POST", headers: { ...auth, "Content-Type": "image/png" }, body: TINY_PNG,
  });
  data = await res.json();
  ok(res.status === 200 && typeof data.key === "string" && data.key.length > 0, "a photo can be uploaded");
  const photoKey = data.key;

  res = await fetch(BASE + "/api/photo", { method: "POST", body: TINY_PNG });
  ok(res.status === 401, "uploading a photo while signed out is refused", "got " + res.status);

  res = await fetch(BASE + "/api/photo", {
    method: "POST", headers: { ...auth, "Content-Type": "text/plain" }, body: "not a photo",
  });
  ok(res.status === 400, "uploading a non-image is rejected", "got " + res.status);

  res = await fetch(BASE + "/api/photo/" + photoKey, { headers: auth });
  const photoBytes = Buffer.from(await res.arrayBuffer());
  ok(res.status === 200, "the uploaded photo can be fetched back", "got " + res.status);
  ok(res.headers.get("content-type") === "image/png", "with the right content type",
     "got " + res.headers.get("content-type"));
  ok(photoBytes.equals(TINY_PNG), "and the exact same bytes come back");

  res = await fetch(BASE + "/api/photo/" + photoKey);
  ok(res.status === 401, "fetching a photo while signed out is refused", "got " + res.status);

  res = await fetch(BASE + "/api/photo/does-not-exist", { headers: auth });
  ok(res.status === 404, "a made-up photo key is not found", "got " + res.status);

  // attach it to a note
  await fetch(BASE + "/api/sync", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ since: 0, changes: { notes: [
      { id: "n-with-photo", clientId: "c-sample-2", visitId: "", by: "Teammate",
        text: "Fridge was mouldy, cleaned it out.", photoId: photoKey, at: Date.now(), updatedAt: Date.now() },
    ] } }),
  });
  res = await fetch(BASE + "/api/state?since=0", { headers: auth });
  data = await res.json();
  const withPhoto = data.notes.find((n) => n.id === "n-with-photo");
  ok(withPhoto && withPhoto.photoId === photoKey, "a note carries its photoId through sync");

  // A delayed delete from another phone must not remove a newer note's photo.
  await fetch(BASE + "/api/sync", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ since: 0, changes: { notes: [
      { ...withPhoto, deleted: true, updatedAt: withPhoto.updatedAt - 1 },
    ] } }),
  });
  res = await fetch(BASE + "/api/photo/" + photoKey, { headers: auth });
  ok(res.status === 200, "a stale note delete keeps the newer photo", "got " + res.status);

  // deleting the note frees its photo
  await fetch(BASE + "/api/sync", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ since: 0, changes: { notes: [
      { ...withPhoto, deleted: true, updatedAt: withPhoto.updatedAt + 1000 },
    ] } }),
  });
  res = await fetch(BASE + "/api/photo/" + photoKey, { headers: auth });
  ok(res.status === 404, "deleting the note also frees its photo from storage", "got " + res.status);

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
