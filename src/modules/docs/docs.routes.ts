import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { notFound } from '../../lib/errors';

// Works from both src/ (tsx) and dist/ (compiled), since both sit one level below the project root.
const SPEC_PATH = path.resolve(__dirname, '../../../docs/openapi.yaml');

export const docsRouter = Router();

docsRouter.get('/openapi.yaml', (_req, res) => {
  if (!fs.existsSync(SPEC_PATH)) throw notFound('API specification');
  res.type('application/yaml').send(fs.readFileSync(SPEC_PATH, 'utf8'));
});

/** Swagger UI for trying endpoints in a browser. Assets come from the CDN, so it needs internet access. */
docsRouter.get('/', (_req, res) => {
  // Helmet's default policy blocks third-party assets; allow only the pinned CDN files
  // and this page's own inline bootstrap (via nonce) — everything else stays denied.
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `script-src 'self' https://cdn.jsdelivr.net 'nonce-${nonce}'`,
      "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Street Cred API</title>
    <link rel="icon" href="data:," />
    <link
      rel="stylesheet"
      href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.0/swagger-ui.css"
      integrity="sha384-Ov4/wv3j2bmct8cDc5X4ngJZohVPzEmc6uDPH8WeljUxO5vtoykvMEfbu9Vh6RaW"
      crossorigin="anonymous"
    />
  </head>
  <body>
    <div id="swagger"></div>
    <script
      src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.0/swagger-ui-bundle.js"
      integrity="sha384-YDALVcy8kj8yltLBVi1vBiBAUqdxvus673gM8XKwiy6aDUJFXivF/KCufekjYbVf"
      crossorigin="anonymous"
    ></script>
    <script nonce="${nonce}">
      // Works whether the page is opened as /docs or /docs/.
      var specUrl = location.origin + location.pathname.replace(/\\/?$/, '/') + 'openapi.yaml';
      window.ui = SwaggerUIBundle({ url: specUrl, dom_id: '#swagger', persistAuthorization: true });
    </script>
  </body>
</html>`);
});
