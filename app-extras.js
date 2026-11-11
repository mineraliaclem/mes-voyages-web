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

/* Les sections ouvertes (Frais de départ, Pense-bête, catégories…) restent ouvertes quand l'écran est redessiné,
   par exemple à l'arrivée d'une modification de l'autre voyageur */
const foldKey = d => (d.closest("[data-widget]")?.dataset.widget || "") + "|" + (d.querySelector(":scope > summary")?.textContent || "").replace(/[\d\s€$£.,·:❤️-]+/gu, "").slice(0, 40);
const baseRender = render;
render = function () {
  const open = new Set([...document.querySelectorAll("#app details[open]")].map(foldKey));
  const where = home ? "home" : S ? `${S.id}|${S.tab}` : "";
  const keep = where === render.lastWhere;
  render.lastWhere = where;
  baseRender();
  if (keep && open.size) document.querySelectorAll("#app details:not([open])").forEach(d => { if (open.has(foldKey(d))) d.open = true; });
  if (home) {
    const add = $(".home-add-trip") || $('#app [data-act="addtrip"]');
    if (add && !$(".home-join-trip")) add.insertAdjacentHTML("afterend", `<button class="home-join-trip" data-extra="join">Rejoindre un voyage partagé</button><label class="home-import-trips">Importer des voyages (fichier de sauvegarde)<input type="file" accept=".json,application/json,text/plain" data-extra="import" hidden></label>`);
  }
};
document.addEventListener("click", e => {
  const b = e.target.closest('[data-extra="join"]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  openJoinCode();
}, true);

/* Me retrouver parmi les voyageurs d'un voyage (par mon prénom) quand aucun voyageur n'est relié à mon profil */
const norm = x => (x || "").trim().toLocaleLowerCase("fr").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
function linkMe() {
  if (!T.profile || !T.profile.name) return false;
  let changed = false;
  for (const t of T.trips) {
    const people = t.participants || [];
    if (!people.length || people.some(p => p.profileId === T.profile.id)) continue;
    const me = people.find(p => norm(p.name) === norm(T.profile.name)) || people.find(p => norm(p.name).split(/\s+/)[0] === norm(T.profile.name).split(/\s+/)[0]);
    if (me) { me.profileId = T.profile.id; delete me.photo; changed = true; }
  }
  return changed;
}
setTimeout(() => { if (linkMe()) { save(); render(); } }, 3500);

/* Importer des voyages depuis une sauvegarde (par exemple exportée du site ChatGPT) */
document.addEventListener("change", async e => {
  const input = e.target.closest('[data-extra="import"]');
  if (!input || !input.files[0]) return;
  try {
    const raw = JSON.parse(await input.files[0].text());
    const data = Array.isArray(raw) ? { trips: raw } : raw;
    const trips = Array.isArray(data.trips) ? data.trips : [];
    if (!trips.length) throw new Error("vide");
    if (!T.profile && data.profile) T.profile = { ...data.profile };
    const oldProfileId = data.profile && data.profile.id;
    const ids = new Set(T.trips.map(t => String(t.id))), names = new Set(T.trips.map(t => t.name));
    let added = 0;
    for (const source of trips) {
      const t = JSON.parse(JSON.stringify(source));
      delete t.shared; delete t.syncConflict; delete t.sync;
      if (ids.has(String(t.id))) t.id = uid();
      if (names.has(t.name)) t.name += " (importé)";
      // Le voyageur qui était « moi » dans la sauvegarde redevient « moi » ici,
      // y compris dans un voyage rejoint (le lien était gardé par l'ancien serveur de partage)
      const members = (source.shared && source.shared.members) || [];
      for (const p of t.participants || []) {
        const member = members.find(m => String(m.slot) === String(p.id));
        if (member) { p.profileId = member.user; if (member.photo && !p.photo) p.photo = member.photo; if (member.name) p.name = member.name; }
        if (oldProfileId && p.profileId === oldProfileId && T.profile) { p.profileId = T.profile.id; delete p.photo; }
      }
      for (const k of ["cities", "items", "ideas", "photos", "preparation"]) if (!Array.isArray(t[k])) t[k] = [];
      t.currencies = t.currencies || ["EUR"]; t.rates = t.rates || { EUR: 1 }; t.tab = "g"; t.arm = 0;
      T.trips.push(t); ids.add(String(t.id)); added++;
    }
    linkMe();
    const ok = save();
    render();
    toast(ok ? `${added} voyage${added > 1 ? "s" : ""} importé${added > 1 ? "s" : ""} 🎉` : "Import fait, mais la mémoire du téléphone est pleine : retire quelques photos.");
  } catch (err) {
    toast("Ce fichier n’est pas une sauvegarde de Mes voyages.");
  }
  input.value = "";
});

/* iPhone : lien d'invitation ouvert dans Safari ou dans WhatsApp, et non dans l'appli de l'écran d'accueil.
   Ces navigateurs ont une mémoire séparée de l'appli : on explique comment rejoindre depuis l'appli. */
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const installed = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
window.joinOutsideApp = token => {
  if (!isIOS || installed || window.AndroidApp) return false;
  history.replaceState({}, "", location.pathname);
  const m = $("#modal");
  m.innerHTML = `<section class="range-bubble ios-join" role="dialog" aria-modal="true"><h2>Rejoindre depuis l’appli</h2><p>Sur iPhone, l’appli de l’écran d’accueil ne partage pas sa mémoire avec ce navigateur. Pour rejoindre le voyage :</p><ol><li>Si l’icône « Mes voyages » n’est pas encore sur ton écran d’accueil : ouvre <b>mineraliaclem.github.io/mes-voyages-web</b> dans <b>Safari</b>, touche <b>Partager</b> puis <b>Sur l’écran d’accueil</b>.</li><li>Ouvre l’appli depuis son icône et crée ton profil.</li><li>Touche <b>Rejoindre un voyage partagé</b> et entre ce code :</li></ol><div class="invite-code">${esc(token)}</div><button class="ghost" data-act="cancel">Fermer</button><button type="button" class="ghost ios-join-here" data-extra="join-here" data-token="${esc(token)}">Continuer dans ce navigateur</button></section>`;
  m.classList.add("on");
  return true;
};
document.addEventListener("click", e => {
  const b = e.target.closest('[data-extra="join-here"]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  showJoin(b.dataset.token).catch(err => toast(err.message));
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
