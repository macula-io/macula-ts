# Ownership proof v2 vector (mcl-om#7)

Four of the files in macula-go v0.16.0's `ownershipproof/testdata/vector` (the
tag `native/MACULA_GO` pins), which wrote it with mcl_om 0.32.0's own
`mcl_om_ownership_proof` on macula 12.11.1, OTP 28.4.3. See that directory's
README for how it was made.

| File | What it is |
|------|------------|
| `message.hex` | `mcl_om_ownership_proof:message/6` for realm sha256("io.macula"), procedure `mcl-graph/learn_link`, timestamp 1790000000000, nonce 00..0f, and the fields `src/ownershipproof.test.ts` names |
| `identity.hex` | the node_id of the pq_hybrid key that signed it |
| `public_key.hex` | that key's carried public key |
| `signature.hex` | its composite signature over `message.hex` |
