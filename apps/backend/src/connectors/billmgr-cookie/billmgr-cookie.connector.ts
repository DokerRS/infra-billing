import { Logger } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
import Decimal from 'decimal.js';
import { normalizeCurrency } from '../common/currency';
import { REQUEST_TIMEOUT_MS } from '../common/http';
import { totpCode } from '../common/totp';
import {
  asArray,
  billmgrError,
  currencyFromAmount,
  firstNumber,
  isCaptchaError,
  isFuncUnavailable,
  isPaymentCredited,
  isPrivilegeError,
  parseBillmgrDate,
  val,
} from '../billmgr/billmgr.parse';
import { mapBillmgrService } from '../billmgr/billmgr.mapper';
import { billmgrHttpError, isChallengePage } from '../billmgr/billmgr.connector';
import { BillmgrDoc } from '../billmgr/billmgr.types';
import { Account, Connector, PaymentData, ServiceData } from '../connector.interface';
import {
  billmgrSessionId,
  replaceBillmgrSessionId,
  type BillmgrCookieCredentials,
} from './billmgr-cookie.types';

// Same CGI API and the same item-type split as the API connector (see billmgr.connector): custom
// item types live behind dotted subtypes of these base funcs, so fetchServices extends this
// baseline with the funcs the client menu exposes.
const ITEM_FUNCS: { func: string; type: string }[] = [
  { func: 'vds', type: 'vps' },
  { func: 'dedic', type: 'dedicated' },
  { func: 'vhost', type: 'other' }, // shared hosting
  { func: 'domain', type: 'domain' },
  { func: 'certificate', type: 'license' },
];

// The cookie has no stored credentials to renew it with — the only fix is a fresh paste. Kept
// short so it survives the notification's 200-char clamp.
const COOKIE_EXPIRED_MESSAGE =
  'BILLmanager: the stored session cookie was rejected (expired or re-login elsewhere). Open the panel ' +
  'in the same browser, log in again and paste the fresh billmgrses cookie with the same User-Agent. ' +
  'Adding the panel login/password lets the sync renew the session itself.';

const NO_SESSION_COOKIE_MESSAGE =
  'BILLmanager: the pasted cookie has no billmgrses session value — copy the whole Cookie string from ' +
  'the panel tab in DevTools (it looks like "billmgrlang5=dragon:ru; billmgrses5=46e7…").';

// func=auth is guarded by BILLmanager's own CAPTCHA on some installs. A browser cookie proves a
// human already passed it, but a renewal from this server cannot, and the stateless authinfo
// auth belongs to the API connector — so ask for the panel-side fix.
const REFRESH_CAPTCHA_MESSAGE =
  'BILLmanager: the panel gates func=auth behind its own CAPTCHA, so the session cookie cannot be renewed ' +
  'automatically — paste a fresh cookie, or ask the hoster to allow API auth for this server IP.';

const TOTP_FAILED_MESSAGE =
  'BILLmanager: failed to confirm the renewed login via OTP — check the TOTP secret (the same one as in ' +
  'your authenticator app) and the server clock synchronization.';

/**
 * func=whoami answered «У вас недостаточно прав на выполнение функции 'whoami'». The session is
 * alive — BILLmanager recognized it and refused a single function — so the sync loses the balance
 * and the account currency, nothing else. Reported once per run instead of failing the sync.
 */
const ACCOUNT_INFO_FORBIDDEN_MESSAGE =
  'BILLmanager: func=whoami is not permitted for this account, so balance and currency are unavailable. ' +
  'Services and payments are still synced. Ask the hoster to grant the whoami right to restore the balance.';

// A restricted client role can be refused *every* list func at once (seen live on a cookie session:
// whoami, menu, vds, dedic, vhost, domain, certificate, payment and expense all answered
// «недостаточно прав»). Each refusal is individually skippable, but together they mean nothing was
// read — and returning an empty list would make the sync deactivate every service in the account.
// The message for that case is built by allFuncsRefusedMessage(), because its advice depends on
// whether the session could be renewed at all.

/**
 * A session the CGI no longer recognizes. BILLmanager reports it as an auth error on the data
 * func, and the codes are stable across locales ($object/$type), unlike the localized msg.
 * `forbidden_auth_method` is the API-allowlist refusal, which a cookie sync cannot fix — but it
 * only ever answers an authinfo request, never a session one, so it cannot be confused here.
 */
function isSessionRejected(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  const code = [e.$object, e.$type].filter((s): s is string => typeof s === 'string').join(' ');
  return /auth|session|login/i.test(code);
}

/**
 * ISPsystem BILLmanager over a browser session instead of the API user. The owner pastes the
 * `Cookie` string copied from a logged-in panel tab plus the User-Agent it belongs to (the panel
 * ties the session to the client that created it), and every CGI call is sent with both — the
 * verbatim `Cookie` header and the session id from `billmgrses…` as the documented `auth` param,
 * so the request works whether the install reads the header, the query, or both.
 *
 * Everything after auth (lists, ledgers, sticky filters, menu discovery) is the same CGI API as
 * the API connector, so those helpers are reused from it. The cookie is the whole cost of this
 * trade: it expires. When it does, and login/password were stored, the connector re-authenticates
 * with func=auth (confirming OTP 2FA when a TOTP secret is set), keeps the new session id for the
 * rest of the run, and hands the renewed cookie to the sync via {@link onCredentialsRenewed} so it
 * replaces the stored one; without credentials it fails with COOKIE_EXPIRED_MESSAGE instead of
 * quietly reporting an empty account.
 */
export class BillmgrCookieConnector implements Connector {
  private readonly logger = new Logger(BillmgrCookieConnector.name);
  private readonly http: AxiosInstance;
  private readonly creds: BillmgrCookieCredentials;
  private cookie: string;
  private sessionId: string | null;
  /** Set by the sync: receives the full credentials JSON with the renewed cookie (see Connector). */
  onCredentialsRenewed?: (credentialsJson: string) => void;
  private whoamiDoc: BillmgrDoc | null = null; // cached by the auth-verification probe
  // whoami is refused for this account (see ACCOUNT_INFO_FORBIDDEN_MESSAGE). The session itself is
  // fine — BILLmanager answered as an authenticated user — so the rest of the sync must go on.
  private whoamiForbidden = false;
  // One renewal per run: if a func still comes back rejected after a fresh session, the cookie
  // itself is the problem and re-authenticating again would just loop.
  private refreshAttempted = false;
  // The renewal succeeded this run (func=auth gave a working session). Refusal messages use it to
  // tell "the renewed session has no rights" apart from "we could not renew at all".
  private sessionRenewed = false;

  constructor(creds: BillmgrCookieCredentials) {
    this.creds = creds;
    this.cookie = creds.cookie.trim();
    this.sessionId = billmgrSessionId(this.cookie);
    this.http = axios.create({
      baseURL: creds.baseUrl.replace(/\/+$/, ''),
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        // The panel matches the session against the client that created it, so the UA has to be
        // the browser's, not axios's. Without a stored UA the request simply carries axios's own.
        ...(creds.userAgent ? { 'User-Agent': creds.userAgent } : {}),
        Cookie: this.cookie,
      },
    });
    // Same etiquette as the API connector: a non-2xx never comes from BILLmanager (it answers its
    // own failures as doc.error at HTTP 200) but from whatever fronts the panel, and a 2xx can be
    // an anti-bot gate answering with a CAPTCHA page.
    this.http.interceptors.response.use(
      (r) => {
        if (isChallengePage(r.data)) {
          const id = r.headers?.['cf-ray'] ?? r.headers?.['x-request'];
          throw new Error(
            'BILLmanager: an anti-bot check in front of the panel answered with a CAPTCHA page instead of ' +
              'JSON — the request never reached BILLmanager. Ask the hoster to allow access for this server.' +
              (typeof id === 'string' ? ` (request id ${id})` : ''),
          );
        }
        return r;
      },
      (e) => {
        throw billmgrHttpError(e);
      },
    );
  }

  kind(): string {
    return 'billmgr-cookie';
  }

  private authParams(): Record<string, string> {
    return { auth: this.sessionId as string };
  }

  /**
   * Validate the pasted session up front with func=whoami — the same probe the API connector uses,
   * and cached for fetchAccount so a valid cookie costs one extra request per run at most. An
   * account without the whoami right is probed with func=menu instead and remembered as such, so
   * the probe stays one request per run.
   */
  private async ensureSession(signal: AbortSignal): Promise<Record<string, string>> {
    if (!this.sessionId) throw new Error(NO_SESSION_COOKIE_MESSAGE);
    if (!this.whoamiDoc && !this.whoamiForbidden) await this.probe(signal);
    return this.authParams();
  }

  /** func=whoami against the current session; caches the doc and turns a rejected session into a renewal. */
  private async probe(signal: AbortSignal): Promise<BillmgrDoc | null> {
    const firstDoc = await this.raw('whoami', signal);
    const first = this.inspect(firstDoc);
    if (first.state === 'ok') return this.adoptWhoami(firstDoc);
    if (first.state === 'error' && first.privilege) {
      this.forbidWhoami(first.message);
      await this.verifySession(signal);
      return null;
    }
    if (first.state === 'error') throw new Error(`BILLmanager (whoami): ${first.message}`);
    await this.refresh(signal);
    const renewed = await this.raw('whoami', signal);
    const after = this.inspect(renewed);
    if (after.state === 'ok') return this.adoptWhoami(renewed);
    if (after.state === 'error' && after.privilege) {
      this.forbidWhoami(after.message);
      await this.verifySession(signal);
      return null;
    }
    throw new Error(
      after.state === 'error' ? `BILLmanager (whoami): ${after.message}` : COOKIE_EXPIRED_MESSAGE,
    );
  }

  private adoptWhoami(data: unknown): BillmgrDoc | null {
    this.whoamiDoc = (data ?? null) as BillmgrDoc | null;
    return this.whoamiDoc;
  }

  /**
   * whoami is the cheapest way to prove the session is alive, but when the account may not call it
   * its refusal says nothing about the cookie. func=menu is readable by any client role, so it
   * takes over the job: a dead cookie still surfaces as an expired session instead of quietly
   * becoming an empty account. If even the menu is refused, the session is taken as good and the
   * data funcs speak for themselves.
   */
  private async verifySession(signal: AbortSignal): Promise<void> {
    const usable = (v: ReturnType<BillmgrCookieConnector['inspect']>) =>
      v.state === 'ok' || (v.state === 'error' && v.privilege);
    const first = this.inspect(await this.raw('menu', signal));
    if (usable(first)) {
      // A privilege-refused menu proves the panel recognized the session — but it is also exactly
      // how these installs answer once the pasted session id stops resolving, so a refusal alone
      // cannot tell a dead cookie apart from a rightless account. When login/password are stored
      // the session is renewed anyway and the fresh one answers for itself; a renewal failure is
      // only logged, since the current session may still be perfectly usable.
      if (first.state === 'error' && first.privilege) await this.tryRefresh(signal);
      return;
    }
    await this.refresh(signal);
    const after = this.inspect(await this.raw('menu', signal));
    if (usable(after)) return;
    throw new Error(
      after.state === 'error' ? `BILLmanager (menu): ${after.message}` : COOKIE_EXPIRED_MESSAGE,
    );
  }

  /** Renewal is possible when login/password are stored and this run has not tried yet. */
  private canRefresh(): boolean {
    return !this.refreshAttempted && !!this.creds.username && !!this.creds.password;
  }

  /**
   * {@link refresh} for the paths where the session may still be usable: a failed renewal is
   * logged and reported as false instead of failing the sync.
   */
  private async tryRefresh(signal: AbortSignal): Promise<boolean> {
    if (!this.canRefresh()) return false;
    try {
      await this.refresh(signal);
      return true;
    } catch (err) {
      this.logger.warn(`BILLmanager: session renewal failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** Remember that whoami is refused and say it once: the account info is lost, the sync is not. */
  private forbidWhoami(message: string): void {
    if (this.whoamiForbidden) return;
    this.whoamiForbidden = true;
    this.logger.warn(`${ACCOUNT_INFO_FORBIDDEN_MESSAGE} (the panel said: ${message})`);
  }

  private async raw(
    func: string,
    signal: AbortSignal,
    extra?: Record<string, string>,
    authOverride?: Record<string, string>,
  ): Promise<unknown> {
    const auth = authOverride ?? this.authParams();
    const { data } = await this.http.get<unknown>('', {
      params: { func, ...auth, out: 'json', ...extra },
      signal,
    });
    return data;
  }

  /**
   * What a response says about the session. `out=json` normally arrives parsed into `doc`;
   * anything else is the panel speaking in another voice: an HTML page (the login form, i.e. a
   * bounced session — or a base URL pointing at the site instead of the CGI), or an auth error.
   * A func that got redirected to the login form answers with a bare `doc.ok` and no payload,
   * which is how the API connector sees an unconfirmed 2FA session.
   */
  private inspect(
    data: unknown,
  ):
    | { state: 'ok' }
    | { state: 'expired' }
    | { state: 'error'; message: string; privilege: boolean; raw: unknown } {
    if (typeof data === 'string') {
      return /<html|<!doctype/i.test(data.slice(0, 512))
        ? { state: 'expired' }
        : {
            state: 'error',
            privilege: false,
            raw: data,
            message:
              'the panel answered with plain text instead of JSON — check that the base URL points at the /billmgr endpoint',
          };
    }
    const doc = (data as BillmgrDoc | null)?.doc;
    if (!doc) return { state: 'expired' };
    if (doc.error) {
      return isSessionRejected(doc.error)
        ? { state: 'expired' }
        : {
            state: 'error',
            message: billmgrError(doc.error),
            privilege: isPrivilegeError(doc.error),
            raw: doc.error,
          };
    }
    if (
      doc.ok !== undefined &&
      doc.user === undefined &&
      doc.elem === undefined &&
      doc.mainmenu === undefined
    ) {
      return { state: 'expired' };
    }
    return { state: 'ok' };
  }

  /**
   * Renew a dead session with a real func=auth, then adopt the new id: the Cookie header is
   * rewritten in place (keeping `billmgrlang5` and any other pair) and the id is used as `auth`.
   * Requires stored login/password — that is the whole point of the optional credential pair.
   */
  private async refresh(signal: AbortSignal): Promise<void> {
    if (this.refreshAttempted) throw new Error(COOKIE_EXPIRED_MESSAGE);
    this.refreshAttempted = true;
    const { username, password } = this.creds;
    if (!username || !password) throw new Error(COOKIE_EXPIRED_MESSAGE);

    const body = new URLSearchParams({ func: 'auth', username, password, out: 'json' });
    const { data } = await this.http.post<BillmgrDoc>('', body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal,
    });
    if (data?.doc?.error) {
      if (isCaptchaError(data.doc.error)) throw new Error(REFRESH_CAPTCHA_MESSAGE);
      throw new Error(`BILLmanager: func=auth refresh failed (${billmgrError(data.doc.error)})`);
    }
    let id = data?.doc?.auth?.$id ?? data?.doc?.session?.$id;
    if (!id) throw new Error(COOKIE_EXPIRED_MESSAGE);

    this.adoptSession(id);
    let whoami = await this.raw('whoami', signal);
    let verdict = this.inspect(whoami);
    if (verdict.state === 'expired') {
      // func=auth returned an id but the session is unconfirmed — 2FA is pending.
      if (!this.creds.totpSecret) {
        throw new Error(
          'BILLmanager: 2FA is enabled on the account. If it is OTP (Google Authenticator) — add the TOTP ' +
            'secret in the provider settings and the sync will confirm the code itself. SMS-2FA cannot be automated.',
        );
      }
      id = await this.confirmTotp(id, signal);
      this.adoptSession(id);
      whoami = await this.raw('whoami', signal);
      verdict = this.inspect(whoami);
      if (verdict.state === 'expired') throw new Error(TOTP_FAILED_MESSAGE);
    }
    if (verdict.state === 'error' && verdict.privilege) {
      // The renewal worked — whoami just stays off-limits for this account.
      this.forbidWhoami(verdict.message);
    } else if (verdict.state === 'error') {
      throw new Error(`BILLmanager (whoami): ${verdict.message}`);
    } else {
      // The fresh session may hold rights the old one lost — take its whoami back into use.
      this.whoamiForbidden = false;
      this.adoptWhoami(whoami);
    }
    this.sessionRenewed = true;
    // The renewed session is confirmed working — hand the whole credentials blob with the fresh
    // cookie to the sync so it replaces the one the owner pasted. Best-effort by contract: a
    // failure here only means the next run renews again, so it must not fail this sync.
    try {
      this.onCredentialsRenewed?.(JSON.stringify({ ...this.creds, cookie: this.cookie }));
    } catch (err) {
      this.logger.warn(`BILLmanager: renewed cookie not stored: ${(err as Error).message}`);
    }
    this.logger.log('BILLmanager cookie session renewed via func=auth');
  }

  private adoptSession(id: string): void {
    this.sessionId = id;
    this.cookie = replaceBillmgrSessionId(this.cookie, id);
    this.http.defaults.headers.common.Cookie = this.cookie;
    this.whoamiDoc = null;
  }

  /**
   * Confirm an OTP-2FA session by submitting the current TOTP code to func=totp.confirm. Returns
   * the fresh session id BILLmanager issues on success (the old one stays half-privileged).
   */
  private async confirmTotp(auth: string, signal: AbortSignal): Promise<string> {
    const code = totpCode(this.creds.totpSecret as string, Date.now());
    const body = new URLSearchParams({
      func: 'totp.confirm',
      auth,
      qrcode: code,
      sok: 'ok',
      out: 'json',
    });
    const { data } = await this.http.post<BillmgrDoc>('', body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal,
    });
    if (data?.doc?.error) throw new Error(`BILLmanager: ${billmgrError(data.doc.error)}`);
    return data?.doc?.auth?.$id ?? auth;
  }

  private async call(
    func: string,
    signal: AbortSignal,
    extra?: Record<string, string>,
  ): Promise<BillmgrDoc> {
    await this.ensureSession(signal);
    const data = await this.raw(func, signal, extra);
    let verdict = this.inspect(data);
    if (verdict.state === 'expired') {
      await this.refresh(signal);
      const retry = await this.raw(func, signal, extra);
      verdict = this.inspect(retry);
      if (verdict.state === 'expired') throw new Error(COOKIE_EXPIRED_MESSAGE);
      return retry as BillmgrDoc;
    }
    if (verdict.state === 'error') {
      // `cause` keeps the raw doc.error so callers can classify it (see isFuncUnavailable).
      throw new Error(`BILLmanager (${func}): ${verdict.message}`, { cause: verdict.raw });
    }
    return data as BillmgrDoc;
  }

  /** Page through a list func, accumulating doc.elem rows (see the API connector for the detail). */
  private async listAll(
    func: string,
    signal: AbortSignal,
    extra?: Record<string, string>,
  ): Promise<Record<string, unknown>[]> {
    const PAGE = 1000;
    const rows: Record<string, unknown>[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const data = await this.call(func, signal, {
        ...extra,
        p_cnt: String(PAGE),
        p_num: String(page),
      });
      const batch = asArray(data?.doc?.elem) as Record<string, unknown>[];
      rows.push(...batch);
      if (batch.length === 0) break;
      const total = Number(val(data?.doc?.p_elems));
      if (Number.isFinite(total) && total > 0) {
        if (rows.length >= total) break;
      } else if (batch.length < PAGE) {
        break;
      }
    }
    return rows;
  }

  /**
   * List filters are sticky and account-level, so reset them by submitting the filter form with
   * its empty defaults. The form only applies when posted normally (without out=json).
   * Best-effort: a failed reset just leaves the current filter in place.
   */
  private async clearListFilter(
    func: string,
    fields: Record<string, string>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.ensureSession(signal);
      const body = new URLSearchParams({ func, ...this.authParams(), sok: 'ok', ...fields });
      await this.http.post('', body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
    } catch {
      // best-effort
    }
  }

  private clearExpenseFilter(signal: AbortSignal): Promise<void> {
    return this.clearListFilter(
      'expense.filter',
      {
        item: '',
        id: '',
        locale_name: '',
        fromdate: '',
        todate: '',
        amount: '',
        compare_type: 'null',
        notpayd_compare_type: 'null',
        notpayd_amount: '',
      },
      signal,
    );
  }

  private clearPaymentFilter(signal: AbortSignal): Promise<void> {
    return this.clearListFilter(
      'payment.filter',
      {
        id: '',
        number: '',
        sender: '',
        sender_id: '',
        createdate: 'nodate',
        createdatestart: '',
        createdateend: '',
        payfromdate: '',
        paytodate: '',
        paymethod: '',
        status: '',
        saamount_from: '',
        saamount_to: '',
        pmamount_from: '',
        pmamount_to: '',
        restrictrefund: 'null',
      },
      signal,
    );
  }

  /**
   * The panel favicon sits behind a per-install skin path the domain-based favicon services never
   * find; the login page names it in <link rel="shortcut icon">, and that page needs no session.
   */
  async fetchFaviconUrl(signal: AbortSignal): Promise<string | null> {
    const { data } = await this.http.get<unknown>('', { signal });
    if (typeof data !== 'string') return null;
    const tag = /<link[^>]*rel=["'][^"']*icon[^"']*["'][^>]*>/i.exec(data.slice(0, 16_384))?.[0];
    const href = tag ? /href=["']([^"']+)["']/i.exec(tag)?.[1] : undefined;
    if (!href) return null;
    try {
      const url = new URL(href, this.http.defaults.baseURL);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  async fetchAccount(signal: AbortSignal): Promise<Account> {
    await this.ensureSession(signal);
    // ensureSession already fetched (and validated) whoami; reuse it instead of a 2nd request.
    const data = this.whoamiDoc ?? (this.whoamiForbidden ? null : await this.probe(signal));
    if (!data) {
      // whoami is off-limits (see forbidWhoami). Balance has no other source, but the currency is
      // still worth having — it labels every service — so read it off a ledger amount instead.
      return { balance: null, currency: await this.guessCurrency(signal) };
    }
    const u = data?.doc?.user ?? {};
    const balanceStr = firstNumber(u.$balance == null ? undefined : String(u.$balance));
    return {
      balance: balanceStr != null ? new Decimal(balanceStr) : null,
      currency: normalizeCurrency(u.$currency == null ? undefined : String(u.$currency)),
    };
  }

  /**
   * Currency without whoami: BILLmanager renders amounts with the account currency attached
   * ("49.99 руб."), so one row of any ledger func names it. Best-effort — with no readable ledger
   * the account falls back to RUB, which only mislabels the amounts, it cannot lose them.
   */
  private async guessCurrency(signal: AbortSignal): Promise<string> {
    for (const func of ['payment', 'expense']) {
      try {
        const data = await this.call(func, signal, { p_cnt: '1', p_num: '1' });
        const row = (asArray(data?.doc?.elem) as Record<string, unknown>[])[0];
        if (!row) continue;
        const raw =
          val(row.paymethodamount_iso) ?? val(row.subaccountamount_iso) ?? val(row.amount);
        if (raw && /\D/.test(raw)) return currencyFromAmount(raw);
      } catch {
        // this func is unavailable too — try the next one
      }
    }
    return normalizeCurrency(undefined);
  }

  /**
   * The client menu lists the item funcs this install actually exposes, including custom item
   * types behind dotted subtypes of the base funcs. ITEM_FUNCS stays the fallback.
   */
  private async discoverItemFuncs(signal: AbortSignal): Promise<{ func: string; type: string }[]> {
    const funcs = new Map(ITEM_FUNCS.map((f) => [f.func, f.type]));
    try {
      const data = await this.call('menu', signal);
      const mainmenu = data?.doc?.mainmenu as Record<string, unknown> | undefined;
      for (const group of asArray(mainmenu?.node) as Record<string, unknown>[]) {
        if (group.$name !== 'mainmenuservice') continue;
        for (const node of asArray(group.node) as Record<string, unknown>[]) {
          const action = typeof node.$action === 'string' ? node.$action : undefined;
          if (!action || node.$type !== 'list' || funcs.has(action)) continue;
          const baseType = funcs.get(action.split('.')[0]);
          if (baseType) funcs.set(action, baseType);
        }
      }
    } catch (err) {
      this.logger.warn(`func=menu failed, using static item funcs: ${(err as Error).message}`);
    }
    return [...funcs].map(([func, type]) => ({ func, type }));
  }

  async fetchServices(signal: AbortSignal): Promise<ServiceData[]> {
    // Establish (and validate) the session up front so an expired-cookie failure propagates,
    // otherwise the per-func catch below would swallow it and silently return 0 services.
    await this.ensureSession(signal);
    const out: ServiceData[] = [];
    const seen = new Set<string>();
    const itemFuncs = await this.discoverItemFuncs(signal);

    /**
     * Read the given item funcs into `out`, recording the ones the account was refused. Refused
     * because it may not view them is different from simply absent from this install — only the
     * former can mean "the account has services we were not allowed to read".
     */
    const readFuncs = async (
      funcs: { func: string; type: string }[],
      refused: string[],
    ): Promise<void> => {
      for (const { func, type } of funcs) {
        let rows: Record<string, unknown>[];
        try {
          // Paged: an install serves a list one page at a time, and reading only the first page
          // would hand the sync a partial account — everything left off is then marked inactive.
          rows = await this.listAll(func, signal);
        } catch (err) {
          // Only a func this install does not have is skipped. Any other failure (panel error,
          // timeout, a filter the account cannot use) must fail the sync: silently dropping the
          // func's services would deactivate every one of them.
          if (!isFuncUnavailable(err)) throw err;
          if (isPrivilegeError(err)) refused.push(func);
          this.logger.warn(`BILLmanager: func=${func} unavailable, skipped: ${billmgrError(err)}`);
          continue;
        }
        for (const e of rows) {
          const svc = mapBillmgrService(e, type);
          if (!svc.externalId || seen.has(svc.externalId)) continue;
          seen.add(svc.externalId);
          out.push(svc);
        }
      }
    };

    // Refused because the account may not view them, vs. simply absent from this install. Only the
    // former can mean "the account has services we were not allowed to read".
    const refused: string[] = [];
    await readFuncs(itemFuncs, refused);
    // An empty result is honest when the item lists were merely absent from the install, but when
    // every one of them was refused for lack of rights nothing was read at all — and reporting zero
    // services would deactivate every service in the account.
    if (out.length === 0 && itemFuncs.length > 0 && refused.length === itemFuncs.length) {
      // On these installs a session id the panel no longer resolves answers exactly like a
      // rightless account — «недостаточно прав» on every func. Before blaming the account, renew
      // the session once (when a login/password is stored) and re-read the refused funcs.
      if (await this.tryRefresh(signal)) {
        const retry = itemFuncs.filter((f) => refused.includes(f.func));
        refused.length = 0;
        await readFuncs(retry, refused);
      }
    }
    if (out.length === 0 && itemFuncs.length > 0 && refused.length === itemFuncs.length) {
      throw new Error(`${this.allFuncsRefusedMessage()} (refused: ${refused.join(', ')})`);
    }
    return out;
  }

  /**
   * The two dead ends need different fixes, so they must not share one message: a renewed session
   * that is still refused means the account itself lacks the rights, while no renewal at all means
   * there was nothing to renew with. The advice comes first — the notification clamps long text.
   */
  private allFuncsRefusedMessage(): string {
    if (this.sessionRenewed)
      return (
        'BILLmanager: a freshly renewed session was refused by every service list, so nothing was ' +
        'read. The sync was aborted to keep the services active — ask the hoster for view rights.'
      );
    if (this.creds.username && this.creds.password)
      return (
        'BILLmanager: every service list was refused and renewing the session failed (see the sync ' +
        'log for why). The sync was aborted to keep the services active.'
      );
    return (
      'BILLmanager: every service list was refused and the session cannot be renewed — add the panel ' +
      'login/password in the provider settings, or paste a fresh cookie. Services were kept active.'
    );
  }

  /**
   * Same ledger import as the API connector: func=payment (top-ups) and func=expense (charges),
   * each best-effort and paged in full, with the sticky filters reset first.
   */
  async fetchPayments(signal: AbortSignal): Promise<PaymentData[]> {
    await this.ensureSession(signal);
    const out: PaymentData[] = [];
    const seen = new Set<string>();
    const add = (p: PaymentData) => {
      if (seen.has(p.externalId)) return;
      seen.add(p.externalId);
      out.push(p);
    };

    try {
      await this.clearPaymentFilter(signal);
      const skippedByStatus = new Map<string, number>();
      for (const e of await this.listAll('payment', signal)) {
        const id = val(e.id);
        const amountRaw =
          val(e.paymethodamount_iso) ?? val(e.subaccountamount_iso) ?? val(e.amount);
        const amountStr = firstNumber(amountRaw);
        const date = parseBillmgrDate(val(e.pay_date) ?? val(e.create_date));
        if (!id || amountStr == null || !date) continue;
        const number = val(e.number) ?? '';
        const status = val(e.status);
        const isRefund = number.toLowerCase().startsWith('return');
        const sign = isRefund ? -1 : 1;
        if (!isRefund && !isPaymentCredited(status)) {
          skippedByStatus.set(status!, (skippedByStatus.get(status!) ?? 0) + 1);
          continue;
        }
        add({
          externalId: `payment:${id}`,
          type: 'topup',
          amount: new Decimal(amountStr).mul(sign),
          currency: currencyFromAmount(amountRaw),
          date,
          description: number ? `Payment ${number}` : 'Payment',
        });
      }
      if (skippedByStatus.size) {
        const detail = [...skippedByStatus].map(([s, n]) => `"${s}" ×${n}`).join(', ');
        this.logger.log(`func=payment: skipped non-credited payment(s): ${detail}`);
      }
    } catch (err) {
      this.logger.warn(`func=payment list failed, top-ups not imported: ${(err as Error).message}`);
    }

    try {
      await this.clearExpenseFilter(signal);
      for (const e of await this.listAll('expense', signal)) {
        const id = val(e.id);
        const amountStr = firstNumber(val(e.amount));
        const date = parseBillmgrDate(val(e.realdate) ?? val(e.realdate_l));
        if (!id || amountStr == null || !date) continue;
        add({
          externalId: `expense:${id}`,
          type: 'charge',
          amount: new Decimal(amountStr),
          currency: currencyFromAmount(val(e.amount)),
          date,
          description: val(e.locale_name) ?? val(e.intname),
          serviceExternalId: val(e.main_item) ?? val(e.item),
        });
      }
    } catch (err) {
      this.logger.warn(`func=expense list failed, charges not imported: ${(err as Error).message}`);
    }

    return out;
  }
}
