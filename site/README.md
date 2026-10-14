# Landing page

A small static site: plain HTML, CSS and one copy button. No build, framework,
analytics or remote font requests. All asset paths work under a GitHub Pages
project URL as well as at a domain root.

## Preview

From the repository root, with Python 3 installed:

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory site
```

Open **http://127.0.0.1:4173**. Stop the server with Ctrl+C.

## Publish

The site is not published automatically. To use GitHub Pages:

1. In repository **Settings → Pages**, select **GitHub Actions** as the source.
2. Run the **Landing page** workflow from the Actions tab.

The workflow uploads only `site/`; no application build or credentials are
needed beyond GitHub's deployment token. Normal code pushes do not deploy it.
The same directory can be served by any static host.

## Assets

- `assets/wolf.png`: square mascot icon, cropped from the supplied reference.
- `assets/favicon.png` / `apple-touch-icon.png`: small and touch icons.
- `assets/leader-tab.webp` / `worker-tab.webp`: a real herdr session, staged
  with fictional data, captured at 2× resolution.
- `assets/pack-pane.webp` / `observer-pane.webp`: crops of the leader tab.

See [asset provenance and regeneration](assets/README.md).
