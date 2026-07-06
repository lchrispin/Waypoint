/* Entry point. The app lives in src/ as ES modules; this file exists so index.html's
 * stamped `app.js?v=<sha>` reference (see .github/workflows/stamp-version.yml) stays the
 * single top-level script across deploys. The previous single-file implementation is
 * preserved verbatim in legacy/. */
import './src/main.js';
