# trainz

`trainz` is a frontend-only prototype built with Vite + React + TypeScript.

It renders a stylized railway scene with a visible track and an animated train that automatically passes from left to right every 15 seconds.

## Run locally
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the dev server:
   ```bash
   npm run dev
   ```
3. Open the printed local URL in your browser.

## Build
```bash
npm run build
```

The production output is generated in `dist/`.

## Notes
- Pure frontend app, no backend service required.
- Main scene and animation live in `src/App.tsx` and `src/styles.css`.
