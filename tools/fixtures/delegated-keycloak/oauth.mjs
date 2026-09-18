import * as oidc from 'openid-client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Denied } from './security.mjs';

export async function createOAuth(config) {
  const publicClient = await oidc.discovery(new URL(config.issuer), 'interactive', undefined,
    oidc.None(), { execute: [oidc.allowInsecureRequests] });
  const metadata = publicClient.serverMetadata();
  if (metadata.issuer !== config.issuer || !metadata.jwks_uri?.startsWith(`${config.issuer}/`)) {
    throw new Error('Unexpected local provider metadata');
  }
  const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
  async function validate(token, audience, authorizedParty) {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer, audience, algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat', 'aud', 'iss', 'azp'],
      });
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (audiences.length !== 1 || audiences[0] !== audience || payload.azp !== authorizedParty) throw new Denied(401);
      return payload;
    } catch (error) {
      if (error instanceof Denied || error.code?.startsWith('ERR_J')) throw new Denied(401);
      throw error;
    }
  }
  async function begin() {
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(publicClient, {
      redirect_uri: config.redirectUri, scope: 'openid', response_type: 'code',
      state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256', prompt: 'login',
    });
    return { url, verifier, state, nonce, expires: Date.now() + 180_000 };
  }
  async function finish(url, transaction) {
    const tokens = await oidc.authorizationCodeGrant(publicClient, new URL(url), {
      pkceCodeVerifier: transaction.verifier,
      expectedState: transaction.state, expectedNonce: transaction.nonce, idTokenExpected: true,
    });
    // openid-client handles OIDC state/nonce/PKCE; also require explicit JWKS ID-token verification.
    const { payload: identity } = await jwtVerify(tokens.id_token, jwks, {
      issuer: config.issuer, audience: 'interactive', algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'nonce'],
    });
    const claims = await validate(tokens.access_token, 'connector', 'interactive');
    if (identity.sub !== claims.sub || identity.nonce !== transaction.nonce) throw new Denied(401);
    return { token: tokens.access_token, claims };
  }
  async function exchange(token) {
    const response = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`connector:${config.connectorSecret}`).toString('base64')}` },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: token, subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        audience: 'flag-api',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Denied(502);
    const result = await response.json();
    if (result.token_type !== 'Bearer' ||
        result.issued_token_type !== 'urn:ietf:params:oauth:token-type:access_token' ||
        typeof result.access_token !== 'string') throw new Denied(502);
    return result.access_token;
  }
  return { begin, finish, validate, exchange, metadata };
}
