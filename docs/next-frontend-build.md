# Next frontend build: brief

Sources: `design/Timeline.dc.html`, `design/Books.dc.html`, `design/YearBook.dc.html`, `design/about-copy.md`,
`docs/security-review-2026-11-11.md`, SPEC.md (incl. the backend agent's §5/§5.1 updates for H1).

## 1. Navigation and username → Settings
- Top-level views: **Write · Timeline · Books** (see the header in Timeline/Books boards). On desktop the nav sits in
  the editor's sidebar head or a slim header, consistent with the boards. On mobile, use a compact segmented control
  on the list view.
- Timeline and Books appear once entries exist on **≥ 2 distinct days**. Before that, show only Write.
- Remove the separate "Settings" link and gear from the sidebar footer. **Clicking the username (shown with a small
  avatar initial, as on the boards) opens Settings.** Keep Admin and Lock in the footer, and keep Settings in the editor ⋯ menu.

## 2. Timeline (`/timeline`, `/timeline/:year`)
- Per the board: the year in large type with totals (entries · words · places · photos), and previous/next year controls.
- Day strip: 12 month columns, one dot per day (written = accent, not written = hairline, future = faint).
  Accessible as an image with a text summary; clicking a written day scrolls to it.
- Month sections with sticky month labels and per-month totals. Entries sit on a vertical spine: large day number +
  weekday, then a card with title, ~2-line snippet, place, time, word count and a photo thumbnail with a count.
- "A quiet stretch: N days" between entries more than 7 days apart.
- Thumbnails: add `coverBlobId` (first image) and `photoCount` to the **encrypted entry header** (§4). Older entries
  without them show no thumbnail until next saved. Thumbnails decrypt lazily (IntersectionObserver), are downscaled to
  ~264px and cached in memory only (cleared on lock, object URLs revoked).
- Everything is computed client-side from decrypted headers. Nothing new on the server.

## 3. Books (`/books`) and year book (`/books/:year`)
- Shelf of cloth covers per the board: year, optional title, username, "In progress" ribbon on the current year,
  stats under each cover. A cover editor (title + six cloths: Ink blue #2F4F6B, Oxblood #6B2F2A, Bottle green
  #33503F, Ochre #8C6A2F, Plum #4A3D57, Linen #D9CFBE with dark foil). Store it in the encrypted settings blob as
  `books: {"2025": {title, cloth}}` (backward compatible).
- Year book: two-page spread on desktop, single page on mobile. Contents page (months with dotted leaders, entry counts,
  page numbers) and paginated reading of all of the year's entries in the user's writing font. Paginate with CSS
  columns or measured blocks; arrow keys and swipe turn pages; deep-link by page. Dividers render as ⁂.
- "Export this year" → the existing Markdown exporter restricted to that year. "Print" → a print stylesheet
  (book-like margins, page breaks per entry, no app chrome) + `window.print()`.

## 4. About page (`/about`, public, no auth)
- Use `design/about-copy.md` **verbatim** (it was reviewed for accuracy), laid out in the app's style. Make "For the
  curious" a `<details>`. Add the extensions paragraph from §6. Link it from the SignIn/SignUp headers ("How privacy
  works") and from Settings.

## 5. Security-review frontend fixes
- **H1 UI:** implement the passphrase sign-in second step exactly as the backend now documents in SPEC
  (`passkey_required` → passkey assertion for that user; `totp_required` with `passkeyAllowed` → offer either). Handle
  `second_factor_required` (403) by routing to `/signup/secure` with an explanation.
- **M3:** stronger passphrase policy. Reject dictionary word + digits/year/symbol patterns and common passwords
  (bundle a compact common-password list and/or zxcvbn-style matching, lazily loaded on the sign-up and change
  passphrase pages). Require roughly ≥ 60 bits estimated, e.g. 4 random words or 16+ mixed characters. Show helpful
  feedback. Update the strength tests (`Summer2024!!` and `Liverpool2023` must be rejected).
- **L4:** `userVerification: 'required'` in `evaluatePrf` and passkey registration on the client.
- **L5:** `spellcheck="false"` on the entry title and body (and the mobile editor), plus autocorrect/autocapitalize
  off where they affect privacy (autocapitalize "sentences" can stay; it is local).
- **L6:** escape the title and location in the combined Markdown export; add tests.
- Mark the outcomes in `docs/security-review-2026-11-11.md`.

## 6. Extension detection and mitigation
- Opt-out attributes on the title and body editables: `data-gramm="false"`, `data-gramm_editor="false"`,
  `data-enable-grammarly="false"`, `data-lt-active="false"`, `data-ms-editor="false"`; also `autocomplete="off"`.
- `src/security/extensions.ts`: a detector that runs only while the app is open and **reports nothing to the server**:
  - A MutationObserver on `document.documentElement` (subtree, attributes, childList) that flags nodes/attributes the
    app didn't create: custom elements / attribute prefixes from known extensions (`grammarly-*`, `data-gr-*`,
    `data-lt-*`, `data-1p-*`, `data-lastpass*`, `data-dashlane*`, `data-bwautofill`, `data-darkreader*`,
    `data-new-gr-c-s-check-loaded`, …), and any element whose `src`/`href` uses `chrome-extension:`, `moz-extension:`,
    `safari-web-extension:` or `ms-browser-extension:`.
  - `securitypolicyviolation` events whose `sourceFile`/`blockedURI` uses an extension scheme.
  - A small known-signature table that maps signals to friendly names (Grammarly, LanguageTool, 1Password, LastPass,
    Bitwarden, Dashlane, Dark Reader, Microsoft Editor). Otherwise "a browser extension".
  - Must not flag the app's own nodes (TipTap/ProseMirror, React portals, our dialogs). Use an allowlist and test it.
- UX: a calm, dismissible notice in the editor (not a modal), matching the notice style on the Main board:
  "*{Name | A browser extension}* is active on this page and may be able to read what you write. For the most
  privacy, write in a private window or a browser profile without extensions." Buttons: **How to** (opens a dialog
  with short steps: private window; separate profile; per-site extension access in Chrome/Edge, Safari and
  Firefox's quarantined domains) and **Don't show again on this device** (localStorage flag, non-secret). Also add
  the line "No notice doesn't guarantee there are no extensions."
- Add a short paragraph to the About page under the privacy steps: "**Browser extensions** can read web pages,
  including this one. For the most privacy, write in a private window or a browser profile without extensions.
  We'll let you know if we notice one at work."
- Unit tests for the detector (jsdom): flags each known signature and extension-scheme URLs; doesn't flag TipTap's
  DOM or our own attributes.

## Verification
`npx tsc --noEmit`, `npx vitest run`, `npm run build`, `make build`, `make test`, `make smoke`. Add a throwaway
Playwright check (scratch dir, deleted afterwards, own server on a free port) covering: the timeline renders after
creating entries on two days; book cover edit persists across reload; year book pages turn; /about loads signed-out;
an injected `<div data-gramm>` triggers the notice; passkey-only passphrase sign-in shows the passkey step.
