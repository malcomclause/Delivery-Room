// netlify/functions/whoop-callback.js
//
// This is the OAuth redirect target registered in your WHOOP developer app.
// WHOOP sends the user here with a `code` after they approve access. This
// function exchanges that code for tokens -- the one step that needs the
// client secret, which is why it has to run server-side and can't live in
// the main HTML file.
//
// Requires a real Netlify site (git-connected or deployed via `netlify deploy`),
// NOT the netlify.com/drop drag-and-drop flow -- that doesn't run Functions.
//
// Environment variables to set in the Netlify UI (Site settings > Environment
// variables), never in this file:
//   WHOOP_CLIENT_ID
//   WHOOP_CLIENT_SECRET
//   WHOOP_REDIRECT_URI   e.g. https://your-site.netlify.app/.netlify/functions/whoop-callback
//   SITE_URL             e.g. https://your-site.netlify.app  (where to redirect back to when done)

import { getStore } from '@netlify/blobs';

export default async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const siteUrl = process.env.SITE_URL || '/';

  if (error) {
    return Response.redirect(`${siteUrl}?whoop=error&reason=${encodeURIComponent(error)}`, 302);
  }
  if (!code) {
    return Response.redirect(`${siteUrl}?whoop=error&reason=missing_code`, 302);
  }

  try {
    const tokenRes = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: process.env.WHOOP_CLIENT_ID,
        client_secret: process.env.WHOOP_CLIENT_SECRET,
        redirect_uri: process.env.WHOOP_REDIRECT_URI
      })
    });

    if (!tokenRes.ok) {
      const bodyText = await tokenRes.text();
      console.error('WHOOP token exchange failed:', tokenRes.status, bodyText);
      return Response.redirect(`${siteUrl}?whoop=error&reason=token_exchange_failed`, 302);
    }

    const tokenData = await tokenRes.json();
    // tokenData: { access_token, refresh_token, expires_in, scope, token_type }

    // Single-user personal tool -- one fixed key is fine. If this were ever
    // multi-user, this key would need to be per-user (e.g. from a session).
    const store = getStore('whoop-tokens');
    await store.setJSON('primary', {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      obtained_at: Date.now(),
      expires_in: tokenData.expires_in
    });

    return Response.redirect(`${siteUrl}?whoop=connected`, 302);
  } catch (err) {
    console.error('WHOOP callback error:', err);
    return Response.redirect(`${siteUrl}?whoop=error&reason=exception`, 302);
  }
};
