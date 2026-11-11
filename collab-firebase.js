/* Mes voyages — service de partage sur Firebase.
   Remplace le serveur ChatGPT (/api/collab/…) en gardant exactement les mêmes réponses,
   pour que toute l'interface d'origine (pastilles, historique, invitations) fonctionne telle quelle. */
(() => {
"use strict";
const CFG = window.FIREBASE_CONFIG;
const WEB_URL = "https://mineraliaclem.github.io/mes-voyages-web/";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const COVER = "__cover";

let db = null, auth = null, FV = null, FP = null, me = null;
const cache = {};           // id du voyage partagé -> { doc, photos: Map, history: [], reads: {}, loaded… }
let tripsLoaded = null, resolveTripsLoaded = null, listening = false;
const listeners = new Set();

// Applique les données partagées reçues sur le voyage en gardant les mêmes objets (villes, dépenses, idées…),
// pour que les fenêtres de modification ouvertes continuent de viser les bons éléments.
const SHARED_LISTS = ["cities", "items", "ideas", "photos", "preparation"];
window.mergeSharedData = (trip, incoming) => {
  const data = JSON.parse(JSON.stringify(incoming || {}));
  for (const [key, value] of Object.entries(data)) {
    if (SHARED_LISTS.includes(key) && Array.isArray(value)) {
      const old = new Map((trip[key] || []).map(x => [String(x.id), x]));
      const next = value.map(item => {
        const current = old.get(String(item.id));
        if (!current) return item;
        if (JSON.stringify(current) !== JSON.stringify(item)) {
          for (const k of Object.keys(current)) if (!(k in item)) delete current[k];
          Object.assign(current, item);
        }
        return current;
      });
      if (Array.isArray(trip[key])) { trip[key].length = 0; trip[key].push(...next); } else trip[key] = next;
    } else if (JSON.stringify(trip[key]) !== JSON.stringify(value)) trip[key] = value;
  }
  return trip;
};

window.inviteLink = code => WEB_URL + "?join=" + encodeURIComponent(code);
window.inviteMessage = (name, code, link) =>
  `Rejoins le voyage « ${name} » dans Mes voyages.\nSur Android : touche « Rejoindre un voyage partagé » et entre le code ${code}.` + (link ? `\nSur iPhone : ouvre ce lien dans Safari ${link}` : "");

const fail = (message, status = 500) => Object.assign(new Error(message), { status });
const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));
const withTimeout = (p, ms = 20000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(fail("Connexion trop lente, réessaie.", 503)), ms))]);

/* ---------- Connexion ---------- */
let readyPromise = null;
function ready() {
  if (me) return Promise.resolve(me);
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve, reject) => {
    if (!CFG || !window.firebase) { reject(fail("Partage non configuré", 503)); return; }
    try {
      if (!db) {
        firebase.initializeApp(CFG);
        db = firebase.firestore();
        try { db.settings({ ignoreUndefinedProperties: true }); } catch (e) {}
        db.enablePersistence({ synchronizeTabs: false }).catch(() => {});
        FV = firebase.firestore.FieldValue;
        FP = firebase.firestore.FieldPath;
        auth = firebase.auth();
      }
    } catch (e) { reject(e); return; }
    const stop = auth.onAuthStateChanged(user => {
      if (user) { stop(); me = user; startListening(); resolve(user); return; }
      auth.signInAnonymously().catch(err => { stop(); readyPromise = null; reject(fail("Connexion en ligne indisponible", 503)); });
    });
  });
  return readyPromise;
}
// Pas de réseau au démarrage : on réessaie dès qu'il revient
window.addEventListener("online", () => { if (!me && typeof connectedStartup === "function") connectedStartup(); });

/* ---------- Écoute en direct des voyages partagés ---------- */
function startListening() {
  if (listening) return;
  listening = true;
  tripsLoaded = new Promise(r => { resolveTripsLoaded = r; });
  db.collection("trips").where("memberIds", "array-contains", me.uid).onSnapshot(snap => {
    for (const ch of snap.docChanges()) {
      const id = ch.doc.id;
      if (ch.type === "removed") { unsubscribe(id); continue; }
      const c = cache[id] || subscribe(id);
      c.doc = ch.doc.data({ serverTimestamps: "estimate" });
      c.docLoaded = true;
    }
    resolveTripsLoaded();
    kick();
  }, err => { console.warn("[partage]", err); resolveTripsLoaded(); });
}

function subscribe(id) {
  const c = cache[id] = { doc: null, photos: new Map(), history: [], reads: {}, docLoaded: false, photosLoaded: false, historyLoaded: false, unsub: [] };
  const ref = db.collection("trips").doc(id);
  c.unsub.push(ref.collection("photos").onSnapshot(snap => {
    for (const ch of snap.docChanges()) {
      if (ch.type === "removed") c.photos.delete(ch.doc.id); else c.photos.set(ch.doc.id, ch.doc.data());
    }
    c.photosLoaded = true;
    kick();
  }, err => { c.photosLoaded = true; console.warn("[partage]", err); }));
  c.unsub.push(ref.collection("history").orderBy("at", "desc").limit(300).onSnapshot(snap => {
    const fresh = c.historyLoaded && !snap.metadata.fromCache
      ? snap.docChanges().filter(ch => ch.type === "added").map(ch => ch.doc.data()).filter(h => h.actor !== me.uid) : [];
    c.history = snap.docs.map(d => { const h = d.data({ serverTimestamps: "estimate" }); return { ...h, at: h.at && h.at.toMillis ? h.at.toMillis() : (h.t || Date.now()) }; });
    c.historyLoaded = true;
    for (const h of fresh) listeners.forEach(fn => fn({ type: "history", tripId: id, entry: h }));
    kick();
  }, err => { c.historyLoaded = true; console.warn("[partage]", err); }));
  c.unsub.push(ref.collection("reads").doc(me.uid).onSnapshot(snap => { c.reads = snap.exists ? snap.data() : {}; kick(); }, () => {}));
  return c;
}
function unsubscribe(id) {
  const c = cache[id];
  if (!c) return;
  c.unsub.forEach(u => { try { u(); } catch (e) {} });
  delete cache[id];
}

let kickTimer = 0;
function kick() {
  clearTimeout(kickTimer);
  kickTimer = setTimeout(() => {
    listeners.forEach(fn => fn({ type: "update" }));
    if (typeof pollSharedUpdates === "function") pollSharedUpdates();
  }, 120);
}

/* ---------- Mise en forme des réponses (comme le serveur d'origine) ---------- */
function photoList(c) {
  return [...c.photos.entries()].filter(([k]) => k !== COVER).map(([, p]) => p.value)
    .sort((a, b) => (a._order ?? 0) - (b._order ?? 0) || (+a.id) - (+b.id)).map(p => { const { _order, ...rest } = p; return rest; });
}
function remoteOf(id) {
  const c = cache[id], d = c.doc || {};
  const data = clone(d.data || {});
  data.photos = photoList(c);
  const cover = c.photos.get(COVER);
  if (cover && cover.value) data.cover = cover.value; else delete data.cover;
  return { id, owner: d.owner, version: d.version || 0, members: clone(d.members || []), unread: unreadOf(c), data };
}
function unreadOf(c) {
  const counts = {};
  const joined = c.reads._joinedVersion || 0;
  for (const h of c.history) {
    if (h.actor === me.uid) continue;
    const seen = Math.max(c.reads[h.actor] || 0, joined);
    if ((h.version || 0) > seen) counts[h.actor] = (counts[h.actor] || 0) + (h.entries ? h.entries.length : 1);
  }
  return Object.entries(counts).map(([actor, count]) => ({ actor, count }));
}
const ready4 = c => c && c.docLoaded && c.photosLoaded && c.historyLoaded;

/* ---------- Description des modifications (historique) ---------- */
function describeOps(before, ops) {
  const entries = [], cityName = id => ((before.cities || []).find(c => String(c.id) === String(id)) || ops.find(o => o.collection === "cities" && String(o.id) === String(id))?.after || {}).name || "Voyage";
  const action = op => op.before ? (op.after ? "Modification" : "Suppression") : "Ajout";
  const price = x => x.free ? "Gratuit" : (typeof money === "function" ? money(x.p || 0, x.currency || "EUR") : `${x.p || 0} ${x.currency || "EUR"}`);
  const date = d => typeof fd === "function" ? fd(d) : d;
  const changed = (a, b, keys) => keys.filter(k => JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null));
  const photosByCity = {};
  for (const op of ops) {
    if (op.field) {
      if (op.field === "name") entries.push({ title: `Modification · Nom du voyage`, detail: op.after || "" });
      else if (op.field === "start" || op.field === "end") { if (!entries.some(e => e.title.endsWith("Dates du voyage"))) entries.push({ title: "Modification · Dates du voyage", detail: "Voyage" }); }
      else if (op.field === "participants" || op.field === "pers") { if (!entries.some(e => e.title.endsWith("Voyageurs"))) entries.push({ title: "Modification · Voyageurs", detail: "Voyage" }); }
      else if (op.field === "cover") entries.push({ title: `${op.after ? "Modification" : "Suppression"} · Image du voyage`, detail: "Voyage" });
      continue;
    }
    const x = op.after || op.before, act = action(op);
    if (op.collection === "photos") { const k = `${act}|${x.c ?? ""}`; (photosByCity[k] = photosByCity[k] || []).push(x); continue; }
    if (op.collection === "items") {
      const title = x.n || x.transportType || x.cat, extra = [];
      if (act === "Modification") {
        const ch = changed(op.before, op.after, ["p", "currency", "free", "d", "nt", "nights", "f", "n", "transportType", "c"]);
        if (ch.some(k => ["p", "currency", "free"].includes(k))) extra.push(`${price(op.before)} → ${price(op.after)}`);
        if (ch.includes("f")) extra.push(op.after.f ? "coup de cœur ❤️" : "coup de cœur retiré");
        if (ch.includes("d")) extra.push(op.after.d ? `le ${date(op.after.d)}` : "date retirée");
        if (ch.includes("nights")) extra.push(`${op.after.nights} nuit${op.after.nights > 1 ? "s" : ""}`);
        if (ch.includes("nt")) extra.push("notes");
        if (ch.includes("c")) extra.push(`déplacé vers ${cityName(op.after.c)}`);
      } else extra.push(price(x));
      const detail = [x.cat, cityName(x.c), ...extra].join(" · ");
      entries.push({ title: `${act} · ${title}`, detail, target: { type: "item", id: x.id, city: x.c, category: x.cat, title, detail: `${x.cat} · ${cityName(x.c)}` } });
    } else if (op.collection === "ideas") {
      const extra = act === "Modification" && !!op.before.done !== !!op.after.done ? [op.after.done ? "réalisée ✓" : "à refaire"] : [];
      entries.push({ title: `${act} · ${x.t}`, detail: ["À faire", cityName(x.c), ...extra].join(" · "), target: { type: "idea", id: x.id, city: x.c, title: x.t, detail: `À faire · ${cityName(x.c)}` } });
    } else if (op.collection === "preparation") {
      const extra = act === "Modification" && !!op.before.done !== !!op.after.done ? [op.after.done ? "coché ✓" : "décoché"] : [];
      entries.push({ title: `${act} · ${x.text}`, detail: ["Pense-bête", ...extra].join(" · "), target: { type: "prep", id: x.id, title: x.text, detail: "Pense-bête" } });
    } else if (op.collection === "cities") {
      const extra = [];
      if (act === "Modification") {
        const ch = changed(op.before, op.after, ["name", "start", "end", "notes", "rating", "geo"]);
        if (!ch.length) continue; // simple changement d'ordre
        if (ch.includes("start") || ch.includes("end")) extra.push(`${date(op.after.start)} → ${date(op.after.end)}`);
        if (ch.includes("notes")) extra.push("carnet");
        if (ch.includes("rating")) extra.push(op.after.rating ? "★".repeat(op.after.rating) : "note retirée");
        if (ch.includes("name")) extra.push(`ancien nom : ${op.before.name}`);
        if (ch.includes("geo")) extra.push("position sur la carte");
      } else if (x.start) extra.push(`${date(x.start)} → ${date(x.end)}`);
      entries.push({ title: `${act} · ${x.name}`, detail: ["Ville", ...extra].join(" · "), target: act === "Suppression" ? undefined : { type: "city", id: x.id, city: x.id, title: x.name, detail: "Ville" } });
    }
  }
  for (const [k, list] of Object.entries(photosByCity)) {
    const [act, c] = k.split("|"), n = list.length, city = c ? cityName(c) : "Voyage";
    entries.push({ title: `${act} · ${n} photo${n > 1 ? "s" : ""}`, detail: `Photos · ${city}`, target: act === "Suppression" ? undefined : { type: "photo", id: list[0].id, city: c ? +c || c : undefined, title: "Photos", detail: city } });
  }
  return entries;
}

function applyOps(data, ops) {
  data = clone(data) || {};
  for (const op of ops) {
    if (op.field) { if (op.after === null) delete data[op.field]; else data[op.field] = op.after; continue; }
    const arr = data[op.collection] || (data[op.collection] = []);
    const i = arr.findIndex(x => String(x.id) === String(op.id));
    if (op.after === null) { if (i >= 0) arr.splice(i, 1); }
    else if (i >= 0) arr[i] = op.after; else arr.push(op.after);
  }
  return data;
}

function splitPhotos(data) {
  const out = clone(data) || {}, photos = out.photos || [], cover = out.cover;
  delete out.photos; delete out.cover;
  return { data: out, photos, cover };
}

function makeCode() { let c = ""; const a = new Uint32Array(6); crypto.getRandomValues(a); for (const n of a) c += ALPHABET[n % ALPHABET.length]; return c; }
function thumb(src, size = 160) {
  return new Promise(resolve => {
    if (!src) return resolve("");
    const im = new Image();
    im.onload = () => { const k = Math.min(1, size / Math.max(im.width, im.height)), cv = document.createElement("canvas"); cv.width = Math.round(im.width * k); cv.height = Math.round(im.height * k); cv.getContext("2d").drawImage(im, 0, 0, cv.width, cv.height); resolve(cv.toDataURL("image/jpeg", .75)); };
    im.onerror = () => resolve("");
    im.src = src;
  });
}
const myName = () => (T.profile && T.profile.name) || "Voyageur";
const mySlot = data => { const p = (data.participants || []).find(p => T.profile && p.profileId === T.profile.id); return p ? p.id : (data.participants || [])[0]?.id ?? 0; };

/* ---------- Les routes du service ---------- */
async function collabBackend(path, method = "GET", payload) {
  const [route, query = ""] = path.split("?");
  const parts = route.split("/").map(decodeURIComponent);
  if (route === "me") {
    await withTimeout(ready(), 15000);
    if (T.profile && T.profile.id !== me.uid) {
      // Le profil prend l'identifiant de connexion : on met à jour les voyages qui le citent
      const old = T.profile.id;
      for (const t of T.trips) for (const p of t.participants || []) if (p.profileId === old) p.profileId = me.uid;
      T.profile.id = me.uid;
      try { (typeof connectedOriginalSave === "function" ? connectedOriginalSave : save)(); } catch (e) {}
    }
    return { signedIn: true, userId: me.uid, profile: T.profile ? { ...T.profile, id: me.uid } : null };
  }
  await withTimeout(ready(), 15000);
  if (route === "profile" && method === "POST") {
    const photo = await thumb(payload && payload.photo);
    for (const id of Object.keys(cache)) {
      const ref = db.collection("trips").doc(id);
      db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const members = (snap.data().members || []).map(m => m.user === me.uid ? { ...m, name: payload.name, photo } : m);
        tx.update(ref, { members });
      }).catch(() => {});
    }
    return { ok: true };
  }
  if (route === "trips" && method === "GET") {
    await tripsLoaded;
    return Object.keys(cache).filter(id => ready4(cache[id])).map(remoteOf);
  }
  if (route === "trips" && method === "POST") {
    const ref = db.collection("trips").doc(), { data, photos, cover } = splitPhotos(payload);
    const member = { user: me.uid, slot: mySlot(payload), name: myName(), photo: await thumb(T.profile && T.profile.photo) };
    const batch = db.batch();
    batch.set(ref, { owner: me.uid, version: 1, memberIds: [me.uid], members: [member], data, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
    await withTimeout(batch.commit());
    const writes = db.batch();
    photos.forEach((p, i) => writes.set(ref.collection("photos").doc(String(p.id)), { value: { ...p, _order: i } }));
    if (cover) writes.set(ref.collection("photos").doc(COVER), { value: cover });
    writes.set(ref.collection("reads").doc(me.uid), { _joinedVersion: 1 });
    writes.commit().catch(err => console.warn("[partage] photos", err));
    const c = cache[ref.id] || subscribe(ref.id);
    c.doc = { owner: me.uid, version: 1, members: [member], memberIds: [me.uid], data };
    photos.forEach((p, i) => c.photos.set(String(p.id), { value: { ...p, _order: i } }));
    if (cover) c.photos.set(COVER, { value: cover });
    c.docLoaded = c.photosLoaded = c.historyLoaded = true;
    return remoteOf(ref.id);
  }
  if (parts[0] === "trip") {
    const id = parts[1], ref = db.collection("trips").doc(id);
    if (parts.length === 2 && method === "GET") { if (!cache[id]) throw fail("Voyage introuvable", 404); return remoteOf(id); }
    if (parts.length === 2 && method === "PATCH") {
      const ops = (payload && payload.ops) || [];
      const photoOps = ops.filter(o => o.collection === "photos" || o.field === "cover"), dataOps = ops.filter(o => !(o.collection === "photos" || o.field === "cover"));
      const c = cache[id] || subscribe(id);
      let result = null;
      await withTimeout(db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw fail("Ce voyage n’est plus partagé.", 404);
        const d = snap.data(), before = d.data || {};
        const next = applyOps(before, dataOps), version = (d.version || 0) + 1;
        const entries = describeOps(before, ops);
        tx.update(ref, { data: next, version, updatedAt: FV.serverTimestamp() });
        const order = photoList(c).length;
        photoOps.forEach((op, i) => {
          if (op.field === "cover") { const pr = ref.collection("photos").doc(COVER); op.after ? tx.set(pr, { value: op.after }) : tx.delete(pr); }
          else { const pr = ref.collection("photos").doc(String(op.id)); op.after ? tx.set(pr, { value: { ...op.after, _order: c.photos.get(String(op.id))?.value?._order ?? order + i } }) : tx.delete(pr); }
        });
        if (entries.length) tx.set(ref.collection("history").doc(), { actor: me.uid, name: myName(), version, at: FV.serverTimestamp(), t: Date.now(), entries, lines: entries.map(e => e.title) });
        result = { d: { ...d, data: next, version } };
      }));
      // Mise à jour immédiate du cache (le direct confirmera)
      c.doc = result.d;
      for (const op of photoOps) {
        if (op.field === "cover") { if (op.after) c.photos.set(COVER, { value: op.after }); else c.photos.delete(COVER); }
        else if (op.after) c.photos.set(String(op.id), { value: { ...op.after, _order: c.photos.get(String(op.id))?.value?._order ?? c.photos.size } });
        else c.photos.delete(String(op.id));
      }
      return remoteOf(id);
    }
    if (parts.length === 2 && method === "DELETE") {
      // Quitter le voyage : il reste disponible pour les autres participants
      await withTimeout(db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const d = snap.data();
        tx.update(ref, { memberIds: (d.memberIds || []).filter(u => u !== me.uid), members: (d.members || []).filter(m => m.user !== me.uid) });
      }));
      unsubscribe(id);
      return { ok: true };
    }
    if (parts[2] === "invite" && method === "POST") {
      const d = cache[id] && cache[id].doc;
      if (!d) throw fail("Voyage introuvable", 404);
      const claimed = new Set((d.members || []).map(m => String(m.slot)));
      const info = { trip: id, by: me.uid, name: d.data?.name || "Voyage", participants: (d.data?.participants || []).map(p => ({ id: p.id, name: p.name, claimed: claimed.has(String(p.id)) })), createdAt: FV.serverTimestamp() };
      for (let i = 0; i < 6; i++) {
        const code = makeCode();
        try { await withTimeout(db.collection("invites").doc(code).set(info)); return { token: code }; }
        catch (e) { if (e.code !== "permission-denied") throw e; }
      }
      throw fail("Impossible de créer l’invitation, réessaie.");
    }
    if (parts[2] === "history" && method === "GET") {
      const actor = new URLSearchParams(query).get("actor"), c = cache[id];
      if (!c) return [];
      const seen = Math.max(c.reads[actor] || 0, c.reads._joinedVersion || 0);
      return c.history.filter(h => h.actor === actor).map(h => ({ at: h.at, version: h.version, unread: actor !== me.uid && (h.version || 0) > seen, entries: h.entries || [] }));
    }
    if (parts[2] === "read" && method === "POST") {
      const c = cache[id];
      if (c) c.reads = { ...c.reads, [payload.actor]: Math.max(c.reads[payload.actor] || 0, payload.version) };
      ref.collection("reads").doc(me.uid).set({ [payload.actor]: payload.version }, { merge: true }).catch(() => {});
      return { ok: true };
    }
  }
  if (parts[0] === "invite") {
    const code = (parts[1] || "").toUpperCase().trim();
    const inv = await withTimeout(db.collection("invites").doc(code).get({ source: "server" })).catch(e => { throw e.code === "permission-denied" ? fail("Code introuvable", 404) : e; });
    if (!inv.exists) throw fail("Code introuvable : vérifie-le.", 404);
    const info = inv.data();
    if (method === "GET") return { name: info.name, participants: info.participants || [], alreadyJoined: !!cache[info.trip] };
    if (method === "POST") {
      const ref = db.collection("trips").doc(info.trip);
      const member = { user: me.uid, slot: payload.slot, name: myName(), photo: await thumb(T.profile && T.profile.photo) };
      await withTimeout(ref.update(new FP("memberIds"), FV.arrayUnion(me.uid), new FP("members"), FV.arrayUnion(member)));
      const snap = await withTimeout(ref.get({ source: "server" }));
      const d = snap.data();
      await withTimeout(ref.collection("reads").doc(me.uid).set({ _joinedVersion: d.version || 0 }, { merge: true }));
      const photos = await withTimeout(ref.collection("photos").get({ source: "server" }));
      // Place reprise : l'ancien compte (autre appareil ou navigateur) libère la place
      const stale = (d.members || []).filter(m => String(m.slot) === String(payload.slot) && m.user !== me.uid);
      if (stale.length) {
        await withTimeout(db.runTransaction(async tx => {
          const fresh = (await tx.get(ref)).data();
          const gone = new Set((fresh.members || []).filter(m => String(m.slot) === String(payload.slot) && m.user !== me.uid).map(m => m.user));
          tx.update(ref, { members: (fresh.members || []).filter(m => !gone.has(m.user)), memberIds: (fresh.memberIds || []).filter(u => !gone.has(u)) });
        }));
        d.members = (d.members || []).filter(m => !stale.includes(m));
        d.memberIds = (d.memberIds || []).filter(u => !stale.some(m => m.user === u));
      }
      const c = cache[info.trip] || subscribe(info.trip);
      c.doc = d; c.reads = { _joinedVersion: d.version || 0 };
      photos.forEach(p => c.photos.set(p.id, p.data()));
      c.docLoaded = c.photosLoaded = c.historyLoaded = true;
      return remoteOf(info.trip);
    }
  }
  throw fail("Service indisponible", 404);
}

window.collabBackend = collabBackend;
window.CollabFirebase = { cache, on: fn => listeners.add(fn), me: () => me, remoteOf };
})();
