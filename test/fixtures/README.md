# Signature fixtures

## `lamps_mldsa87_rsa4096_pss_sha512/`, `lamps_composite_zero_dropped/`

The LAMPS draft's own vector for id-MLDSA87-RSA4096-PSS-SHA512, the composite
pq_hybrid signs with, and a composite every stack must refuse, copied byte for
byte from macula v12.7.0's `test/fixtures/` (the same bytes macula-go carries).
The draft's are `src/testvectors.json` of
[lamps-wg/draft-composite-sigs](https://github.com/lamps-wg/draft-composite-sigs)
at commit `f0627ab34acfe1aee0abce4bee91ed2b577eab76`, the vectors of
`draft-ietf-lamps-pq-composite-sigs`; macula's README beside them says how they
were fetched and checked. `src/lamps.test.ts` pins each by sha256.

| File | Bytes | What it is |
|------|------:|------------|
| `m.bin` | 44 | the message |
| `ctx.bin` | 71 | the context `s_with_context.bin` was made with |
| `pk.bin` | 3,118 | ML-DSA-87 public key, then the DER `RSAPublicKey` |
| `sk.bin` | 2,380 | ML-DSA-87 seed (32 bytes), then the DER `RSAPrivateKey` |
| `s.bin` | 5,139 | signature over `m.bin` with the empty context |
| `s_with_context.bin` | 5,139 | signature over `m.bin` with `ctx.bin` |
| `lamps_composite_zero_dropped/sig.bin` | 5,138 | a composite by the draft's key whose RSA-PSS half lost its leading zero byte |

## `macula_12_cross/`

Written by `scripts/cross-verify-macula.sh`. `ts_signed/` is a composite this
SDK signed with a pq_hybrid key made for the run, which macula verified (and
refused altered); `macula_signed/` is one macula signed with a key of its own,
which this SDK verifies. Each holds `m.bin`, `pk.bin` (the key as carried) and
`s.bin`. The script prints the macula and OTP versions it ran.
