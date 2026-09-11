-- ============================================================================
-- The client's own confirmation, when someone else places the bid.
--
-- Ashika's rule: a client bidding for themselves needs no further code — they
-- already proved who they were at sign-in. But when an AP, a branch or the back
-- office places, modifies or cancels a bid FOR a client, a one-time code goes to
-- that CLIENT's registered mobile and email and must be entered before the bid is
-- written. The code is what makes the client's consent a fact rather than an
-- assertion by whoever was at the keyboard.
--
-- Separate from ofs_client_otp on purpose. That table is a sign-in challenge; this
-- one is bound to a specific client, issue and action, so a code obtained for
-- "cancel Coal India for S247683" cannot be spent placing a bid for someone else.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ofs.ofs_bid_otp (
  ref          text PRIMARY KEY,
  client_ucc   text        NOT NULL,
  issue_id     bigint      NOT NULL REFERENCES ofs.ofs_issue(id) ON DELETE CASCADE,
  action       text        NOT NULL,              -- place | modify | cancel
  bid_id       bigint,                            -- modify/cancel: which bid
  otp_hash     text        NOT NULL,              -- sha256(code); the code is never stored
  attempts     integer     NOT NULL DEFAULT 0,
  max_attempts integer     NOT NULL DEFAULT 5,
  delivered_to text,                              -- masked, for display only
  channel      text        NOT NULL DEFAULT 'email',
  -- Who asked for it. A client never appears here: this table only exists for
  -- actions taken on a client's behalf.
  requested_by      text   NOT NULL,              -- 'desk:<email>' | 'ap:<code>' | 'branch:<code>'
  requested_by_kind text   NOT NULL,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  ip           text,
  user_agent   text,
  CONSTRAINT ofs_bid_otp_action_ck CHECK (action IN ('place','modify','cancel')),
  CONSTRAINT ofs_bid_otp_kind_ck   CHECK (requested_by_kind IN ('desk','ap','branch')),
  CONSTRAINT ofs_bid_otp_channel_ck CHECK (channel IN ('email','sms','both','test'))
);

CREATE INDEX IF NOT EXISTS ofs_bid_otp_exp_ix ON ofs.ofs_bid_otp (expires_at);
CREATE INDEX IF NOT EXISTS ofs_bid_otp_ucc_ix ON ofs.ofs_bid_otp (client_ucc, issued_at DESC);

-- Which code authorised this bid. ofs_bid.otp_verified already says whether one
-- did; this says which, so an allegation about a single bid can be answered.
ALTER TABLE ofs.ofs_bid ADD COLUMN IF NOT EXISTS otp_ref text;
