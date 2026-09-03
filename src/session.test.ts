import { describe, it, expect } from "vitest";
import { Identity } from "./identity.js";
import { Session } from "./session.js";

// No real station dependency here on purpose -- these run in default
// CI. The real-fleet handshake, plus close()/post-close-accessor
// lifecycle coverage (which needs an actual connected Session to be
// meaningful, not fakeable), is in session.live.test.ts, opt-in via
// MACULA_TS_LIVE -- see README.md.

describe("Session", () => {
  it("connect() against a doomed address rejects with a real Error instead of hanging forever", async () => {
    // 127.0.0.1 with nothing listening: quic-go's own dial times out
    // (empirically ~5s on this host, not the full 30s handshake
    // timeout -- that only starts once a QUIC handshake is actually in
    // flight). The exact number isn't the contract; a bounded,
    // well-labeled rejection is.
    const id = Identity.generate();
    try {
      await expect(Session.connect("127.0.0.1", 1, id)).rejects.toThrow();
    } finally {
      id.dispose();
    }
  }, 15000);
});
