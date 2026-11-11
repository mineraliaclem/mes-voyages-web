/* Mes voyages — synchronisation en direct des voyages partagés (Firebase Firestore).
   Chargé après le script principal : utilise T, S, home, render, save, toast, esc, fd, money, uid… */
(() => {
"use strict";
const CFG = window.FIREBASE_CONFIG;
const enabled = !!(CFG && CFG.apiKey && window.firebase);
const LS_BASE = "mes-voyages-sync-base", LS_SEEN = "mes-voyages-sync-seen";
const SECS = ["s", "cities", "items", "ideas", "prep"];
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let db = null, auth = null, me = null, ready = false, quiet = false;
let FV = null, FP = null;
const live = {};            // docId -> état temps réel
const timers = {};
let lastProfileSig = null;
let activity = null;        // panneau d'activité ouvert
let pendingRender = false;

const readLS = k => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch (e) { return {}; } };
const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
let bases = readLS(LS_BASE), seen = readLS(LS_SEEN);
const persistBases = () => writeLS(LS_BASE, bases);
const persistSeen = () => writeLS(LS_SEEN, seen);

/* ---------- Outils ---------- */
const sortKeys = x => x && typeof x === "object" && !Array.isArray(x)
  ? Object.keys(x).sort().reduce((o, k) => (o[k] = x[k], o), {}) : x;
const stable = v => v === undefined ? "∅" : JSON.stringify(v, (k, x) => sortKeys(x));
const same = (a, b) => stable(a) === stable(b);
const clean = o => o == null ? (o === null ? null : undefined) : JSON.parse(JSON.stringify(o));
const withoutOrder = o => { if (!o) return o; const { _o, ...r } = o; return r; };
const q = s => `« ${s} »`;
const tripByDoc = id => T.trips.find(t => t.sync && t.sync.doc === id);
const myName = () => (T.profile && T.profile.name) || "Quelqu’un";

function norm(t) {
  const byId = (arr, ordered) => Object.fromEntries((arr || []).map((x, i) => [String(x.id), clean(ordered ? { ...x, _o: i } : x)]));
  return {
    s: clean({
      name: t.name, start: t.start, end: t.end, pers: t.pers,
      currencies: t.currencies, rates: t.rates,
      participants: t.participants ? t.participants.map(p => ({ id: p.id, name: p.name, profileId: p.profileId ?? null })) : undefined
    }) || {},
    cities: byId(t.cities, true), items: byId(t.items), ideas: byId(t.ideas), prep: byId(t.preparation, true)
  };
}
const pick = d => ({ s: d.s || {}, cities: d.cities || {}, items: d.items || {}, ideas: d.ideas || {}, prep: d.prep || {} });

function merge3(B, L, R) {
  const M = {};
  for (const sec of SECS) {
    const b = B[sec] || {}, l = L[sec] || {}, r = R[sec] || {}, m = {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
      const v = same(l[k], b[k]) ? r[k] : l[k];
      if (v !== undefined) m[k] = v;
    }
    M[sec] = m;
  }
  return M;
}

function fill(arr, map, ordered) {
  arr = arr || [];
  const old = new Map(arr.map(x => [String(x.id), x]));
  const out = Object.entries(map || {}).map(([id, v]) => {
    const o = old.get(id) || {}, rest = withoutOrder(v);
    for (const k of Object.keys(o)) if (!(k in rest)) delete o[k];
    Object.assign(o, clean(rest));
    return [o, v._o ?? 0];
  });
  out.sort((a, b) => ordered ? a[1] - b[1] : (+a[0].id) - (+b[0].id));
  arr.length = 0;
  arr.push(...out.map(x => x[0]));
  return arr;
}

function applyTo(t, M) {
  for (const k of ["name", "start", "end", "pers", "currencies", "rates"]) if (M.s[k] !== undefined) t[k] = clean(M.s[k]);
  if (M.s.participants) {
    const old = new Map((t.participants || []).map(p => [String(p.id), p]));
    t.participants = M.s.participants.map(p => {
      const o = old.get(String(p.id)) || {};
      return Object.assign(o, { id: p.id, name: p.name, profileId: p.profileId ?? undefined });
    });
  }
  t.cities = fill(t.cities, M.cities, true);
  t.items = fill(t.items, M.items, false);
  t.ideas = fill(t.ideas, M.ideas, false);
  t.preparation = fill(t.preparation, M.prep, true);
}

function diffOps(B, L) {
  const ops = [];
  for (const sec of SECS) {
    const b = B[sec] || {}, l = L[sec] || {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(l)]))
      if (!same(b[k], l[k])) ops.push(new FP(sec, k), l[k] === undefined ? FV.delete() : l[k]);
  }
  return ops;
}

/* ---------- Description lisible des modifications ---------- */
function describe(B, L) {
  const out = [], bs = B.s || {}, ls = L.s || {};
  const cityName = id => (L.cities[String(id)] || B.cities[String(id)] || {}).name || "";
  const where = x => { const c = x && x.c ? cityName(x.c) : ""; return c ? ` à ${c}` : ""; };
  const diffMap = (b = {}, l = {}, fn) => {
    for (const k of new Set([...Object.keys(b), ...Object.keys(l)]))
      if (!same(withoutOrder(b[k]), withoutOrder(l[k]))) fn(k, b[k], l[k]);
  };
  if (!same(bs.name, ls.name) && ls.name) out.push(`a renommé le voyage en ${q(ls.name)}`);
  if (!same(bs.start, ls.start) || !same(bs.end, ls.end)) out.push(`a changé les dates du voyage : ${fd(ls.start)} → ${fd(ls.end)}`);
  if (!same(bs.participants, ls.participants) || !same(bs.pers, ls.pers)) {
    const mine = p => p && T.profile && p.profileId === T.profile.id;
    const joined = (ls.participants || []).some(mine) && !(bs.participants || []).some(mine);
    out.push(joined ? "a rejoint le voyage" : "a modifié les voyageurs");
  }
  if (!same(bs.currencies, ls.currencies) || !same(bs.rates, ls.rates)) out.push("a modifié les devises du voyage");

  const goneCities = new Set();
  diffMap(B.cities, L.cities, (id, b, l) => {
    if (!b) out.push(`a ajouté la ville ${l.name}`);
    else if (!l) { goneCities.add(id); out.push(`a supprimé la ville ${b.name}`); }
    else {
      const before = out.length;
      if (b.name !== l.name) out.push(`a renommé ${b.name} en ${l.name}`);
      if (b.start !== l.start || b.end !== l.end) out.push(`a changé les dates de ${l.name} : ${fd(l.start)} → ${fd(l.end)}`);
      if ((b.notes || "") !== (l.notes || "")) out.push(`a écrit dans le carnet de ${l.name}`);
      if (b.rating !== l.rating) out.push(l.rating == null ? `a retiré la note de ${l.name}` : `a donné ${l.rating} étoile${l.rating > 1 ? "s" : ""} à ${l.name}`);
      if (!same(b.geo, l.geo)) out.push(`a placé ${l.name} sur la carte`);
      if (out.length === before) out.push(`a modifié la ville ${l.name}`);
    }
  });

  const label = x => x.cat === "Transports" ? (x.transportType ? `le transport ${x.transportType.toLowerCase()}` : "un transport") : x.n ? q(x.n) : "une dépense";
  const price = x => x.free ? "gratuit" : money(x.p || 0, x.currency || "EUR");
  let withCity = 0;
  diffMap(B.items, L.items, (id, b, l) => {
    const x = l || b, city = cityName(x.c), ctx = ` (${x.cat}${city ? ` · ${city}` : ""})`;
    if (!l && goneCities.has(String(b.c))) { withCity++; return; }
    if (!b) out.push(`a ajouté ${label(l)}${ctx} — ${price(l)}`);
    else if (!l) out.push(`a supprimé ${label(b)}${ctx}`);
    else {
      const d = [];
      if (!!b.f !== !!l.f) out.push(l.f ? `a mis un coup de cœur ❤️ à ${label(l)}${ctx}` : `a retiré le coup de cœur de ${label(l)}${ctx}`);
      if (b.p !== l.p || (b.currency || "EUR") !== (l.currency || "EUR") || !!b.free !== !!l.free) d.push(`prix ${price(b)} → ${price(l)}`);
      if (b.n !== l.n && b.n && l.cat !== "Transports") d.push(`ancien nom ${q(b.n)}`);
      if ((b.d || "") !== (l.d || "")) d.push(l.d ? `date ${fd(l.d)}` : "date retirée");
      if ((b.nt || "") !== (l.nt || "")) d.push("notes");
      if (b.nights !== l.nights && l.nights) d.push(`${l.nights} nuit${l.nights > 1 ? "s" : ""}`);
      if (b.transportType !== l.transportType && b.transportType) d.push(`avant : ${b.transportType.toLowerCase()}`);
      const onlyHeart = !d.length && !!b.f !== !!l.f && same({ ...b, f: 0 }, { ...l, f: 0 });
      if (!onlyHeart) out.push(`a modifié ${label(l)}${ctx}${d.length ? ` : ${d.join(", ")}` : ""}`);
    }
  });
  if (withCity) out.push(`(${withCity} dépense${withCity > 1 ? "s" : ""} supprimée${withCity > 1 ? "s" : ""} avec la ville)`);

  diffMap(B.ideas, L.ideas, (id, b, l) => {
    if (!l && goneCities.has(String(b.c))) return;
    const x = l || b;
    if (!b) out.push(`a ajouté l’idée ${q(l.t)}${where(l)}`);
    else if (!l) out.push(`a retiré l’idée ${q(b.t)}${where(b)}`);
    else if (!!b.done !== !!l.done) out.push(`${l.done ? "a coché" : "a décoché"} l’idée ${q(l.t)}${where(x)}`);
    else out.push(`a modifié l’idée ${q(l.t)}${where(x)}`);
  });
  diffMap(B.prep, L.prep, (id, b, l) => {
    if (!b) out.push(`a ajouté ${q(l.text)} au pense-bête`);
    else if (!l) out.push(`a retiré ${q(b.text)} du pense-bête`);
    else if (!!b.done !== !!l.done) out.push(`${l.done ? "a coché" : "a décoché"} ${q(l.text)} dans le pense-bête`);
    else out.push(`a modifié ${q(l.text)} dans le pense-bête`);
  });
  return out;
}

/* ---------- Envoi des modifications locales ---------- */
function schedule(t, delay = 1200) {
  if (!t.sync) return;
  const id = t.sync.doc;
  clearTimeout(timers[id]);
  timers[id] = setTimeout(() => flush(t), delay);
}

function flush(t) {
  if (!ready || !t.sync || !T.trips.includes(t)) return;
  const id = t.sync.doc, B = bases[id], st = live[id];
  if (!B || !st || !st.docLoaded) return;
  const L = norm(t), ops = diffOps(B, L), lines = describe(B, L);
  const ref = db.collection("trips").doc(id);
  if (ops.length) {
    ref.update(...ops, new FP("updatedAt"), FV.serverTimestamp()).catch(err => syncError(err));
    bases[id] = L;
    persistBases();
  }
  lines.push(...syncPhotos(t));
  if (lines.length) logChange(id, lines);
}

function photoSig(src) { return src ? src.length + ":" + src.slice(-48) : ""; }

function syncPhotos(t) {
  const id = t.sync.doc, st = live[id], lines = [];
  if (!st || !st.photosReady) return lines;
  const col = db.collection("trips").doc(id).collection("photos");
  const local = new Map((t.photos || []).map(p => [String(p.id), p]));
  const added = {}, removed = {};
  for (const [pid, p] of local) if (!st.photoIds.has(pid)) {
    col.doc(pid).set({ id: p.id, c: p.c ?? null, src: p.src }).catch(err => syncError(err));
    st.photoIds.add(pid);
    added[p.c] = (added[p.c] || 0) + 1;
  }
  for (const pid of [...st.photoIds]) if (!local.has(pid)) {
    col.doc(pid).delete().catch(err => syncError(err));
    st.photoIds.delete(pid);
    const c = st.photoCity.get(pid);
    removed[c] = (removed[c] || 0) + 1;
  }
  for (const [pid, p] of local) st.photoCity.set(pid, p.c);
  const city = c => (t.cities.find(x => String(x.id) === String(c)) || {}).name;
  for (const [c, n] of Object.entries(added)) lines.push(`a ajouté ${n} photo${n > 1 ? "s" : ""}${city(c) ? ` à ${city(c)}` : ""}`);
  for (const [c, n] of Object.entries(removed)) lines.push(`a supprimé ${n} photo${n > 1 ? "s" : ""}${city(c) ? ` de ${city(c)}` : ""}`);
  const sig = photoSig(t.cover);
  if (sig !== st.coverSig) {
    if (t.cover) col.doc("cover").set({ src: t.cover }).catch(err => syncError(err));
    else col.doc("cover").delete().catch(err => syncError(err));
    st.coverSig = sig;
    lines.push(t.cover ? "a changé l’image du voyage" : "a retiré l’image du voyage");
  }
  return lines;
}

function logChange(id, lines) {
  const st = live[id];
  const col = db.collection("trips").doc(id).collection("changes");
  const now = Date.now(), key = lines.join("\n"), last = st && st.lastMine;
  // Écriture continue (carnet…) : on regroupe en une seule entrée
  if (last && last.key === key && now - last.t < 10 * 60e3) {
    col.doc(last.id).update({ at: FV.serverTimestamp(), t: now }).catch(() => {});
    last.t = now;
    return;
  }
  const ref = col.doc();
  ref.set({ by: me.uid, pid: T.profile ? T.profile.id : null, name: myName(), lines, at: FV.serverTimestamp(), t: now }).catch(err => syncError(err));
  if (st) st.lastMine = { id: ref.id, key, t: now };
}

let errorShown = 0;
function syncError(err) {
  console.warn("[sync]", err);
  if (Date.now() - errorShown < 20000) return;
  errorShown = Date.now();
  if (err && err.code === "permission-denied") toast("Synchronisation refusée : vérifie les règles Firebase.");
}

/* ---------- Réception en direct ---------- */
function listen(t) {
  if (!ready || !t.sync) return;
  const id = t.sync.doc;
  if (live[id]) return;
  const st = live[id] = { members: {}, changes: [], photoIds: new Set(), photoCity: new Map(), coverSig: photoSig(t.cover), photosReady: false, docLoaded: false, changesLoaded: false, unsub: [] };
  const ref = db.collection("trips").doc(id);
  st.unsub.push(ref.onSnapshot(snap => onTrip(id, snap), err => syncError(err)));
  st.unsub.push(ref.collection("photos").onSnapshot(snap => onPhotos(id, snap), err => syncError(err)));
  st.unsub.push(ref.collection("changes").orderBy("at", "desc").limit(200).onSnapshot(snap => onChanges(id, snap), err => syncError(err)));
}

function unlisten(id) {
  const st = live[id];
  if (!st) return;
  st.unsub.forEach(u => { try { u(); } catch (e) {} });
  delete live[id];
}

function onTrip(id, snap) {
  const t = tripByDoc(id), st = live[id];
  if (!t || !st || !snap.exists) return;
  const data = snap.data({ serverTimestamps: "estimate" });
  st.members = data.members || {};
  st.code = data.code || st.code;
  const R = pick(data), L = norm(t), B = bases[id];
  const M = B ? merge3(B, L, R) : R;
  bases[id] = R;
  persistBases();
  st.docLoaded = true;
  if ($("#modal .sync-share") && S === t) openShare();
  if (!same(M, L)) { applyTo(t, M); localSave(); requestRender(); }
  else requestRender(true);
  if (!same(M, R)) schedule(t, 300);
}

function onPhotos(id, snap) {
  const t = tripByDoc(id), st = live[id];
  if (!t || !st) return;
  t.photos = t.photos || [];
  let changed = false;
  for (const ch of snap.docChanges()) {
    const pid = ch.doc.id, d = ch.doc.data();
    if (pid === "cover") {
      if (ch.type === "removed") { if (t.cover) { delete t.cover; changed = true; } st.coverSig = ""; }
      else { if (t.cover !== d.src) { t.cover = d.src; changed = true; } st.coverSig = photoSig(d.src); }
      continue;
    }
    if (ch.type === "removed") {
      st.photoIds.delete(pid);
      const n = t.photos.length;
      t.photos = t.photos.filter(p => String(p.id) !== pid);
      if (t.photos.length !== n) changed = true;
    } else {
      st.photoIds.add(pid);
      st.photoCity.set(pid, d.c);
      const existing = t.photos.find(p => String(p.id) === pid);
      if (existing) { if (existing.src !== d.src || existing.c !== d.c) { existing.src = d.src; existing.c = d.c; changed = true; } }
      else { t.photos.push({ id: d.id ?? +pid, c: d.c, src: d.src }); changed = true; }
    }
  }
  if (changed) t.photos.sort((a, b) => (+a.id) - (+b.id));
  const first = !st.photosReady;
  st.photosReady = true;
  if (changed) { localSave(); requestRender(); }
  if (first) schedule(t, 300); // photos ajoutées hors ligne
}

function onChanges(id, snap) {
  const st = live[id], t = tripByDoc(id);
  if (!st || !t) return;
  st.changes = snap.docs.map(d => {
    const x = d.data({ serverTimestamps: "estimate" });
    const at = x.at && x.at.toMillis ? x.at.toMillis() : (x.t || Date.now());
    return { id: d.id, by: x.by, pid: x.pid, name: x.name, lines: x.lines || [], at };
  });
  if (st.changesLoaded && !snap.metadata.fromCache) {
    for (const ch of snap.docChanges()) {
      if (ch.type !== "added") continue;
      const x = ch.doc.data();
      if (x.by === me.uid || !x.lines || !x.lines.length) continue;
      toast(`${x.name || "Quelqu’un"} ${x.lines[0]}${x.lines.length > 1 ? ` (+${x.lines.length - 1})` : ""} · ${t.name}`);
      if (document.hidden) nativeNotify(id, t.name, x.name || "Quelqu’un", x.lines);
    }
  }
  st.changesLoaded = true;
  nativeInfoSoon();
  if (activity && activity.docId === id) drawActivity();
  requestRender(true);
}

function localSave() { quiet = true; try { save(); } finally { quiet = false; } }

function requestRender(light) {
  if (pendingRender) return;
  const editing = document.activeElement && document.activeElement.matches("#app input,#app textarea,#trips input,#app select");
  if (editing) {
    pendingRender = true;
    document.activeElement.addEventListener("blur", () => { pendingRender = false; setTimeout(render, 0); }, { once: true });
    return;
  }
  render();
}

/* ---------- Badges et avatars ---------- */
function unseen(id, uidMember) {
  const st = live[id];
  if (!st || !me || uidMember === me.uid) return 0;
  const since = Math.max((seen[id] && seen[id][uidMember]) || 0, (seen[id] && seen[id]._joined) || 0);
  return st.changes.filter(e => e.by === uidMember && e.at > since).reduce((n, e) => n + e.lines.length, 0);
}
function memberUidFor(t, person) {
  const st = live[t.sync.doc];
  if (!st || person.profileId == null) return null;
  if (T.profile && person.profileId === T.profile.id) return me && me.uid;
  return Object.keys(st.members).find(u => st.members[u].profileId === person.profileId) || null;
}

const baseAvatar = participantAvatar;
participantAvatar = function (person, size = "") {
  const t = T.trips.find(x => x.sync && x.participants && x.participants.includes(person));
  if (person && person.profileId === undefined) person = { ...person, profileId: null };
  if (!t || !ready) return baseAvatar(person, size);
  const id = t.sync.doc, st = live[id], u = memberUidFor(t, person);
  const mem = u && st && st.members[u];
  const isMe = T.profile && person.profileId === T.profile.id;
  const html = baseAvatar(!isMe && mem && mem.photo ? { ...person, photo: mem.photo } : person, size);
  if (!u) return html;
  const n = unseen(id, u);
  return `<span class="sync-avatar" data-sync-trip="${esc(id)}" data-sync-person="${esc(u)}">${html}${n ? `<i class="sync-badge" aria-label="${n} modification${n > 1 ? "s" : ""}">${n > 99 ? "99+" : n}</i>` : ""}</span>`;
};

/* ---------- Panneau d'activité ---------- */
function openActivity(docId, who) {
  const st = live[docId];
  if (!st) return;
  activity = { docId, who, since: {} };
  for (const u of Object.keys(st.members)) activity.since[u] = Math.max((seen[docId] && seen[docId][u]) || 0, (seen[docId] && seen[docId]._joined) || 0);
  drawActivity();
}
function markSeen(docId, who) {
  const st = live[docId];
  seen[docId] = seen[docId] || {};
  for (const u of who ? [who] : Object.keys(st.members)) {
    const max = Math.max(0, ...st.changes.filter(e => e.by === u).map(e => e.at));
    if (max > (seen[docId][u] || 0)) seen[docId][u] = max;
  }
  persistSeen();
}
function drawActivity() {
  const { docId, who } = activity, st = live[docId], t = tripByDoc(docId), m = $("#modal");
  if (!st || !t) { activity = null; return; }
  const name = u => u === me.uid ? "Moi" : ((st.members[u] && st.members[u].name) || "Voyageur");
  const avatarOf = u => {
    const mem = st.members[u] || {};
    return baseAvatar(u === me.uid ? (T.profile || { name: "?" }) : { name: mem.name, photo: mem.photo }, "");
  };
  const entries = st.changes.filter(e => !who || e.by === who);
  const chips = [["", "Tous"], ...Object.keys(st.members).sort((a, b) => (a === me.uid) - (b === me.uid)).map(u => [u, name(u)])]
    .map(([u, label]) => { const n = u ? unseen(docId, u) : 0; return `<button type="button" data-sync-act="activity-filter" data-who="${esc(u)}" class="${(who || "") === u ? "selected" : ""}">${u ? avatarOf(u) : ""}${esc(label)}${n ? ` <i class="sync-badge inline">${n}</i>` : ""}</button>`; }).join("");
  let lastDay = "", list = "";
  for (const e of entries) {
    const d = new Date(e.at), day = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    if (day !== lastDay) { list += `<h4 class="sync-day">${esc(day)}</h4>`; lastDay = day; }
    const fresh = e.by !== me.uid && e.at > (activity.since[e.by] || 0);
    list += `<article class="sync-entry ${fresh ? "fresh" : ""}"><div class="sync-entry-head">${avatarOf(e.by)}<b>${esc(e.by === me.uid ? "Moi" : (e.name || name(e.by)))}</b><time>${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</time>${fresh ? '<span class="sync-new">nouveau</span>' : ""}</div><ul>${e.lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul></article>`;
  }
  const title = who ? (who === me.uid ? "Mes modifications" : `Modifications de ${esc(name(who))}`) : "Modifications du voyage";
  m.innerHTML = `<section class="budget-bubble sync-bubble" role="dialog" aria-modal="true" aria-labelledby="sync-activity-title"><div class="budget-bubble-heading"><h2 id="sync-activity-title">${title}</h2><button type="button" data-act="cancel" aria-label="Fermer">✕</button></div><div class="sync-chips">${chips}</div><div class="sync-feed">${list || '<p class="empty">Aucune modification pour l’instant.</p>'}</div></section>`;
  m.classList.add("on");
  markSeen(docId, who);
  render();
}

/* ---------- Partager / rejoindre ---------- */
function shareText(code, t) {
  return `Rejoins mon voyage « ${t.name} » dans l’appli Mes voyages : touche « Rejoindre un voyage partagé » et entre le code ${code}`;
}
function sendText(text) {
  try { if (window.AndroidApp && AndroidApp.share) { AndroidApp.share(text); return; } } catch (e) {}
  if (navigator.share) { navigator.share({ text }).catch(() => {}); return; }
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast("Message copié"), () => {});
}

function openShare() {
  const m = $("#modal"), t = S;
  if (!enabled) {
    m.innerHTML = `<section class="budget-bubble sync-bubble" role="dialog" aria-modal="true"><div class="budget-bubble-heading"><h2>Partager le voyage</h2><button type="button" data-act="cancel" aria-label="Fermer">✕</button></div><p class="sync-text">Le partage n’est pas encore configuré dans cette version de l’appli.</p></section>`;
    m.classList.add("on");
    return;
  }
  if (!T.profile) { openAccount(true); return; }
  const st = t.sync && live[t.sync.doc];
  if (t.sync) {
    const members = st ? Object.entries(st.members) : [];
    m.innerHTML = `<section class="budget-bubble sync-bubble sync-share" role="dialog" aria-modal="true" aria-labelledby="sync-share-title"><div class="budget-bubble-heading"><h2 id="sync-share-title">Voyage partagé</h2><button type="button" data-act="cancel" aria-label="Fermer">✕</button></div><p class="sync-text">Pour inviter quelqu’un, envoie-lui ce code. Il ou elle touche « Rejoindre un voyage partagé » sur l’écran d’accueil de l’appli.</p><div class="sync-code">${esc((st && st.code) || "……")}</div><button type="button" class="new-trip-button sync-wide" data-sync-act="send-code" ${st && st.code ? "" : "disabled"}>Envoyer le code</button><h3 class="sync-sub">Dans ce voyage</h3><div class="sync-members">${members.map(([u, x]) => `<div>${baseAvatar(u === me.uid ? (T.profile || {}) : { name: x.name, photo: x.photo })}<span>${esc(u === me.uid ? `${x.name} (moi)` : x.name)}</span></div>`).join("") || '<p class="empty">Chargement…</p>'}</div><button type="button" class="ghost sync-wide" data-sync-act="activity-all">Voir toutes les modifications</button></section>`;
  } else {
    m.innerHTML = `<section class="budget-bubble sync-bubble" role="dialog" aria-modal="true" aria-labelledby="sync-share-title"><div class="budget-bubble-heading"><h2 id="sync-share-title">Partager le voyage</h2><button type="button" data-act="cancel" aria-label="Fermer">✕</button></div><p class="sync-text">Partage <b>${esc(t.name)}</b> pour le modifier à plusieurs. Chaque modification apparaît en direct chez l’autre, avec une pastille rouge sur la tête de la personne qui l’a faite.</p><button type="button" class="new-trip-button sync-wide" data-sync-act="share-start">Partager ce voyage</button><p class="sync-hint">Une connexion Internet est nécessaire pour démarrer le partage.</p></section>`;
  }
  m.classList.add("on");
}

function makeCode() { let c = ""; const a = new Uint32Array(6); crypto.getRandomValues(a); for (const n of a) c += ALPHABET[n % ALPHABET.length]; return c; }

function thumb(src, size = 160) {
  return new Promise(resolve => {
    if (!src) return resolve("");
    const im = new Image();
    im.onload = () => { const k = Math.min(1, size / Math.max(im.width, im.height)), c = document.createElement("canvas"); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); resolve(c.toDataURL("image/jpeg", .7)); };
    im.onerror = () => resolve("");
    im.src = src;
  });
}
async function memberInfo() { return { name: myName(), profileId: T.profile ? T.profile.id : null, photo: await thumb(T.profile && T.profile.photo) }; }

const withTimeout = (p, ms = 15000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "timeout" })), ms))]);

async function startShare(t) {
  if (!ready) { toast("Connexion au service de partage… réessaie dans un instant."); return; }
  if (!navigator.onLine) { toast("Connecte-toi à Internet pour partager le voyage."); return; }
  const btn = $('[data-sync-act="share-start"]');
  if (btn) { btn.disabled = true; btn.textContent = "Partage en cours…"; }
  try {
    t.participants = tripParticipants(t).map((p, i) => ({ ...p, id: p.id || uid() + i }));
    if (T.profile && !t.participants.some(p => p.profileId === T.profile.id)) {
      const free = t.participants.find(p => p.profileId == null);
      if (free) free.profileId = T.profile.id; else t.participants.unshift({ id: uid(), name: T.profile.name, profileId: T.profile.id });
    }
    t.pers = t.participants.length;
    const ref = db.collection("trips").doc(), L = norm(t);
    await withTimeout(ref.set({ ...L, memberIds: [me.uid], members: { [me.uid]: await memberInfo() }, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() }));
    let code = null;
    for (let i = 0; i < 6 && !code; i++) {
      const c = makeCode();
      try { await withTimeout(db.collection("invites").doc(c).set({ trip: ref.id, by: me.uid })); code = c; } catch (e) { if (e.code !== "permission-denied") throw e; }
    }
    if (!code) throw new Error("code");
    await withTimeout(ref.update({ code }));
    t.sync = { doc: ref.id };
    bases[ref.id] = L;
    persistBases();
    seen[ref.id] = { _joined: Date.now() };
    persistSeen();
    listen(t);
    live[ref.id].code = code;
    live[ref.id].photosReady = true;
    live[ref.id].coverSig = "";
    live[ref.id].docLoaded = true;
    save();
    const lines = syncPhotos(t);
    logChange(ref.id, ["a partagé le voyage", ...lines.filter(l => !l.startsWith("a ajouté") && !l.startsWith("a changé l’image"))]);
    render();
    openShare();
  } catch (e) {
    console.warn(e);
    toast(e.code === "permission-denied" ? "Partage refusé : vérifie les règles Firebase." : "Le partage n’a pas abouti. Vérifie ta connexion et réessaie.");
    if (btn) { btn.disabled = false; btn.textContent = "Partager ce voyage"; }
  }
}

function openJoin() {
  if (!enabled) { toast("Le partage n’est pas encore configuré."); return; }
  if (!T.profile) { openAccount(true); return; }
  const m = $("#modal");
  m.innerHTML = `<form class="idea-bubble sync-join" role="dialog" aria-modal="true" aria-labelledby="sync-join-title"><h2 id="sync-join-title">Rejoindre un voyage</h2><p class="sync-text">Entre le code reçu de la personne qui a partagé le voyage.</p><label>Code<input name="code" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Ex. K7PX2M" required class="sync-code-input"></label><div class="btns"><button type="button" data-act="cancel">Annuler</button><button class="ok" type="submit">Rejoindre</button></div></form>`;
  m.classList.add("on");
  const f = m.querySelector("form"), input = f.elements.code;
  input.oninput = () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); };
  input.focus({ preventScroll: true });
  f.onsubmit = async e => {
    e.preventDefault();
    const code = input.value.trim(), ok = f.querySelector(".ok");
    if (code.length !== 6) { toast("Le code fait 6 caractères."); return; }
    if (!ready || !navigator.onLine) { toast("Connecte-toi à Internet pour rejoindre le voyage."); return; }
    ok.disabled = true; ok.textContent = "Connexion…";
    try { await join(code); }
    catch (err) { console.warn(err); toast(err.message === "code" ? "Code introuvable : vérifie-le." : "Impossible de rejoindre le voyage. Réessaie."); ok.disabled = false; ok.textContent = "Rejoindre"; }
  };
}

async function join(code) {
  const inv = await withTimeout(db.collection("invites").doc(code).get({ source: "server" }));
  if (!inv.exists) throw new Error("code");
  const docId = inv.data().trip, existing = tripByDoc(docId);
  if (existing) { T.cur = existing.id; S = cur(); home = false; close(); render(); return; }
  const ref = db.collection("trips").doc(docId);
  await withTimeout(ref.update(new FP("memberIds"), FV.arrayUnion(me.uid), new FP("members", me.uid), await memberInfo()));
  const snap = await withTimeout(ref.get({ source: "server" }));
  const data = snap.data();
  pickIdentity(docId, pick(data), data.members || {});
}

function pickIdentity(docId, R, members) {
  const people = (R.s.participants || []), m = $("#modal");
  const taken = new Set(Object.entries(members).filter(([u]) => u !== me.uid).map(([, x]) => x.profileId));
  m.innerHTML = `<form class="idea-bubble sync-join" role="dialog" aria-modal="true" aria-labelledby="sync-who-title" onsubmit="return false"><h2 id="sync-who-title">Qui es-tu dans « ${esc(R.s.name || "ce voyage")} » ?</h2><div class="sync-who">${people.map((p, i) => `<button type="button" data-sync-act="who" data-index="${i}" ${p.profileId != null && p.profileId !== (T.profile && T.profile.id) && taken.has(p.profileId) ? "disabled" : ""}>${baseAvatar({ name: p.name })}<span>${esc(p.name)}</span></button>`).join("")}<button type="button" data-sync-act="who" data-index="-1"><span class="profile-avatar">+</span><span>Je ne suis pas dans la liste</span></button></div></form>`;
  m.classList.add("on");
  joinDraft = { docId, R };
}
let joinDraft = null;

function finishJoin(index) {
  const { docId, R } = joinDraft;
  joinDraft = null;
  const t = { id: uid(), name: R.s.name || "Voyage partagé", start: R.s.start, end: R.s.end, pers: R.s.pers || 1, tab: "g", arm: 0, cities: [], items: [], ideas: [], photos: [], preparation: [], currencies: ["EUR"], rates: { EUR: 1 }, sync: { doc: docId } };
  applyTo(t, R);
  t.participants = t.participants || [];
  t.participants.forEach(p => { if (T.profile && p.profileId === T.profile.id) p.profileId = undefined; });
  if (index >= 0 && t.participants[index]) t.participants[index].profileId = T.profile.id;
  else t.participants.push({ id: uid(), name: T.profile.name, profileId: T.profile.id });
  t.pers = t.participants.length;
  bases[docId] = R;
  persistBases();
  seen[docId] = { _joined: Date.now() };
  persistSeen();
  T.trips.push(t);
  T.cur = t.id; S = cur(); home = false;
  save();
  listen(t);
  close();
  render();
  toast(`Bienvenue dans « ${t.name} » !`);
}

function leave(id) {
  clearTimeout(timers[id]);
  const st = live[id];
  if (st && me) {
    const ref = db.collection("trips").doc(id);
    ref.collection("changes").doc().set({ by: me.uid, pid: T.profile ? T.profile.id : null, name: myName(), lines: ["a quitté le voyage"], at: FV.serverTimestamp(), t: Date.now() }).catch(() => {});
    ref.update(new FP("memberIds"), FV.arrayRemove(me.uid), new FP("members", me.uid), FV.delete()).catch(() => {});
  }
  unlisten(id);
  delete bases[id]; persistBases();
  delete seen[id]; persistSeen();
}

/* ---------- Branchements sur l'appli ---------- */
window.syncStrip = data => ({ ...data, trips: data.trips.map(t => t.sync ? { ...t, photos: [], cover: undefined } : t) });

/* ---------- Notifications Android ---------- */
const bridge = () => window.AndroidApp && typeof AndroidApp.setSyncInfo === "function" ? AndroidApp : null;
function nativeNotify(id, tripName, who, lines) {
  const b = bridge();
  if (!b) return;
  try { b.notify(id, tripName, who, JSON.stringify(lines)); } catch (e) {}
}
function nativeInfo() {
  const b = bridge();
  if (!b || !me) return;
  const trips = T.trips.filter(t => t.sync).map(t => {
    const st = live[t.sync.doc];
    const last = st && st.changesLoaded ? Math.max(Date.now() - 60e3, ...st.changes.map(e => e.at)) : null;
    return { doc: t.sync.doc, name: t.name, since: last };
  });
  try { b.setSyncInfo(JSON.stringify({ apiKey: CFG.apiKey, projectId: CFG.projectId, uid: me.uid, refreshToken: me.refreshToken || "", trips })); } catch (e) {}
}
let nativeTimer = 0;
function nativeInfoSoon() { clearTimeout(nativeTimer); nativeTimer = setTimeout(nativeInfo, 800); }
document.addEventListener("visibilitychange", () => { if (document.hidden) nativeInfo(); });

function openTripFromNotification(docId, tries = 0) {
  const t = tripByDoc(docId);
  if (!t) return;
  if ($("#launch-screen")) $("#launch-screen").remove();
  T.cur = t.id; S = cur(); home = false; close(); render();
  if (live[docId] && live[docId].changesLoaded) openActivity(docId, "");
  else if (tries < 20) setTimeout(() => openTripFromNotification(docId, tries + 1), 500);
}

window.syncOnSave = () => {
  if (quiet || !ready) return;
  nativeInfoSoon();
  const known = new Set(T.trips.filter(t => t.sync).map(t => t.sync.doc));
  for (const id of Object.keys(live)) if (!known.has(id)) leave(id);
  for (const t of T.trips) if (t.sync) { listen(t); schedule(t); }
  const sig = T.profile ? stable([T.profile.name, photoSig(T.profile.photo)]) : null;
  if (sig !== lastProfileSig) {
    const first = lastProfileSig === null;
    lastProfileSig = sig;
    if (!first && sig) memberInfo().then(info => { for (const id of Object.keys(live)) db.collection("trips").doc(id).update(new FP("members", me.uid), info).catch(() => {}); });
  }
};

// Le voyageur 0 n'est « moi » que pour un voyage qui n'est pas encore partagé
readParticipants = function (form, trip = null) {
  return [...form.querySelectorAll("[data-person]")].map((input, i) => {
    const old = (trip && trip.participants && trip.participants[i]) || {};
    const profileId = old.profileId !== undefined ? old.profileId : (i === 0 && !(trip && trip.sync) ? (T.profile && T.profile.id) : undefined);
    return { ...old, id: old.id || uid() + i, name: input.value.trim(), profileId };
  });
};

const baseConfirmDelete = confirmDelete;
confirmDelete = function (kind, id) {
  baseConfirmDelete(kind, id);
  const t = kind === "trip" && T.trips.find(x => x.id === id);
  if (t && t.sync) { const p = $("#modal .delete-bubble p"); if (p) p.innerHTML = `<strong>${esc(t.name)}</strong> sera retiré de ce téléphone. Il restera disponible pour les autres voyageurs.`; }
};

const shareIcon = shared => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.4 2.8-5.3 5.5-5.3s4.9 1.9 5.5 5.3" stroke-linecap="round"/>${shared ? '<circle cx="17" cy="9" r="2.6"/><path d="M15.8 13.9c2.4.1 4.1 1.8 4.7 4.6" stroke-linecap="round"/>' : '<path d="M18 7v6M15 10h6" stroke-linecap="round"/>'}</svg>`;

const baseRender = render;
render = function () {
  baseRender();
  if (home) {
    const add = $(".home-add-trip") || $(".new-trip-button[data-act='addtrip']");
    if (add && !$(".home-join-trip")) add.insertAdjacentHTML("afterend", `<button class="home-join-trip" data-sync-act="join">Rejoindre un voyage partagé</button>`);
    document.querySelectorAll(".travel-home-open").forEach(b => {
      const t = T.trips.find(x => String(x.id) === b.dataset.id);
      if (t && t.sync && !b.querySelector(".home-shared-tag")) b.querySelector(".travel-home-title")?.insertAdjacentHTML("afterend", `<span class="home-shared-tag">Partagé</span>`);
    });
  } else if (S) {
    const heads = $("#trips .travelers");
    if (heads && !$(".trip-share-button")) heads.insertAdjacentHTML("beforeend", `<button class="trip-share-button ${S.sync ? "shared" : ""}" data-sync-act="share" aria-label="${S.sync ? "Voyage partagé" : "Partager le voyage"}">${shareIcon(!!S.sync)}</button>`);
  }
};

document.addEventListener("click", e => {
  const person = e.target.closest("#trips [data-sync-person]");
  if (person) { e.preventDefault(); e.stopPropagation(); openActivity(person.dataset.syncTrip, person.dataset.syncPerson); return; }
  const b = e.target.closest("[data-sync-act]");
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const a = b.dataset.syncAct;
  if (a === "share") openShare();
  else if (a === "share-start") startShare(S);
  else if (a === "send-code") { const st = S.sync && live[S.sync.doc]; if (st && st.code) sendText(shareText(st.code, S)); }
  else if (a === "activity-all") openActivity(S.sync.doc, "");
  else if (a === "activity-filter" && activity) { activity.who = b.dataset.who; drawActivity(); }
  else if (a === "join") openJoin();
  else if (a === "who" && joinDraft) finishJoin(+b.dataset.index);
}, true);

document.addEventListener("click", e => {
  if (activity && (e.target.id === "modal" || e.target.closest('#modal [data-act="cancel"]'))) activity = null;
}, true);
new MutationObserver(() => { if (activity && !$("#modal .sync-bubble")) activity = null; }).observe($("#modal"), { childList: true });

/* ---------- Démarrage ---------- */
if (!enabled) { render(); return; }
try {
  firebase.initializeApp(CFG);
  db = firebase.firestore();
  try { db.settings({ ignoreUndefinedProperties: true }); } catch (e) {}
  db.enablePersistence({ synchronizeTabs: false }).catch(() => {});
  FV = firebase.firestore.FieldValue;
  FP = firebase.firestore.FieldPath;
  auth = firebase.auth();
} catch (e) { console.warn("[sync] init", e); render(); return; }

auth.onAuthStateChanged(u => {
  if (!u) { auth.signInAnonymously().catch(err => console.warn("[sync] auth", err)); return; }
  me = u; ready = true;
  nativeInfoSoon();
  lastProfileSig = T.profile ? stable([T.profile.name, photoSig(T.profile.photo)]) : null;
  T.trips.filter(t => t.sync).forEach(listen);
  render();
});
window.addEventListener("online", () => { if (!auth.currentUser) auth.signInAnonymously().catch(() => {}); });
window.Sync = { live, bases, flushAll: () => T.trips.forEach(t => t.sync && flush(t)), openTrip: openTripFromNotification };
render();
})();
