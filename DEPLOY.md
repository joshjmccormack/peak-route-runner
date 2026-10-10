# Deploying PinAssist

PinAssist stays on GitHub Pages at https://pinassist.app. The readable source in the repo root is what Pages serves today. Production publishes a minified `dist/` build through GitHub Actions. DNS stays where it is (Porkbun, already pointed at GitHub Pages). There is no DNS cutover.

## What the workflow does

`.github/workflows/pages.yml` runs on every push to `main`:

1. Check out the repository.
2. Set up Node.js.
3. `npm ci`
4. `npm run build` (esbuild). Output is `dist/`, with no source maps.
5. Upload `dist/` with `actions/upload-pages-artifact`.
6. Deploy that artifact with `actions/deploy-pages`.

`dist/CNAME` is `pinassist.app`, so the custom domain stays on the Pages site.

`dist/` and `node_modules/` are gitignored. GitHub Actions builds on the runner. Commit `package-lock.json` so `npm ci` is repeatable.

## Cutover order

Do these in order. Do not make the repository private before the Actions deploy is confirmed.

1. GitHub Pro is active on the account that owns the repository. Pages on a private repo needs a paid plan. Making the repo private on a free GitHub plan takes the GitHub Pages site down.
2. Merge the pull request that adds this workflow and the production build.
3. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**. Confirm the workflow run succeeds, then open https://pinassist.app and confirm it is serving the minified build (page source is minified, and the service worker cache name is `pinassist-v1.31`).
4. Only then make the repository private, and load https://pinassist.app again to confirm it still works.

Until step 3, GitHub Pages keeps serving the root source as it does today. Merging the pull request does not by itself change the Pages source setting.

Netlify and Vercel are equivalent alternatives if you later leave GitHub Pages: build command `npm run build`, publish directory `dist`.
