# GoPocket rules

- Do not guess or hallucinate. Code as per facts: selectors, page text, field ids, order flows and statuses must come from a real recorded page (saved evidence, `docs/gopocket-site-notes.md`, or a live look), never from assumed markup such as `tr` or `role=row`. If a fact is missing, capture it first.
- While coding/designing, keep it simple, do not over think, do not over complicate things.

# Running

- Run gopocket with `npm run dev` (tsc watch: it restarts gopocket after every successful compile). `npm run start` also starts it this way (via `npm run dev`, detached) plus the router, so gopocket is always under tsc watch.
- Run the router (WhatsApp, `../whatsapp`) with `npm run dev` from that folder.
- Call this project "gopocket", never "the bot".
