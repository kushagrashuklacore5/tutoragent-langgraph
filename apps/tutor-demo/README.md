# Ek Bharat.AI Tutor demo

A separate frontend that showcases the existing Tutor. It calls the existing Tutor APIs and has no backend, AI logic or data of its own.

## Run locally

Start the database, maths solver, API (8081) and worker as usual, then:

```bash
API_URL=http://127.0.0.1:8081 npm run dev -w @platform/app-tutor-demo   # http://localhost:5195
```

The dev tenant needs a member `demo.visitor@demo.test` with the `student` role. The demo signs in only as this account, through the development sign-in link. On a server without that link it shows that guest access is not enabled. See [GUEST-ACCESS.md](GUEST-ACCESS.md).

## Isolation

- All code is in `apps/tutor-demo`. Styles load only in this app.
- The Vite proxy strips `cookie` and `set-cookie`, and the client uses a Bearer token with `credentials: 'omit'`, so the demo never reads or replaces a main-app session on localhost.
- Reset checks `/api/me` first and refuses to run for any other identity.

## Remove it

Delete `apps/tutor-demo`, remove `"apps/tutor-demo"` from `exclude` in the root `tsconfig.json`, and run `npm install`.

## Link from the marketing site

The marketing site is a separate repository and was not changed. To link to a deployed demo:

```html
<a href="https://YOUR-DEMO-HOST/" rel="noopener">Meet Vidya, the Ek Bharat.AI Tutor</a>
```

## Known limits

- Chat streams real status steps, not tokens, because the API returns the reply as one message.
- One shared demo account: suitable for a local or supervised preview, not for public visitors.
- Reset clears the conversation, goal and notebooks. Courses and practice results stay, because the API cannot delete them. An account can hold at most 20 personal courses.
