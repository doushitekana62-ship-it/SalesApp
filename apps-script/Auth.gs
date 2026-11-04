/**
 * PBKDF2-HMAC-SHA256 password hashing.
 * 120,000 iterations; salt is generated per user by ownerSetUserPassword().
 */
function pbkdf2Hex_(password, salt, iterations) {
  const passwordBytes = Utilities.newBlob(String(password)).getBytes();
  const saltBytes = Utilities.newBlob(String(salt)).getBytes();
  const block = saltBytes.concat([0, 0, 0, 1]);
  let u = Utilities.computeHmacSha256Signature(block, passwordBytes);
  const result = u.slice();
  for (let i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, passwordBytes);
    for (let j = 0; j < result.length; j++) result[j] = (result[j] ^ u[j]) & 255;
  }
  return result.map(b => ("0" + ((b + 256) % 256).toString(16)).slice(-2)).join("");
}
