import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { HUMAN_RGB, COLOR_NAMES } from './theme.js';
import { PORTRAITS, portraitById, findPortrait, defaultPortrait } from './portraits.js';
import { makeIdentity } from './context.js';
import { loadDevice } from './device.js';
import { currentAccount, signInHelp, currentProvider, PROVIDER_IDS, shownProviders } from './auth.js';

// Your selecle profile lives on your machine at ~/.selecle/profile.json.
// It holds no secrets: a display name, which agent provider you use, and a
// hash of your account email (so the same account is recognised, but the
// address itself is never written down or shown to friends).

// Choices offered in the settings window.
export const TITLES = ['Gravedigger', 'Necromancer', 'Warlock', 'Banshee', 'Reaper', 'Scribe', 'Alchemist', 'Wraith'];
export const STATUSES = ['haunting', 'brooding', 'away', 'busy'];
export const CARD_STYLES = ['home', 'ember', 'toxic', 'bone', 'blood'];
export const CRYPT_STYLES = ['brief', 'balanced', 'detailed'];
// The quick-start steps (see guide.js) and what is saved about your progress.
export const GUIDE_IDS = ['talk', 'slash', 'mention', 'summon', 'spec', 'feed', 'replay', 'me', 'friends', 'devices'];
export const cleanGuide = (g) => ({
  done: Array.isArray(g?.done) ? [...new Set(g.done.filter((id) => GUIDE_IDS.includes(id)))] : [],
  seen: g?.seen === true,
  off: g?.off === true,
});

export const DEFAULT_PREFS = { animate: true, style: 'balanced', bell: false };

export const cleanPrefs = (p) => ({
  animate: typeof p?.animate === 'boolean' ? p.animate : DEFAULT_PREFS.animate,
  style: CRYPT_STYLES.includes(p?.style) ? p.style : DEFAULT_PREFS.style,
  bell: typeof p?.bell === 'boolean' ? p.bell : DEFAULT_PREFS.bell,
});

// Letters in any language, with their accents and vowel signs (marks), numbers, and . _ - space.
export const NAME_OK = /^[\p{L}\p{M}\p{N} ._-]{1,20}$/u;

export const profilePath = () => path.join(process.env.SELECLE_HOME || path.join(os.homedir(), '.selecle'), 'profile.json');

export const hashEmail = (email) => (email ? crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16) : null);

export function loadProfile(file = profilePath()) {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    return p && typeof p.name === 'string' ? p : null;
  } catch {
    return null;
  }
}

function saveProfile(profile, file = profilePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(profile, null, 2));
  return profile;
}

// A person who has never been through the first-run page has no profile file yet.
export const needsOnboarding = (file = profilePath()) => !loadProfile(file);

// A first name: the OS username. Never part of the account email, which friends must not see.
export function suggestName() {
  const user = os.userInfo().username.replace(/[^\p{L}\p{M}\p{N} ._-]/gu, '').slice(0, 20);
  return user || 'wanderer';
}

// Load the profile or make one. A different account than last time is a new
// person on the same machine, so it gets a fresh profile. `name` (from
// --name) renames and is remembered.
export function ensureProfile(account, { name, file = profilePath() } = {}) {
  const emailHash = hashEmail(account.email);
  let profile = loadProfile(file);
  if (profile && emailHash && profile.emailHash && profile.emailHash !== emailHash) profile = null;
  if (name && !NAME_OK.test(name)) throw new Error('A name is letters, numbers, spaces, dots and dashes, up to 20.');
  const chosen = name || profile?.name || suggestName(account);
  const next = {
    uid: profile?.uid ?? crypto.randomUUID().slice(0, 12),
    name: chosen,
    avatar: portraitById(profile?.avatar).id === profile?.avatar ? profile.avatar : defaultPortrait(chosen).id,
    color: profile?.color ?? [...chosen].reduce((h, ch) => (h * 31 + ch.codePointAt(0)) >>> 0, 0) % HUMAN_RGB.length,
    about: profile?.about ?? '',
    title: TITLES.includes(profile?.title) ? profile.title : '',
    status: STATUSES.includes(profile?.status) ? profile.status : 'haunting',
    card: CARD_STYLES.includes(profile?.card) ? profile.card : 'home',
    prefs: cleanPrefs(profile?.prefs),
    guide: cleanGuide(profile?.guide),
    provider: account.provider === 'mock' ? (PROVIDER_IDS.includes(profile?.provider) ? profile.provider : currentProvider()) : account.provider,
    onboarded: true,
    ...(profile?.tools ? { tools: profile.tools } : {}),
    emailHash: emailHash ?? profile?.emailHash ?? null,
    createdAt: profile?.createdAt ?? new Date().toISOString(),
  };
  if (account.guest) return { ...next, name: name || profile?.name || suggestName(account), plan: null, guest: true };
  if (!profile || JSON.stringify(profile) !== JSON.stringify(next)) saveProfile(next, file);
  return { ...next, plan: account.plan ?? null, guest: Boolean(account.guest) };
}

// Everything a command needs at startup: who you are, or why you cannot enter.
export function signIn({ name = process.env.SELECLE_NAME, runner, file } = {}) {
  const account = currentAccount(currentProvider(), runner);
  if (!account.signedIn) return { ok: false, message: signInHelp(account) };
  try {
    return { ok: true, account, profile: ensureProfile(account, { name, file }) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

export const ABOUT_MAX = 60;

// Change what friends see of you. Returns the new profile or throws a readable error.
// `taken` are the names of other people currently in the project.
export function editProfile(current, patch, { taken = [] } = {}) {
  const next = { ...current };
  if (patch.name !== undefined) {
    if (!NAME_OK.test(patch.name) || /^the crypt$/i.test(patch.name)) throw new Error('A name is letters, numbers, spaces, dots and dashes, up to 20.');
    if (taken.some((n) => n.toLowerCase() === patch.name.toLowerCase())) throw new Error(`Someone called ${patch.name} already haunts this crypt.`);
    next.name = patch.name;
  }
  if (patch.avatar !== undefined) {
    const found = findPortrait(patch.avatar);
    if (!found) throw new Error(`Pick an avatar by number (1-${PORTRAITS.length}) or name: ${PORTRAITS.map((x) => x.id).join(', ')}`);
    next.avatar = found.id;
  }
  if (patch.color !== undefined) {
    const i = /^\d+$/.test(patch.color) ? Number(patch.color) - 1 : COLOR_NAMES.indexOf(patch.color.toLowerCase());
    if (!(i >= 0 && i < HUMAN_RGB.length)) throw new Error(`Pick a colour: ${COLOR_NAMES.map((x, j) => `${j + 1} ${x}`).join('  ')}`);
    next.color = i;
  }
  if (patch.about !== undefined) {
    if (patch.about.length > ABOUT_MAX) throw new Error(`Keep it under ${ABOUT_MAX} characters.`);
    next.about = patch.about.replace(/\s+/g, ' ').trim();
  }
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    const found = TITLES.find((x) => x.toLowerCase() === t.toLowerCase());
    if (t && !/^(none|no|-)$/i.test(t) && !found) throw new Error(`Pick a title: ${TITLES.join(', ')} (or none)`);
    next.title = found ?? '';
  }
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status.trim().toLowerCase())) throw new Error(`Pick a status: ${STATUSES.join(', ')}`);
    next.status = patch.status.trim().toLowerCase();
  }
  if (patch.provider !== undefined) {
    if (!PROVIDER_IDS.includes(patch.provider)) throw new Error(`Pick an agent: ${shownProviders().join(', ')}`);
    next.provider = patch.provider;
  }
  if (patch.card !== undefined) {
    if (!CARD_STYLES.includes(patch.card.trim().toLowerCase())) throw new Error(`Pick a card style: ${CARD_STYLES.join(', ')}`);
    next.card = patch.card.trim().toLowerCase();
  }
  return next;
}

// Preferences: { animate, style, bell }. Returns the new set or throws.
export function editPrefs(current, patch) {
  const next = { ...cleanPrefs(current) };
  if (patch.animate !== undefined) next.animate = Boolean(patch.animate);
  if (patch.bell !== undefined) next.bell = Boolean(patch.bell);
  if (patch.style !== undefined) {
    if (!CRYPT_STYLES.includes(patch.style)) throw new Error(`Pick a style: ${CRYPT_STYLES.join(', ')}`);
    next.style = patch.style;
  }
  return next;
}

// Save a profile to disk (local and host sessions only; guests keep theirs for the visit).
export const saveProfileFile = (profile, file = profilePath()) => {
  const { plan, guest, glyph, prompts, ...stored } = profile;
  if (!guest) saveProfile(stored, file);
};

// The in-app identity of a profile.
export const identityOf = (profile, extra = {}) => {
  const portrait = portraitById(profile.avatar ?? defaultPortrait(profile.name).id);
  return makeIdentity(profile.name, {
    uid: profile.uid,
    // This computer's id (src/device.js): the soul id is the person, the device is the machine.
    device: loadDevice().id,
    avatar: portrait.id,
    glyph: portrait.glyph,
    rgb: HUMAN_RGB[profile.color] ?? HUMAN_RGB[0],
    about: profile.about ?? '',
    title: TITLES.includes(profile.title) ? profile.title : '',
    status: STATUSES.includes(profile.status) ? profile.status : 'haunting',
    card: CARD_STYLES.includes(profile.card) ? profile.card : 'home',
    prefs: cleanPrefs(profile.prefs),
    guide: cleanGuide(profile.guide),
    provider: profile.provider,
    plan: profile.plan,
    since: profile.createdAt,
    ...extra,
  });
};

// Your soul id is who you are in the shared history. On a new device, adopt the
// one from the old device so your earlier talk and spirits are still yours.
export const SOUL_OK = /^[A-Za-z0-9:_-]{6,64}$/;
export function adoptSoul(uid, file = profilePath()) {
  if (!SOUL_OK.test(uid)) throw new Error('A soul id is 6 to 64 letters, numbers, dashes or colons.');
  const profile = loadProfile(file);
  if (!profile) throw new Error('There is no profile on this device yet. Run selecle whoami first.');
  saveProfile({ ...profile, uid }, file);
  return uid;
}
