# Jace Recipes

Recipes made by parents, for families. Part of [Jace](https://jaceo.vercel.app).

- **Sign in with Jace** is the only way in (OAuth, no passwords here).
- **Jace usernames** come from Jace. Display name, profile picture and bio can be changed on Jace Recipes.
- **Jace Verified recipes** get a badge, their own category, and always show first.
- **@okjace** can verify and un-verify recipes, choose who can post verified recipes, take recipes down (and restore them), approve held recipes, and suspend accounts.
- **Auto moderation** checks every recipe and name ([`lib/moderation.js`](lib/moderation.js)).
- Jace colors with **light and dark mode** (follows the device, or pick with the sun/moon button).

Plain Node.js with no framework: static files in [`public/`](public), one Vercel function in [`api/index.js`](api/index.js), and the API in [`lib/app.js`](lib/app.js). Data lives in Neon Postgres.

## Run it locally

You need Node.js 20.9 or newer.

```bash
npm install
cp .env.example .env.local
```

The quickest way to try it is with the mock Jace, which has test accounts (`okjace`, `momchef`, `dadcooks`, a muted and a banned one) and no passwords. In `.env.local` set:

```
JACE_URL=http://localhost:4000
JACE_CLIENT_ID=local-dev
JACE_CLIENT_SECRET=local-dev
SESSION_SECRET=<openssl rand -base64 32>
```

Then, in two terminals:

```bash
npm run mock-jace
```

```bash
npm run dev
```

Open http://localhost:3000. Without `DATABASE_URL`, data goes in a local Postgres (PGlite) in `./data`.

```bash
npm test
```

runs the moderation tests and an end-to-end test that signs in through OAuth against the mock.

## Environment variables

| Name | Required | What it is |
| --- | --- | --- |
| `JACE_CLIENT_ID` | yes | OAuth client id from Jace. |
| `JACE_CLIENT_SECRET` | yes | OAuth client secret from Jace. Server only. |
| `SESSION_SECRET` | yes | 32+ random characters that encrypt the sign-in cookie. Changing it signs everyone out. |
| `DATABASE_URL` | yes in production | Neon Postgres connection string. Vercel → Storage → Neon sets it. |
| `APP_URL` | no | Public URL, used for the redirect URI `<APP_URL>/api/auth/callback`. Defaults to the request's host. |
| `JACE_URL` | no | Defaults to `https://jaceo.vercel.app`. |
| `ADMIN_USERNAME` | no | The Jace username that runs the site. Defaults to `okjace`. |
| `ADMIN_JACE_SUB` | no | Locks the admin to one Jace account id (the `sub` from userinfo), in case the username ever changes hands. |

## Deploying to Vercel

1. Import the repo in Vercel (no build step needed; `vercel.json` has the settings).
2. Vercel → Storage → add **Neon** and connect it to the project. This sets `DATABASE_URL`. Tables are created on first request.
3. On Jace, signed in as the site owner: profile → Manage account → Developer → register **Jace Recipes** with the redirect URI `https://<your-domain>/api/auth/callback` (and `http://localhost:3000/api/auth/callback` for local work). Registering it as the site owner makes it an official Jace app, so it can also use Jace's auto moderation terms.
4. Add `JACE_CLIENT_ID`, `JACE_CLIENT_SECRET` and `SESSION_SECRET` in Vercel → Settings → Environment Variables, then redeploy.
5. Sign in as **@okjace**. The first time, four sample Jace Verified recipes are added.

## How it works

**Sign in with Jace.** `/api/auth/signin` stores a random `state` in a short-lived encrypted cookie and redirects to Jace's `/oauth/authorize` (scope `profile`). `/api/auth/callback` checks `state`, exchanges the code on the server, reads `/api/oauth/userinfo`, and sets one encrypted, HTTP-only session cookie. Banned Jace accounts can't sign in; muted ones can't post.

**Profiles.** The Jace username is updated from Jace on every sign-in and can't be changed here. Display name and picture start from Jace the first time, then belong to Jace Recipes.

**Auto moderation.** Every recipe is checked when it's posted or edited:
- **Blocked:** things that aren't food and aren't safe (bleach, antifreeze, detergent pods…), drugs, bad language, spam, and any term on Jace's own auto moderation list.
- **Held for review** until @okjace approves: things that need a person to check (lye, raw milk, links…).
- **Safety notes** added automatically: safe cooking temperatures, raw egg and raw flour, no honey under 12 months, choking hazards in Baby & Toddler recipes, alcohol, allergens and hot oil.

Add words to the lists at the top of `lib/moderation.js` to tune it.

**Security.** Writes must be JSON (blocks cross-site form posts) and the session cookie is `SameSite=Lax`. Everything people write is put on the page as text, never HTML. Pictures are resized in the browser, checked on the server, and served from `/api/images/<id>`.

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a PR.

## License

[MIT](LICENSE)
