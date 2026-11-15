# How it works copy (route `/about`, public): safety and privacy

Use this wording. Keep it short, calm and plain, in the same visual language as the other boards: Newsreader
display, Inter body, paper background, one accent, generous whitespace. Don't add claims that aren't here; every
claim below must stay true of the code. If the code changes, update the copy. The product tour lives on the
landing page (landing-copy.md); this page is only about safety and privacy.

Header: brand (→ /welcome without a journal), [Sign in to sync] link, [Start writing] button; with a journal on
this device: [Open your journal]. Returning visitors (signed in on this browser before, or carrying the device
cookie) see one [Sign in] button instead.

---

## Hero

Eyebrow: HOW IT WORKS

**How your journal stays private**

Kagimo runs entirely on your device. Your journal is stored there, encrypted, and nothing is sent anywhere
unless you turn on sync. With sync on, everything is encrypted before it leaves your device. Our server stores it
but never has the key, so neither we nor anyone else can read it.

## Diagram: device → stored on your device ⇢ server (only with sync)

- **Your device.** "A long walk after the rain". You write. Your key, unlocked by your passphrase, encrypts it here.
- **Stored on your device.** (scrambled text) Saved encrypted in your browser. Works offline. This is where it stays.
- **Our server, only with sync.** (blocks) If you turn sync on, it keeps the same scrambled copy for your other
  devices. It has no key.

Caption: Your words are readable only on a device where you've unlocked your journal.

## What keeps it private

1. **It all happens on your device.** No account needed. Your journal is written, stored and searched in your
   browser, and works without a connection.
2. **Your passphrase stays on your device.** It locks your journal key. Even what's stored in your browser is
   unreadable without it.
3. **Sync is optional, and encrypted.** Turn it on to use your journal on all your devices and keep a copy
   safe. Entries, titles, places and settings are encrypted before upload, so our server only ever
   receives encrypted data.
4. **Places stay private.** Place names are looked up on your device, so your coordinates never leave it.
5. **Strong sign-in for sync.** A sync account needs a passkey or authenticator app, so a stolen password alone
   isn't enough.
6. **Locked when you step away.** Keys live only in memory. They're forgotten when you lock, close the tab, or
   after a few idle minutes (you choose how many). Reloading the page keeps the journal open.

**Tip:** browser extensions can read any page. For the most privacy, write in a window without them.

## What we can and can't see

Without sync: nothing at all. Your journal never reaches us. With sync on:

**Never:** what you write, and entry titles · the places you tag · your settings and book
titles · your passphrase or recovery key.

**We can see:** your sync username · how many entries you have, and their sizes ·
connection details like your IP address.

## The trade-off

**Nobody can reset your passphrase.** Keep the recovery key you get when you start your journal somewhere safe.
Lose both, and your journal is gone for good.

**Without sync, your journal exists in one place.** If the browser's data is cleared or the device is lost, it
goes too. Export it now and then, or turn on sync.

The app itself is delivered by our server (then kept on your device), so you are trusting us not to change that
code.

## For the curious (collapsed)

- Passphrase stretched with **Argon2id** (64 MiB, 3 passes); keys derived with **HKDF-SHA-256**.
- Content encrypted with **AES-256-GCM**, a fresh nonce per item, each ciphertext bound to its own entry
  or setting.
- Passkeys can unlock your journal where the WebAuthn PRF extension is supported.
- The recovery key is 160 random bits, shown as 32 characters.
- On your device, the journal is kept in IndexedDB in the same encrypted form the server would store; the app
  itself is cached by a service worker so it opens offline.
- Edits made on two devices at once are merged paragraph by paragraph on your device; only clashing passages ask
  you to choose.
- The encryption code is also published on its own (MIT), with its design and threat model: github.com/kagimo-journal/crypto.
- The whole app is open source (AGPL): github.com/kagimo-journal/kagimo. It reaches your browser as readable code,
  not minified: open your browser's developer tools to read exactly what runs. Review is welcome. Tell us what you find at {support email}.
- With sync on, Settings → Sync & backup shows your latest entry beside what our server stores for it, and every
  request your device has sent.

## Closing CTA (signed out)

**Ready to start writing?** [Start writing] [Take the tour → /welcome]

No account needed. You can turn on sync later.

Returning visitors: **Sign in to open your journal** [Sign in] [Take the tour → /welcome], no fine print.
