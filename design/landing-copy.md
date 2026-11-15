# Landing page copy (`/` for new visitors without a journal, and `/welcome`)

A single promotional page. Same visual language as the boards. Illustrations are drawn from Editor, Timeline,
Books and Mobile .dc.html (see frontend/src/pages/landing/Mockups.tsx); the burn demo uses the app's real burn
animation (frontend/src/editor/burn.ts). Every claim must stay true of the code; the full detail of privacy lives
on /about (about-copy.md). The core message: Kagimo runs completely on your device, nothing reaches the server
unless you opt into sync, and nothing on the site tracks you.

Header (sticky): brand (back to top) · section menu [Privacy] [No tracking] [Burn it] [Features] [Sync] ·
[Sign in] on the right. With a journal on this device, [Open your journal] replaces [Sign in]. On phones the
menu is a scrolling row under the brand.

"Start writing" in the hero scrolls to the closing section (#start), which holds the real actions.

---

## Hero (beside the editor illustration)

Pill: Private by default · no tracking · works offline

**A journal only you can read.**

A quiet place to write, with places and a book for every year. Your journal is stored on your device,
and nothing is sent anywhere unless you turn on sync. Sync is end-to-end encrypted, so the copy on our server is
unreadable to us and to anyone else.

[Start writing → #start] [How privacy works → #privacy]   (with a journal: [Open your journal])

## Privacy (#privacy, band)

**Only your passphrase can decrypt your journal, and we never see it.**

- **Completely on your device.** Your journal is stored, encrypted, in your browser. Unless you turn on sync,
  none of it ever reaches our server.
- **Only your passphrase opens it.** It never leaves your device. Without it, the stored journal can't be
  decrypted by anyone.
- **Sync, if you want it.** Turn it on to write on all your devices and keep a backup. Everything is encrypted
  before upload, and you can add a passkey or authenticator app to sign-in.

The full details → (/about)

## No tracking (#no-tracking)

**No tracking of any kind. Not a single tag.**

Nothing on this page watches what you do: not what you read, where you click or how long you stay. There is no
code here that reports on you, to us or to anyone else.

- ~~No analytics~~ No analytics scripts, heatmaps, session recordings or "product insights".
- ~~No ad or social tags~~ No pixels, no like or share buttons, no embedded widgets that report back to anyone.
- ~~No third-party code~~ Every script and font comes from our own server. The page tells your browser to refuse
  scripts from anywhere else, so none can slip in. (The Content-Security-Policy in backend/internal/api/server.go.)
- ~~No tracking cookies~~ The only cookies keep you signed in to sync and recognise this device at sign-in.
  Neither is shared with anyone.

Fine print: Only two things ever talk to another site, and only when you ask: the weather, if you turn it on
(Open-Meteo is sent your location rounded to about 10 km, with no cookies), and Stripe's checkout, which opens in
its own tab if you subscribe to sync. Our server keeps only the totals any service needs to stay healthy, such as how many requests it
handled and how many people synced recently: never who, and never what. (The Prometheus metrics in
backend/internal/metrics: route patterns and counts, no paths, ids or users.)

## Burn it (#burn, beside an entry you can burn)

Kicker: Burn it

**Some thoughts are for writing, not keeping.**

Write out the thing that's keeping you up, then burn it. The page drifts off as ash, crumbles away or goes up in
smoke, and the entry is deleted for good: from this device and, with sync on, from our server and your other
devices.

There's no trash folder and no undo. Once it burns, nobody can bring it back, including us.

Demo: [Burn it] plays the real animation on a pretend entry → "Gone. No trash folder, no undo." [Write another].
Note: Try it: this page is only a demo, so nothing is stored or deleted.

## Features (#features, alternating, each with an illustration)

- **Look back on a whole year.** The timeline shows every day you wrote at a glance, then your entries month
  by month, with the places you were.
- **A book for every year.** Each year you write becomes a book you can read start to finish. Give it a title
  and a cloth cover, then print it or export it.
- **Write wherever you are.** It works in the browser on your laptop and your phone, online or off, in light
  and dark themes. You can export everything as Markdown at any time.

## Pledge (between Features and Sync; not in the header menu)

Kicker: Our pledge

One line, large and centred: **No AI anywhere, and zero enshittification for life.**

"No AI anywhere" is a claim about the code and its dependencies: keep it true, or remove the line. The second
half is a promise about the future, so nothing in the code can check it.

## Sync (#sync, band)

**Try sync free for 30 days.** (`freeDays` from /api/config; without billing: **Sync is optional.**)

Writing on one device is free, with no limit. Turn on sync when you want your journal on your phone and laptop
at once, with an encrypted backup on our server.

Two plan cards:

- **Free trial** · Free, no card needed · **30** days · Of sync, from when you turn it on, for up to ~170 pages
  - Sync between all your devices, as many as you like
  - An encrypted backup on our server
  - When the trial ends, keep writing: new changes wait on your device until you subscribe, and everything already
    synced stays yours
- **Subscription** · A$15 / year · **~37,000** pages · A page a day for over 100 years
  - Sync between all your devices and an encrypted backup, for as long as you subscribe
  - Room for a lifetime of writing (a fair-use limit)
  - Cancel any time: everything already synced stays yours to read, edit and export

Fine print: A page here is about 300 words. Journals are text only, so writing goes a long way.

No byte counts are shown. The free trial lasts `freeDays` (`-free-sync-days`, default 30) from when the sync
account is created and is capped at `freeBytes` (`-free-storage-kb`, default 450 KB), whichever comes first. Bytes
become pages at about 2.7 KB per 300-word page (encrypted, measured in the app); the paid figure is `paidBytes` (100 MB). The price comes
from the server's Stripe plans.

## Start (#start, closing)

**Ready when you are.** (Returning visitors: **Welcome back.**)

[Write now → /signup] (primary button) [Sign up → sign-up dialog] (secondary button)

Already sync on another device? Sign in → /signin (plain link)

**Write now** sets up a journal on this device in about a minute, with no account or email. Turn on sync from
inside it whenever you like. **Sign up** makes a sync account straight away: free for {freeDays} days, then {price}.

The sign-up dialog asks for a username, a password and (billing on) an optional invite code, shows the recovery key,
then offers "Start writing" (use the free days) or "Subscribe now" (the upgrade dialog). An invite code makes the
account free, so that last step is skipped.

With a journal on this device: **Your journal is on this device.** [Open your journal]

Footer: brand · How it works · Terms · support email
