/* Mes voyages — compléments pour l'appli Android et la version web :
   rejoindre un voyage avec un code, notifications Android, ouverture depuis une notification. */
(() => {
"use strict";
const bridge = () => window.AndroidApp && typeof AndroidApp.setSyncInfo === "function" ? AndroidApp : null;

/* Rejoindre un voyage partagé avec le code reçu */
function openJoinCode() {
  if (!T.profile) { openAccount(true); return; }
  const m = $("#modal");
  m.innerHTML = `<form class="range-bubble" role="dialog" aria-modal="true" aria-labelledby="join-title"><h2 id="join-title">Rejoindre un voyage</h2><p>Entre le code reçu de la personne qui a partagé le voyage.</p><input name="code" class="join-code-input" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="K7PX2M" required><div class="btns"><button type="button" data-act="cancel">Annuler</button><button class="ok" type="submit">Rejoindre</button></div></form>`;
  m.classList.add("on");
  const f = m.querySelector("form"), input = f.elements.code;
  input.oninput = () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); };
  setTimeout(() => input.focus(), 50);
  f.onsubmit = async e => {
    e.preventDefault();
    if (input.value.length !== 6) { toast("Le code fait 6 caractères."); return; }
    const ok = f.querySelector(".ok");
    ok.disabled = true; ok.textContent = "Connexion…";
    try { await showJoin(input.value); }
    catch (err) { toast(err.message || "Impossible de rejoindre le voyage."); ok.disabled = false; ok.textContent = "Rejoindre"; }
  };
}

const baseRender = render;
render = function () {
  baseRender();
  if (home) {
    const add = $(".home-add-trip") || $('#app [data-act="addtrip"]');
    if (add && !$(".home-join-trip")) add.insertAdjacentHTML("afterend", `<button class="home-join-trip" data-extra="join">Rejoindre un voyage partagé</button>`);
  }
};
document.addEventListener("click", e => {
  const b = e.target.closest('[data-extra="join"]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  openJoinCode();
}, true);

/* Notifications Android */
const fb = window.CollabFirebase;
function nativeInfo() {
  const b = bridge(), me = fb && fb.me();
  if (!b || !me) return;
  const trips = T.trips.filter(t => t.shared && fb.cache[t.shared.id]).map(t => {
    const c = fb.cache[t.shared.id];
    const last = c.historyLoaded ? Math.max(Date.now() - 60e3, ...c.history.map(h => h.at)) : null;
    return { doc: t.shared.id, name: t.name, since: last };
  });
  try { b.setSyncInfo(JSON.stringify({ apiKey: FIREBASE_CONFIG.apiKey, projectId: FIREBASE_CONFIG.projectId, uid: me.uid, refreshToken: me.refreshToken || "", trips })); } catch (e) {}
}
let infoTimer = 0;
const nativeInfoSoon = () => { clearTimeout(infoTimer); infoTimer = setTimeout(nativeInfo, 800); };
if (fb) fb.on(ev => {
  if (ev.type === "history") {
    const t = T.trips.find(x => x.shared && x.shared.id === ev.tripId), h = ev.entry;
    if (document.hidden && bridge() && t) { try { AndroidApp.notify(ev.tripId, t.name, h.name || "Quelqu’un", JSON.stringify((h.entries || []).map(e => `${e.title}${e.detail ? ` (${e.detail})` : ""}`))); } catch (e) {} }
  }
  nativeInfoSoon();
});
document.addEventListener("visibilitychange", () => { if (document.hidden) nativeInfo(); });

/* Ouverture depuis une notification : le voyage, puis l'historique de la dernière personne */
function openTrip(docId, tries = 0) {
  const t = T.trips.find(x => x.shared && x.shared.id === docId);
  const c = fb && fb.cache[docId];
  if (!t || !c || !c.historyLoaded) { if (tries < 30) setTimeout(() => openTrip(docId, tries + 1), 500); return; }
  $("#launch-screen")?.remove();
  T.cur = t.id; S = t; home = false;
  close(); render();
  const last = c.history.find(h => h.actor !== fb.me().uid);
  if (last) showPersonHistory(last.actor).catch(() => {});
}
window.Sync = { openTrip };
})();
