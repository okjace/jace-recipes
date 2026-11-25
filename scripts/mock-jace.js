// A local stand-in for Jace's OAuth API, for trying Jace Recipes without a
// real Jace client. Not used in production.
//
//   npm run mock-jace                                  # http://localhost:4000
//   JACE_URL=http://localhost:4000 npm run dev         (or put it in .env.local)
//
// /oauth/authorize shows a picker of test accounts. No passwords.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 4000);
const ACCOUNTS = {
  okjace: { sub: 'u-okjace', username: 'okjace', display_name: 'Jace', picture: null, banned: false, muted: false },
  momchef: { sub: 'u-momchef', username: 'momchef', display_name: 'Mom Chef', picture: null, banned: false, muted: false },
  dadcooks: { sub: 'u-dadcooks', username: 'dadcooks', display_name: 'Dad Cooks', picture: null, banned: false, muted: false },
  mutedmom: { sub: 'u-mutedmom', username: 'mutedmom', display_name: 'Muted Mom', picture: null, banned: false, muted: true },
  bannedbob: { sub: 'u-bannedbob', username: 'bannedbob', display_name: 'Banned Bob', picture: null, banned: true, muted: false },
};
const codes = new Map();
const tokens = new Map();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  console.log(req.method, url.pathname);

  if (url.pathname === '/oauth/authorize') {
    const as = url.searchParams.get('as');
    const back = new URL(url.searchParams.get('redirect_uri'));
    if (!as || !ACCOUNTS[as]) {
      const links = Object.keys(ACCOUNTS).map((name) => {
        const u = new URL(url); u.searchParams.set('as', name);
        return `<p><a href="${esc(u.pathname + u.search)}">Sign in as ${esc(name)}</a></p>`;
      }).join('');
      const deny = new URL(back); deny.searchParams.set('error', 'access_denied'); deny.searchParams.set('state', url.searchParams.get('state') || '');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><title>Mock Jace</title><body style="font-family:sans-serif;padding:40px;background:#111317;color:#e6e8eb"><h1 style="color:#3ddc84">Mock Jace</h1>${links}<p><a style="color:#8b919c" href="${esc(deny)}">Cancel</a></p></body>`);
    }
    const code = randomUUID();
    codes.set(code, ACCOUNTS[as]);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') || '');
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }

  if (url.pathname === '/api/oauth/token' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    const account = codes.get(form.get('code'));
    codes.delete(form.get('code'));
    if (!account) return json(res, 400, { error: 'invalid_grant' });
    const token = randomUUID();
    tokens.set(token, account);
    return json(res, 200, { access_token: token, token_type: 'Bearer', scope: 'profile' });
  }

  if (url.pathname === '/api/oauth/userinfo') {
    const account = tokens.get((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!account) return json(res, 401, { error: 'invalid_token' });
    return json(res, 200, { ...account, name: account.display_name });
  }

  if (url.pathname === '/api/oauth/automod') {
    return json(res, 200, { enabled: true, blocked_terms: ['mockbadword'], max_links: 2 });
  }

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><title>Mock Jace</title><body style="font-family:sans-serif;padding:40px;background:#111317;color:#e6e8eb"><h1 style="color:#3ddc84">Mock Jace is running</h1><p>This only pretends to be Jace for sign-in. Open the app instead: <a style="color:#3ddc84" href="http://localhost:3000">http://localhost:3000</a> (start it with <code>npm run dev</code>).</p></body>');
  }

  json(res, 404, { error: 'not_found' });
}).listen(PORT, () => console.log(`Mock Jace on http://localhost:${PORT}`));
