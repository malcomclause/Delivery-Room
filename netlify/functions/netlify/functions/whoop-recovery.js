// netlify/functions/whoop-recovery.js
//
// The frontend calls this whenever it wants current WHOOP data. It loads the
// stored refresh token, gets a valid access token (refreshing if the stored
// one has expired), calls WHOOP's API server-side, and returns plain JSON.
//
// WHOOP rotates refresh tokens on every use -- each refresh returns a NEW
// refresh token and invalidates the old one. This function always saves
// whatever refresh token comes back, every time, so the next call still works.
// If two requests ever raced each other and refreshed at the same moment,
// the second would fail with an invalid-refresh-token error -- unlikely for
// a single-user tool making occasional requests, but worth knowing about if
// this ever gets called from multiple tabs at once.

import { getStore } from '@netlify/blobs';

async function refreshToken(refresh_token) {
  const res = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token,
      client_id: process.env.WHOOP_CLIENT_ID,
      client_secret: process.env.WHOOP_CLIENT_SECRET
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WHOOP token refresh failed (${res.status}): ${text}`);
  }
  return res.json();
}

export default async (req) => {
  const store = getStore('whoop-tokens');
  const saved = await store.get('primary', { type: 'json' });

  if (!saved) {
    return new Response(JSON.stringify({ error: 'not_connected' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
  }

  try {
    // Refresh proactively if the stored token is more than ~50 minutes old
    // (WHOOP access tokens are typically ~1hr) rather than waiting for a 401.
    const ageMs = Date.now() - saved.obtained_at;
    let accessToken = saved.access_token;
    if (ageMs > 50 * 60 * 1000) {
      const refreshed = await refreshToken(saved.refresh_token);
      accessToken = refreshed.access_token;
      await store.setJSON('primary', {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        obtained_at: Date.now(),
        expires_in: refreshed.expires_in
      });
    }

    // NOTE on confidence: the OAuth endpoints above (auth, token, refresh) are
    // well-documented and consistent across WHOOP's own docs, so those are
    // solid. This part -- the actual data endpoint path and response shape --
    // is the one piece I could not verify with full confidence. WHOOP is
    // mid-migration from a v1 API to a v2 API as of this writing, and their
    // own docs say recovery data now lives nested inside the v2 cycle
    // response rather than a separate endpoint. Check the live API reference
    // at https://developer.whoop.com/api/ for the current path and exact
    // response field names before trusting the parsing below -- treat
    // `/developer/v2/cycle` and the field names pulled out of it (score.strain,
    // score.recovery_score, etc.) as a best-effort starting point, not a
    // confirmed-working call.
    const [cycleRes, recoveryRes] = await Promise.all([
      fetch('https://api.prod.whoop.com/developer/v2/cycle?limit=1', {
        headers: { Authorization: `Bearer ${accessToken}` }
      }),
      fetch('https://api.prod.whoop.com/developer/v2/recovery?limit=1', {
        headers: { Authorization: `Bearer ${accessToken}` }
      })
    ]);

    if (!cycleRes.ok || !recoveryRes.ok) {
      return new Response(JSON.stringify({ error: 'whoop_api_error' }), {
        status: 502,
        headers: { 'content-type': 'application/json' }
      });
    }

    const cycleData = await cycleRes.json();
    const recoveryData = await recoveryRes.json();
    const cycle = cycleData.records && cycleData.records[0];
    const recovery = recoveryData.records && recoveryData.records[0];

    return new Response(JSON.stringify({
      strain: cycle && cycle.score ? cycle.score.strain : null,
      recovery_score: recovery && recovery.score ? recovery.score.recovery_score : null,
      hrv_ms: recovery && recovery.score ? recovery.score.hrv_rmssd_milli : null,
      resting_hr: recovery && recovery.score ? recovery.score.resting_heart_rate : null,
      as_of: cycle ? cycle.start : null
    }), { status: 200, headers: { 'content-type': 'application/json' } });

  } catch (err) {
    console.error('WHOOP recovery fetch error:', err);
    return new Response(JSON.stringify({ error: 'exception', message: err.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }
};
