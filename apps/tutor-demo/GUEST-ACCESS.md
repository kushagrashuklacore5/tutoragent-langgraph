# Public guest access: proposed backend work

**Status: not implemented. Needs approval before any backend change.**

Today the demo signs in to one shared account through a development-only link. That is safe for a local preview. It is not safe for public visitors, because they would share one learner's conversations and uploads. A frontend cannot fix this.

## Minimum backend work

1. **Guest session endpoint.** `POST /api/demo/session`, off by default behind an environment flag. It creates a new user with the `student` role in a dedicated `demo` tenant and returns a session lasting at most 60 minutes.
2. **Abuse controls on that endpoint.** CAPTCHA or an equivalent check, plus per-IP and global limits on new sessions.
3. **Guest quotas, enforced on the server.** Limits per guest on AI turns, uploads (count and size), generated sections and practice preparation, plus a daily AI budget for the whole demo tenant.
4. **Cleanup job.** A worker job that deletes expired guests and all their data: conversations, checkpoints, documents, books, courses and attempts.
5. **Tenant separation.** The demo tenant uses its own AI budget and never contains real students. Existing RLS then provides the isolation.

The demo client would only need `startSession` changed to call the new endpoint.

## Decisions needed

- Which CAPTCHA or bot check to use.
- The per-guest and daily AI limits.
- Whether guests may upload their own files, or use only the sample document.
