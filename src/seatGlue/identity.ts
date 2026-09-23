// The one header a seat sends to the spine (step 4): its own bearer token.
// Render resolves it to exactly one seat and that seat's person
// (src/mcp/identity.ts resolveIdentity), so the engine holding it can act as
// that person and no one else — and re-minting the token (rerun install.sh)
// kills it on the next call. It replaced the HMAC headers the glue once signed
// with the gateway's shared identity secret, which could act as anyone in any firm.
export interface SeatHeaders {
  authorization: string;
}

export function seatHeaders(token: string): SeatHeaders {
  if (!token) throw new Error('seat-glue: seat token is empty');
  return { authorization: `Bearer ${token}` };
}
