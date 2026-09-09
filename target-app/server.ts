/**
 * LegacyCore "Teller Console": a deliberately hostile stand-in for a vendor core-banking UI.
 *
 * Hostile on purpose:
 *   - framesets (banner / menu / main), server-rendered, full page reloads
 *   - table-based layout, <font> tags, no ids, no data-testids, generic input names (txt1, sel1)
 *   - native confirm() dialogs on irreversible actions
 *   - runtime conditions that a replay must survive: validation errors, record-not-found,
 *     permission denial, session expiry, interstitial notices, slow loads, hard 500s
 *
 * Multi-tenant on purpose: the same product is mounted twice (/t/alpha, /t/beta) with different
 * branding, labels, frame names and one extra interstitial, the way two institutions running the
 * same vendor product look different in practice.
 */
import express, { Request, Response, NextFunction } from 'express';
import cookieSession from 'cookie-session';
import { MEMBERS, USERS, fmtMoney } from './data.js';

type Chaos = 'none' | 'timeout' | 'interstitial' | 'slow' | 'crash';

interface TenantConfig {
  id: string;
  institution: string;
  color: string;
  frames: { banner: string; menu: string; main: string };
  labels: {
    signOn: string;
    userId: string;
    password: string;
    memberInquiry: string;
    memberNumber: string;
    inquire: string;
    openSub: string;
    balanceHeader: string;
  };
  loginInterstitial: boolean;
}

const TENANTS: Record<string, TenantConfig> = {
  alpha: {
    id: 'alpha',
    institution: 'Hoosier Federal Credit Union',
    color: '#1f3d7a',
    frames: { banner: 'banner', menu: 'menu', main: 'main' },
    labels: {
      signOn: 'Sign On',
      userId: 'User ID',
      password: 'Password',
      memberInquiry: 'Member Inquiry',
      memberNumber: 'Member Number',
      inquire: 'Inquire',
      openSub: 'Open Sub-Account',
      balanceHeader: 'Current Balance',
    },
    loginInterstitial: false,
  },
  beta: {
    id: 'beta',
    institution: 'Riverbend Community Bank',
    color: '#5a1f1f',
    frames: { banner: 'hdr', menu: 'sidebar', main: 'content' },
    labels: {
      signOn: 'Log In',
      userId: 'Operator ID',
      password: 'Passcode',
      memberInquiry: 'Customer Lookup',
      memberNumber: 'Member No.',
      inquire: 'Search',
      openSub: 'Add Sub-Account',
      balanceHeader: 'Ledger Balance',
    },
    loginInterstitial: true,
  },
};

const chaosState: Record<string, Chaos> = { alpha: 'none', beta: 'none' };
const requestCounters: Record<string, number> = {};

export function createApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieSession({ name: 'lcsess', keys: ['not-a-real-secret'], maxAge: 60 * 60 * 1000 }));

  // ---- chaos control (test hook, not part of the "product") ----
  app.get('/__chaos', (req, res) => {
    const t = String(req.query.tenant ?? 'alpha');
    if (req.query.set) chaosState[t] = String(req.query.set) as Chaos;
    res.json({ tenant: t, chaos: chaosState[t] });
  });
  app.get('/__health', (_req, res) => res.json({ ok: true }));

  app.get('/', (_req, res) => {
    res.send(
      layout('LegacyCore', `<h3>LegacyCore Teller Console v7.2.1</h3>
      <table border="1" cellpadding="6"><tr><td><a href="/t/alpha/login">Hoosier Federal Credit Union (tenant alpha)</a></td></tr>
      <tr><td><a href="/t/beta/login">Riverbend Community Bank (tenant beta)</a></td></tr></table>`),
    );
  });

  app.use('/t/:tenant', tenantRouter());
  return app;
}

function tenantRouter() {
  const r = express.Router({ mergeParams: true });

  r.use((req: Request, res: Response, next: NextFunction) => {
    const t = TENANTS[(req.params as any).tenant];
    if (!t) return res.status(404).send('Unknown tenant');
    (req as any).tenant = t;
    next();
  });

  const base = (req: Request) => `/t/${(req as any).tenant.id}`;
  const sess = (req: Request) => (req.session as any) ?? {};

  // Session guard + chaos: everything under the console requires a login.
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const t: TenantConfig = (req as any).tenant;
    const s = sess(req);
    if (!s.user) return res.send(loginPage(t, base(req), 'Please sign on to continue.'));
    if (chaosState[t.id] === 'timeout') {
      // Simulates the host session dying underneath the UI. One-shot: clears itself after firing.
      chaosState[t.id] = 'none';
      (req.session as any) = null;
      return res.send(loginPage(t, base(req), 'Your session has expired due to inactivity. Please sign on again.'));
    }
    if (chaosState[t.id] === 'interstitial' && !s.ackNotice && !req.path.startsWith('/frame/')) {
      return res.send(interstitialPage(t, base(req), req.originalUrl));
    }
    next();
  };

  r.get('/login', (req, res) => res.send(loginPage((req as any).tenant, base(req))));
  r.post('/login', (req, res) => {
    const t: TenantConfig = (req as any).tenant;
    const u = USERS[String(req.body.uid ?? '')];
    if (!u || u.password !== String(req.body.pwd ?? '')) {
      return res.send(loginPage(t, base(req), 'Invalid User ID or Password.', true));
    }
    (req.session as any).user = String(req.body.uid);
    (req.session as any).role = u.role;
    (req.session as any).ackNotice = false;
    if (t.loginInterstitial) return res.redirect(`${base(req)}/notice?next=${encodeURIComponent(base(req) + '/console')}`);
    res.redirect(`${base(req)}/console`);
  });
  r.get('/logout', (req, res) => {
    (req.session as any) = null;
    res.redirect(`${base(req)}/login`);
  });

  r.get('/notice', (req, res) => {
    const t: TenantConfig = (req as any).tenant;
    res.send(interstitialPage(t, base(req), String(req.query.next ?? base(req) + '/console')));
  });
  r.post('/notice/ack', (req, res) => {
    (req.session as any).ackNotice = true;
    res.redirect(String(req.body.next ?? base(req) + '/console'));
  });

  r.get('/console', requireAuth, (req, res) => {
    const t: TenantConfig = (req as any).tenant;
    const b = base(req);
    res.send(`<html><head><title>${t.institution} - Teller Console</title></head>
<frameset rows="58,*" border="1" frameborder="1">
  <frame name="${t.frames.banner}" src="${b}/frame/banner" scrolling="no" noresize>
  <frameset cols="170,*">
    <frame name="${t.frames.menu}" src="${b}/frame/menu">
    <frame name="${t.frames.main}" src="${b}/home">
  </frameset>
</frameset></html>`);
  });

  r.get('/frame/banner', requireAuth, (req, res) => {
    const t: TenantConfig = (req as any).tenant;
    const s = sess(req);
    res.send(`<html><body style="margin:0;background:${t.color};color:#fff;font-family:Arial">
<table width="100%" cellpadding="8"><tr>
<td><font size="4"><b>${t.institution}</b></font> <font size="1">LegacyCore Teller Console v7.2.1</font></td>
<td align="right"><font size="2">Operator: ${USERS[s.user]?.display ?? '?'} &nbsp;|&nbsp; Branch 004 &nbsp;|&nbsp; <a href="${base(req)}/logout" target="_top" style="color:#fff">Sign Off</a></font></td>
</tr></table></body></html>`);
  });

  r.get('/frame/menu', requireAuth, (req, res) => {
    const t: TenantConfig = (req as any).tenant;
    const b = base(req);
    const item = (label: string, href: string) =>
      `<tr><td bgcolor="#e8e8e8" style="border-bottom:1px solid #999"><font size="2"><a href="${href}" target="${t.frames.main}">${label}</a></font></td></tr>`;
    const rows =
      t.id === 'alpha'
        ? [item('Home', `${b}/home`), item(t.labels.memberInquiry, `${b}/members`), item('Transactions', `${b}/stub/Transactions`), item('Reports', `${b}/stub/Reports`), item('Administration', `${b}/stub/Administration`)]
        : [item('Home', `${b}/home`), item('Teller Drawer', `${b}/stub/Teller%20Drawer`), item(t.labels.memberInquiry, `${b}/members`), item('Reports', `${b}/stub/Reports`), item('Wires', `${b}/stub/Wires`)];
    res.send(`<html><body style="margin:0;background:#f4f4f4;font-family:Arial"><table width="100%" cellpadding="6" cellspacing="0">
<tr><td bgcolor="#cccccc"><font size="2"><b>MAIN MENU</b></font></td></tr>${rows.join('')}</table></body></html>`);
  });

  r.get('/home', requireAuth, (req, res) => {
    const t: TenantConfig = (req as any).tenant;
    res.send(mainPage(t, `<b>Welcome.</b> Select a function from the menu.<br><br>
<table border="1" cellpadding="4"><tr><td><font size="2">Host status</font></td><td><font size="2" color="green">ONLINE</font></td></tr>
<tr><td><font size="2">Posting date</font></td><td><font size="2">${new Date().toLocaleDateString('en-US')}</font></td></tr></table>`));
  });

  r.get('/stub/:name', requireAuth, (req, res) => {
    const t: TenantConfig = (req as any).tenant;
    res.send(mainPage(t, `<b>${req.params.name}</b><br><font size="2">Function not available in this environment.</font>`));
  });

  // ---- Member inquiry ----
  r.get('/members', requireAuth, (req, res) => {
    const t: TenantConfig = (req as any).tenant;
    res.send(mainPage(t, inquiryForm(t, base(req))));
  });

  r.post('/members/inquire', requireAuth, async (req, res) => {
    const t: TenantConfig = (req as any).tenant;
    const id = String(req.body.txt1 ?? '').trim();
    if (chaosState[t.id] === 'slow') await sleep(4500);
    if (chaosState[t.id] === 'crash') {
      chaosState[t.id] = 'none';
      return res.status(500).send(mainPage(t, `<font color="red"><b>Application Error</b></font><br><pre>ORA-01033: ORACLE initialization or shutdown in progress
   at LC.Inquiry.MemberSearch(MemberSearch.cs:212)</pre><font size="2">Contact the help desk. Reference #${Math.floor(Math.random() * 90000 + 10000)}</font>`));
    }
    if (!/^\d{5}$/.test(id)) {
      return res.send(mainPage(t, inquiryForm(t, base(req), id, `Invalid member number format. Enter a 5-digit member number.`)));
    }
    const m = MEMBERS[id];
    if (!m) {
      return res.send(mainPage(t, inquiryForm(t, base(req), id, `No record found for member ${id}.`)));
    }
    res.redirect(`${base(req)}/members/${id}`);
  });

  r.get('/members/:id', requireAuth, (req, res) => {
    const t: TenantConfig = (req as any).tenant;
    const m = MEMBERS[req.params.id];
    if (!m) return res.send(mainPage(t, inquiryForm(t, base(req), req.params.id, `No record found for member ${req.params.id}.`)));
    const acctRows = m.accounts
      .map(
        (a) => `<tr><td><font size="2">${a.suffix}</font></td><td><font size="2">${a.type}</font></td><td><font size="2">${a.nickname}</font></td><td align="right"><font size="2">${fmtMoney(a.balance)}</font></td></tr>`,
      )
      .join('');
    const statusColor = m.status === 'Active' ? 'green' : 'red';
    res.send(
      mainPage(
        t,
        `<table width="100%" cellpadding="3"><tr><td colspan="2" bgcolor="${t.color}"><font color="#fff" size="2"><b>MEMBER DETAIL</b></font></td></tr>
<tr><td width="180"><font size="2">${t.labels.memberNumber}</font></td><td><font size="2"><b>${m.id}</b></font></td></tr>
<tr><td><font size="2">Name</font></td><td><font size="2">${m.name}</font></td></tr>
<tr><td><font size="2">Member Since</font></td><td><font size="2">${m.since}</font></td></tr>
<tr><td><font size="2">Status</font></td><td><font size="2" color="${statusColor}">${m.status}</font></td></tr>
</table><br>
<table width="100%" cellpadding="3" border="1" cellspacing="0">
<tr bgcolor="#dddddd"><td><font size="2"><b>Suffix</b></font></td><td><font size="2"><b>Type</b></font></td><td><font size="2"><b>Description</b></font></td><td align="right"><font size="2"><b>${t.labels.balanceHeader}</b></font></td></tr>
${acctRows}</table><br>
<table><tr>
<td><form method="get" action="${base(req)}/members/${m.id}/subaccount/new"><input type="submit" value="${t.labels.openSub}"></form></td>
<td><form method="get" action="${base(req)}/members"><input type="submit" value="New Inquiry"></form></td>
</tr></table>`,
      ),
    );
  });

  // ---- Open sub-account (multi-field form -> review -> irreversible confirm) ----
  r.get('/members/:id/subaccount/new', requireAuth, (req, res) => {
    const t: TenantConfig = (req as any).tenant;
    const m = MEMBERS[req.params.id];
    if (!m) return res.send(mainPage(t, `<font color="red">No record found for member ${req.params.id}.</font>`));
    res.send(mainPage(t, subForm(t, base(req), m.id)));
  });

  r.post('/members/:id/subaccount/review', requireAuth, (req, res) => {
    const t: TenantConfig = (req as any).tenant;
    const m = MEMBERS[req.params.id];
    const s = sess(req);
    if (!m) return res.send(mainPage(t, `<font color="red">No record found.</font>`));
    const type = String(req.body.sel1 ?? '');
    const nick = String(req.body.txt2 ?? '').trim();
    const dep = String(req.body.txt3 ?? '').trim();
    const errs: string[] = [];
    if (!type) errs.push('Account type is required.');
    if (nick.length < 3) errs.push('Nickname must be at least 3 characters.');
    if (!/^\d+(\.\d{1,2})?$/.test(dep) || Number(dep) < 5) errs.push('Initial deposit must be at least $5.00.');
    if (errs.length) return res.send(mainPage(t, subForm(t, base(req), m.id, { type, nick, dep }, errs)));
    if (m.status === 'Restricted' && s.role !== 'supervisor') {
      return res.send(
        mainPage(
          t,
          `<font color="red"><b>Insufficient privileges.</b></font><br><font size="2">Operator ${s.user} is not authorized to open sub-accounts for a Restricted member. Supervisor override required.</font><br><br>
<form method="get" action="${base(req)}/members/${m.id}"><input type="submit" value="Back to Member"></form>`,
        ),
      );
    }
    res.send(
      mainPage(
        t,
        `<table width="100%" cellpadding="3"><tr><td colspan="2" bgcolor="${t.color}"><font color="#fff" size="2"><b>REVIEW NEW SUB-ACCOUNT</b></font></td></tr>
<tr><td width="180"><font size="2">${t.labels.memberNumber}</font></td><td><font size="2">${m.id} &nbsp; ${m.name}</font></td></tr>
<tr><td><font size="2">Account Type</font></td><td><font size="2">${escape(type)}</font></td></tr>
<tr><td><font size="2">Nickname</font></td><td><font size="2">${escape(nick)}</font></td></tr>
<tr><td><font size="2">Initial Deposit</font></td><td><font size="2">${fmtMoney(Number(dep))}</font></td></tr>
</table><br><font size="2">Review the details above. Press Confirm to post this sub-account to the host. <b>This cannot be undone from the console.</b></font><br><br>
<table><tr>
<td><form method="post" action="${base(req)}/members/${m.id}/subaccount/confirm" onsubmit="return confirm('Post new sub-account to host? This cannot be undone.');">
<input type="hidden" name="sel1" value="${escape(type)}"><input type="hidden" name="txt2" value="${escape(nick)}"><input type="hidden" name="txt3" value="${escape(dep)}">
<input type="submit" value="Confirm"></form></td>
<td><form method="get" action="${base(req)}/members/${m.id}/subaccount/new"><input type="submit" value="Back"></form></td>
</tr></table>`,
      ),
    );
  });

  r.post('/members/:id/subaccount/confirm', requireAuth, (req, res) => {
    const t: TenantConfig = (req as any).tenant;
    const m = MEMBERS[req.params.id];
    if (!m) return res.send(mainPage(t, `<font color="red">No record found.</font>`));
    const n = m.accounts.filter((a) => a.suffix.startsWith('S')).length + 1;
    const suffix = `S0${n}`;
    m.accounts.push({ suffix, type: String(req.body.sel1), nickname: String(req.body.txt2).toUpperCase(), balance: Number(req.body.txt3) });
    res.send(
      mainPage(
        t,
        `<table width="100%" cellpadding="3"><tr><td bgcolor="green"><font color="#fff" size="2"><b>TRANSACTION POSTED</b></font></td></tr></table><br>
<font size="2">Sub-account <b>${suffix}</b> opened for member ${m.id}. Host confirmation number <b>HC${Date.now().toString().slice(-8)}</b>.</font><br><br>
<form method="get" action="${base(req)}/members/${m.id}"><input type="submit" value="Return to Member"></form>`,
      ),
    );
  });

  return r;
}

// ---------- templates (deliberately ugly) ----------

function layout(title: string, body: string, color = '#1f3d7a'): string {
  return `<html><head><title>${title}</title></head><body bgcolor="#ffffff" style="font-family:Arial,Helvetica,sans-serif">${body}</body></html>`;
}

function mainPage(t: TenantConfig, inner: string): string {
  return layout(`${t.institution} - Teller Console`, `<table width="100%" cellpadding="6"><tr><td>${inner}</td></tr></table>
<hr><font size="1" color="#777">LegacyCore Teller Console v7.2.1 &middot; ${t.institution} &middot; Session secured</font>`, t.color);
}

function loginPage(t: TenantConfig, b: string, msg?: string, isError = false): string {
  const m = msg ? `<tr><td colspan="2"><font size="2" color="${isError ? 'red' : '#a05a00'}">${msg}</font></td></tr>` : '';
  return layout(
    `${t.institution} - ${t.labels.signOn}`,
    `<br><br><center><table border="1" cellpadding="8" bgcolor="#f0f0f0" width="380">
<tr><td colspan="2" bgcolor="${t.color}"><font color="#fff"><b>${t.institution}</b><br><font size="1">LegacyCore Teller Console</font></font></td></tr>
${m}
<form method="post" action="${b}/login">
<tr><td><font size="2">${t.labels.userId}</font></td><td><input type="text" name="uid" size="16"></td></tr>
<tr><td><font size="2">${t.labels.password}</font></td><td><input type="password" name="pwd" size="16"></td></tr>
<tr><td colspan="2" align="right"><input type="submit" value="${t.labels.signOn}"></td></tr>
</form></table></center>`,
    t.color,
  );
}

function interstitialPage(t: TenantConfig, b: string, next: string): string {
  return layout(
    `${t.institution} - System Notice`,
    `<br><center><table border="1" cellpadding="10" width="460" bgcolor="#fff8dc">
<tr><td><font size="3"><b>SYSTEM NOTICE</b></font></td></tr>
<tr><td><font size="2">Scheduled host maintenance this weekend 11:00 PM - 3:00 AM. Card services may be unavailable. Please advise members accordingly.</font></td></tr>
<tr><td align="right"><form method="post" action="${b}/notice/ack"><input type="hidden" name="next" value="${escape(next)}"><input type="submit" value="Acknowledge"></form></td></tr>
</table></center>`,
    t.color,
  );
}

function inquiryForm(t: TenantConfig, b: string, value = '', error?: string): string {
  const err = error ? `<tr><td colspan="2"><font size="2" color="red"><b>${error}</b></font></td></tr>` : '';
  return `<table width="100%" cellpadding="3"><tr><td colspan="2" bgcolor="${t.color}"><font color="#fff" size="2"><b>${t.labels.memberInquiry.toUpperCase()}</b></font></td></tr>
${err}
<form method="post" action="${b}/members/inquire">
<tr><td width="180"><font size="2">${t.labels.memberNumber}</font></td><td><input type="text" name="txt1" size="10" maxlength="5" value="${escape(value)}"></td></tr>
<tr><td></td><td><input type="submit" value="${t.labels.inquire}"> <input type="reset" value="Clear"></td></tr>
</form></table>`;
}

function subForm(t: TenantConfig, b: string, id: string, v: { type?: string; nick?: string; dep?: string } = {}, errs: string[] = []): string {
  const err = errs.length ? `<tr><td colspan="2"><font size="2" color="red"><b>${errs.join('<br>')}</b></font></td></tr>` : '';
  const opt = (o: string) => `<option value="${o}"${v.type === o ? ' selected' : ''}>${o}</option>`;
  return `<table width="100%" cellpadding="3"><tr><td colspan="2" bgcolor="${t.color}"><font color="#fff" size="2"><b>NEW SUB-ACCOUNT - MEMBER ${id}</b></font></td></tr>
${err}
<form method="post" action="${b}/members/${id}/subaccount/review">
<tr><td width="180"><font size="2">Account Type</font></td><td><select name="sel1"><option value="">-- select --</option>${opt('Share Savings')}${opt('Club Savings')}${opt('Money Market')}</select></td></tr>
<tr><td><font size="2">Nickname</font></td><td><input type="text" name="txt2" size="24" value="${escape(v.nick ?? '')}"></td></tr>
<tr><td><font size="2">Initial Deposit</font></td><td><input type="text" name="txt3" size="10" value="${escape(v.dep ?? '')}"> <font size="1">(min $5.00)</font></td></tr>
<tr><td></td><td><input type="submit" value="Continue"> <input type="button" value="Cancel" onclick="location.href='${b}/members/${id}'"></td></tr>
</form></table>`;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- entrypoint ----
const isMain = process.argv[1] && /server\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const port = Number(process.env.TARGET_PORT ?? 4010);
  createApp().listen(port, () => console.log(`LegacyCore Teller Console listening on http://localhost:${port}`));
}
