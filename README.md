# StringTracker

A free, offline-first personal badminton string inventory app. It stores all data in your browser’s IndexedDB—there is no account, server, paid API, database, or subscription.

## Run locally

Because service workers require an HTTP origin (rather than opening `index.html` directly), serve this folder with any small static web server:

```sh
python3 -m http.server 8080
```

Then open `http://localhost:8080` in a modern browser. The app will be usable offline after its first successful load. To install it, use the browser’s **Install app** option; in Safari on iPhone/iPad use **Share → Add to Home Screen**.

## Data and backups

Data remains on the device/browser where it was created. It does **not** automatically synchronize between phones and computers. Open **Settings → Export** regularly, then use **Import** on another device. Import validates the backup and asks before it replaces local data.

## Stringing methods

Methods are set up in **Settings → Stringing methods**. Each one has a name and a vertical and horizontal part, built by tapping length buttons:

- **Racket length** and **End to T-head** use the measurements in Settings (default 67.5 cm and 43 cm).
- **½ racket** is half the racket length.

The defaults reproduce the original methods: YY = 11 racket lengths + 2 end-to-T-head (**8.285 m**), SZ = 11.5 racket lengths (**7.7625 m**). Changing a method or a measurement only affects rackets logged afterwards; each logged entry keeps the amount it deducted. Switch a method off to hide it from the roll cards, or delete it; its past entries stay in the history under its name.

## Calculation behavior

- Remaining string is always `roll length − string used before tracking − logged rackets`; editing or deleting an entry recalculates it.
- New rolls start at the "New roll length" from Settings (default 200 m).
- The "left" count on each log button comes from splitting the remaining string across the methods that are switched on: the most rackets possible, favouring the method at the top of the list. A button goes gray when that split has none of it left. It is guidance, never enforced.
- A roll is "Finished" once it cannot fit one more racket, and "Low" below the warning length in Settings.

## Deploy free on Cloudflare Pages

1. Put these files in a GitHub repository (or upload the folder directly in Cloudflare Pages).
2. In Cloudflare, go to **Workers & Pages → Create → Pages → Connect to Git**.
3. Select the repository. Choose **No framework**; leave the build command blank and set the output directory to `/`.
4. Deploy. Cloudflare gives you a free `pages.dev` URL. No custom domain is needed.

For GitHub Pages, publish this folder from the repository’s `main` branch in **Settings → Pages**. The relative PWA paths work at either a custom site root or a project URL.
