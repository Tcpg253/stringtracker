# StringTracker

A free, offline-first personal badminton string inventory app. It stores all data in your browser’s IndexedDB—there is no account, server, paid API, database, or subscription.

## Run locally

Because service workers require an HTTP origin (rather than opening `index.html` directly), serve this folder with any small static web server:

```sh
python3 -m http.server 8080
```

Then open `http://localhost:8080` in a modern browser. The app will be usable offline after its first successful load. To install it, use the browser’s **Install app** option; in Safari on iPhone/iPad use **Share → Add to Home Screen**.

## Data and backups

Data remains on the device/browser where it was created. It does **not** automatically synchronize between phones and computers. Open **Settings → Export JSON backup** regularly, then use **Import JSON backup** on another device. Import validates the backup and asks before it replaces local data.

## Calculation behavior

- Yonex 4-Knot is calculated as `11 × racket length + 2 × end-to-T-head length` (default: **8.285m**).
- SZ 2-Knot is calculated as `11.5 × racket length` (default: **7.7625m**).
- Remaining inventory is always `original roll length − confirmed job consumption`; editing or deleting a job recalculates it, avoiding double deductions.
- The planned 11 four-knot + 14 two-knot combination is shown per roll as guidance, never enforced.

## Deploy free on Cloudflare Pages

1. Put these files in a GitHub repository (or upload the folder directly in Cloudflare Pages).
2. In Cloudflare, go to **Workers & Pages → Create → Pages → Connect to Git**.
3. Select the repository. Choose **No framework**; leave the build command blank and set the output directory to `/`.
4. Deploy. Cloudflare gives you a free `pages.dev` URL. No custom domain is needed.

For GitHub Pages, publish this folder from the repository’s `main` branch in **Settings → Pages**. The relative PWA paths work at either a custom site root or a project URL.
