export class Denied extends Error {
  constructor(status) {
    super('Request denied');
    this.status = status;
  }
}

export function bearer(value) {
  if (typeof value !== 'string' || !/^Bearer [A-Za-z0-9._~-]+$/.test(value)) throw new Denied(401);
  return value.slice(7);
}

export function authorize(claims, readerSubject, method) {
  if (!readerSubject || claims.sub !== readerSubject || method !== 'GET') throw new Denied(403);
  return true;
}

export function bindSubject(original, exchanged) {
  if (!original.sub || original.sub !== exchanged.sub) throw new Denied(403);
  return true;
}

export function consumeTransaction(transactions, cookie, state, now = Date.now()) {
  const transaction = transactions.get(cookie);
  transactions.delete(cookie);
  if (!transaction || !state || transaction.state !== state || transaction.expires <= now) {
    throw new Denied(400);
  }
  return transaction;
}
