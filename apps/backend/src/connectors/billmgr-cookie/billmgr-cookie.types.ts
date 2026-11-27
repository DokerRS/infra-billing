/**
 * Credentials for the cookie-based BILLmanager auth. Unlike the API connector there is no
 * `func=auth` handshake: the owner pastes the session cookie copied out of their browser
 * (DevTools → Application → Cookies), and the panel accepts it only when the request also comes
 * from the same browser, so the User-Agent the cookie was copied with is stored next to it.
 */
export interface BillmgrCookieCredentials {
  baseUrl: string; // CGI URL, e.g. https://my.akenai.host/billmgr
  cookie: string; // verbatim Cookie header value, e.g. "billmgrlang5=dragon:ru; billmgrses5=46e7…"
  userAgent?: string; // browser UA the cookie was copied from; the panel rejects a mismatched client
  // Optional refresh pair. A session cookie dies (idle timeout / re-login), and the only way to
  // renew it without a browser is a real func=auth. Without these the connector fails with an
  // explicit "paste a fresh cookie" message instead of silently reporting an empty account.
  username?: string;
  password?: string;
  totpSecret?: string; // base32 seed for OTP 2FA, lets the refresh confirm the one-time code
}

/**
 * BILLmanager names the session cookie after the panel's internal version suffix (`billmgrses5` on
 * the current line, plain `billmgrses` on older installs), so match any `billmgrses…` name.
 */
const SESSION_COOKIE_RE = /(?:^|[;\s])billmgrses\w*\s*=\s*([0-9a-f]{8,64})/i;

/**
 * The session id carried by the cookie. BILLmanager's CGI takes it as the `auth` query param, so
 * the connector sends both the verbatim Cookie header and the id — whichever the install reads.
 */
export function billmgrSessionId(cookie: string): string | null {
  return SESSION_COOKIE_RE.exec(cookie)?.[1] ?? null;
}

/**
 * Rebuild the Cookie header with a new session id (after a func=auth refresh), keeping every other
 * pair — notably `billmgrlang5`, which pins the skin/language the session was created under.
 */
export function replaceBillmgrSessionId(cookie: string, id: string): string {
  let replaced = false;
  const parts = cookie
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const eq = p.indexOf('=');
      if (eq < 0) return p;
      const name = p.slice(0, eq).trim();
      if (!/^billmgrses\w*$/i.test(name)) return p;
      replaced = true;
      return `${name}=${id}`;
    });
  if (replaced) return parts.join('; ');
  return `${cookie.replace(/;+$/, '').trim()}; billmgrses5=${id}`;
}

/**
 * The Cookie header with the session pair removed, keeping everything else (notably the language
 * pin). A renewal must be sent without the dead session: an install that no longer resolves the
 * id answers *any* request carrying it — including `func=auth` — with a session error, so the
 * renewal could never get as far as checking the login.
 */
export function withoutBillmgrSessionId(cookie: string): string {
  return cookie
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !/^billmgrses\w*\s*=/i.test(p))
    .join('; ');
}
