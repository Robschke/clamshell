// Purpose: The streaming app tiles and URL helpers (app lookup, navigation style, user agent, YouTube link conversion).
// Depends on: nothing (pure data and functions).
// Used by: src/server/tv-controller.js, src/server/http-server.js
// Notes:
// - `scopePath` limits `navigation: "native"` and `userAgent` to one part of a host: only
//   youtube.com/tv is the TV app; any other youtube.com page is the desktop site, which gets the
//   default user agent and spatial navigation like any other site.
// - The TV user agent is a Cobalt string (the engine of the official YouTube TV app, here as a
//   Chromecast with Google TV). Checked in headless Chrome: youtube.com/tv stays on /tv, renders
//   the leanback app (`ytlr-app`) and plays /tv#/watch?v=<id> deep links. Tizen and webOS strings
//   also load the app, but their deep links fall back to the home screen without playing, and
//   desktop user agents only get a "redirecting to youtube.com" notice.

export const YOUTUBE_TV_USER_AGENT =
  'Mozilla/5.0 (Linux armeabi-v7a; Android 9) Cobalt/23.lts.4.308245-gold (unlike Gecko) v8/8.8.278.17-jit gles '
  + 'Starboard/14, Google_ATV_sabrina_2020/STTE.230319.008.R1 (google, Chromecast, Wired)';

export const APPS = Object.freeze([
  {
    id: 'netflix',
    name: 'Netflix',
    url: 'https://www.netflix.com/browse',
    color: '#E50914',
    textColor: '#FFFFFF',
    hosts: ['netflix.com'],
    navigation: 'spatial',
  },
  {
    id: 'youtube',
    name: 'YouTube',
    url: 'https://www.youtube.com/tv',
    color: '#FF0033',
    textColor: '#FFFFFF',
    hosts: ['youtube.com', 'youtu.be'],
    navigation: 'native',
    scopePath: '/tv',
    userAgent: YOUTUBE_TV_USER_AGENT,
  },
  {
    id: 'prime',
    name: 'Prime Video',
    url: 'https://www.primevideo.com',
    color: '#1A98FF',
    textColor: '#FFFFFF',
    hosts: ['primevideo.com'],
    navigation: 'spatial',
  },
  {
    id: 'disney',
    name: 'Disney+',
    url: 'https://www.disneyplus.com',
    color: '#0E2A82',
    textColor: '#FFFFFF',
    hosts: ['disneyplus.com'],
    navigation: 'spatial',
  },
  {
    id: 'hbomax',
    name: 'HBO Max',
    url: 'https://play.hbomax.com',
    color: '#002BE7',
    textColor: '#FFFFFF',
    hosts: ['hbomax.com', 'max.com'],
    navigation: 'spatial',
  },
]);

// The public tile list for /api/apps.
export function publicApps() {
  return APPS.map(({ id, name, url, color, textColor }) => ({ id, name, url, color, textColor }));
}

export function findAppById(appId) {
  return APPS.find((app) => app.id === appId) ?? null;
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function hostMatches(hostname, host) {
  return hostname === host || hostname.endsWith(`.${host}`);
}

function inScope(app, parsed) {
  if (!app.scopePath) return true;
  return parsed.pathname === app.scopePath || parsed.pathname.startsWith(`${app.scopePath}/`);
}

// The app whose host the URL belongs to, or null (launcher, other sites, invalid URLs).
export function findAppByUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  const hostname = parsed.hostname.toLowerCase();
  return APPS.find((app) => app.hosts.some((host) => hostMatches(hostname, host))) ?? null;
}

// The user agent override a URL needs, or "" for the browser default.
export function userAgentForUrl(url) {
  const app = findAppByUrl(url);
  if (!app || !app.userAgent) return '';
  return inScope(app, parseUrl(url)) ? app.userAgent : '';
}

// "native" when the page handles arrow keys itself (launcher, YouTube TV), otherwise "spatial".
export function navigationForUrl(url, launcherOrigin) {
  const parsed = parseUrl(url);
  if (!parsed) return 'spatial';
  if (launcherOrigin && parsed.origin === launcherOrigin && parsed.pathname.startsWith('/tv')) return 'native';
  const app = findAppByUrl(url);
  if (app && app.navigation === 'native' && inScope(app, parsed)) return 'native';
  return 'spatial';
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;

// Extracts the video id from youtube.com/watch?v=, youtu.be/<id> and youtube.com/shorts/<id> links.
export function youtubeVideoId(url) {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  const hostname = parsed.hostname.toLowerCase();
  let id = null;
  if (hostMatches(hostname, 'youtu.be')) {
    id = parsed.pathname.split('/')[1] ?? null;
  } else if (hostMatches(hostname, 'youtube.com') || hostMatches(hostname, 'youtube-nocookie.com')) {
    if (parsed.pathname === '/watch') id = parsed.searchParams.get('v');
    else if (parsed.pathname.startsWith('/shorts/')) id = parsed.pathname.split('/')[2] ?? null;
    else if (parsed.pathname.startsWith('/live/')) id = parsed.pathname.split('/')[2] ?? null;
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}

// Normalizes a URL from the remote: YouTube watch links become YouTube TV links, other
// http(s) URLs pass through, a bare "example.com" gets https://. Returns null when not openable.
export function resolveOpenUrl(raw) {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text) && /^[^\s/]+\.[^\s/]+/.test(text)) text = `https://${text}`;
  const parsed = parseUrl(text);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
  const videoId = youtubeVideoId(parsed.href);
  if (videoId) return `https://www.youtube.com/tv#/watch?v=${videoId}`;
  return parsed.href;
}
