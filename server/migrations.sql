-- Ludo game server schema (PostgreSQL).
-- Run once against your database, e.g.:
--   psql "$DATABASE_URL" -f migrations.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT        NOT NULL,
  email          TEXT        NOT NULL UNIQUE,
  password_hash  TEXT        NOT NULL,
  coins          INTEGER     NOT NULL DEFAULT 5410,
  games_played   INTEGER     NOT NULL DEFAULT 0,
  games_won      INTEGER     NOT NULL DEFAULT 0,
  wins_2p        INTEGER     NOT NULL DEFAULT 0,
  wins_4p        INTEGER     NOT NULL DEFAULT 0,
  total_earned   BIGINT      NOT NULL DEFAULT 0,
  last_daily_bonus DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS games (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mode       TEXT        NOT NULL,              -- '2p' | '4p'
  entry      INTEGER     NOT NULL,              -- virtual-coin entry fee
  winner_id  UUID        REFERENCES users(id),  -- null when a bot won
  player_ids JSONB       NOT NULL DEFAULT '[]', -- human user ids
  played_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_games_winner_id ON games (winner_id);
CREATE INDEX IF NOT EXISTS idx_games_played_at ON games (played_at);

-- ================= Migration 2: admin panel + economy + referrals =================
-- Virtual coins only. No real-money / deposit / cash-out columns, ever.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_earnings INTEGER NOT NULL DEFAULT 0;

-- Backfill referral codes for pre-existing rows (deterministic from id → unique).
UPDATE users
   SET referral_code = 'U' || upper(substring(md5(id::text), 1, 7))
 WHERE referral_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users (referral_code);

CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- Seed default room tiers (2P win = round(entry*1.6), 4P win = round(entry*3.2))
-- and the economy (all bonus amounts are virtual coins, admin-editable).
INSERT INTO app_config (key, value) VALUES
  ('rooms', '{
    "twoPlayer": [
      {"entry": 40, "win": 64, "enabled": true},
      {"entry": 50, "win": 80, "enabled": true},
      {"entry": 60, "win": 96, "enabled": true},
      {"entry": 80, "win": 128, "enabled": true},
      {"entry": 300, "win": 480, "enabled": true}
    ],
    "fourPlayer": [
      {"entry": 40, "win": 128, "enabled": true},
      {"entry": 50, "win": 160, "enabled": true},
      {"entry": 60, "win": 192, "enabled": true},
      {"entry": 80, "win": 256, "enabled": true},
      {"entry": 300, "win": 960, "enabled": true}
    ]
  }'::jsonb),
  ('economy', '{"signupBonus": 5410, "dailyBonus": 500, "referralBonus": 200}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ================= Migration 4: matchmaking wait times =================
-- Seconds a queue waits for human opponents before bots fill empty seats.
-- Admin-editable via Admin panel → Rooms tab.
INSERT INTO app_config (key, value) VALUES
  ('matchmaking', '{"twoPlayerWaitSec": 8, "fourPlayerWaitSec": 8}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ================= Migration 3: support chat + announcements =================
-- Virtual coins only. No real-money / deposit / cash-out columns, ever.

CREATE TABLE IF NOT EXISTS support_messages (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender        TEXT        NOT NULL CHECK (sender IN ('user', 'admin')),
  text          TEXT        NOT NULL,
  read_by_admin BOOLEAN     NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_user ON support_messages (user_id, created_at);

CREATE TABLE IF NOT EXISTS announcements (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT        NOT NULL,
  body       TEXT        NOT NULL,
  active     BOOLEAN     NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ================= Migration 5: coin ledger (analytics) =================
-- Every virtual-coin movement is recorded here. Virtual coins only:
-- no real-money / deposit / cash-out columns, ever.
CREATE TABLE IF NOT EXISTS coin_ledger (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  amount     INTEGER     NOT NULL,
  kind       TEXT        NOT NULL,
  ref_id     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ledger_created_kind ON coin_ledger (created_at, kind);

-- ================= Migration 6: coin requests + custom options =================
CREATE TABLE IF NOT EXISTS coin_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_coins INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  decided_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_coin_requests_status ON coin_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coin_requests_user ON coin_requests (user_id, created_at DESC);

-- Custom link buttons shown on the home screen (admin-managed, no code needed).
INSERT INTO app_config (key, value) VALUES
  ('custom_options', '[]'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ================= Migration 7: tournaments (single-elimination 1v1) =================
-- Virtual coins only: entry fees and prizes are virtual coins with no cash value.
-- No real-money / deposit / cash-out columns, ever.
CREATE TABLE IF NOT EXISTS tournaments (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  entry_fee    INTEGER     NOT NULL CHECK (entry_fee > 0),
  max_players  INTEGER     NOT NULL CHECK (max_players IN (4, 8, 16, 32)),
  prize_1st    INTEGER     NOT NULL DEFAULT 0 CHECK (prize_1st >= 0),
  prize_2nd    INTEGER     NOT NULL DEFAULT 0 CHECK (prize_2nd >= 0),
  prize_3rd    INTEGER     NOT NULL DEFAULT 0 CHECK (prize_3rd >= 0),
  status       TEXT        NOT NULL DEFAULT 'upcoming'
               CHECK (status IN ('upcoming', 'filling', 'ongoing', 'completed', 'cancelled')),
  starts_at    TIMESTAMPTZ,
  created_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments (status, starts_at);

CREATE TABLE IF NOT EXISTS tournament_players (
  tournament_id  UUID        NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  eliminated     BOOLEAN     NOT NULL DEFAULT false,
  final_position INTEGER,
  PRIMARY KEY (tournament_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_tplayers_tournament ON tournament_players (tournament_id, joined_at);

CREATE TABLE IF NOT EXISTS tournament_matches (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID        NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  round         INTEGER     NOT NULL,  -- 1 = first round, R = final
  match_no      INTEGER     NOT NULL,  -- 1-based within the round
  player1_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  player2_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  winner_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'ready', 'ongoing', 'completed', 'walkover')),
  game_room_id  TEXT,
  ready_at      TIMESTAMPTZ,
  p1_ready_at   TIMESTAMPTZ,
  p2_ready_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tmatches_tournament ON tournament_matches (tournament_id, round, match_no);

-- ================= Migration 8b: daily missions =================
-- Virtual coins only. One claim per user per day per mission.
CREATE TABLE IF NOT EXISTS mission_claims (
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT        NOT NULL,              -- YYYY-MM-DD (UTC)
  mission_key TEXT       NOT NULL,              -- play3 | win1 | win3
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day, mission_key)
);

-- ================= Migration 8: private rooms =================
CREATE TABLE IF NOT EXISTS private_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  creator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_fee INTEGER NOT NULL CHECK (entry_fee >= 50 AND entry_fee <= 100000),
  max_players INTEGER NOT NULL CHECK (max_players IN (2, 4)),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','ongoing','completed','cancelled')),
  commission_pct INTEGER NOT NULL CHECK (commission_pct >= 0 AND commission_pct <= 50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_private_rooms_code ON private_rooms (code);
CREATE INDEX IF NOT EXISTS idx_private_rooms_status ON private_rooms (status, expires_at);

CREATE TABLE IF NOT EXISTS private_room_players (
  room_id uuid NOT NULL REFERENCES private_rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_private_room_players_user ON private_room_players (user_id);

-- Admin-set commission % taken from the prize pool (default 10%).
INSERT INTO app_config (key, value) VALUES
  ('private_commission_pct', '10'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ================= Migration 9: telegram notifications =================
CREATE TABLE IF NOT EXISTS telegram_links (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  telegram_id BIGINT NOT NULL UNIQUE,
  first_name TEXT,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telegram_link_codes (
  code TEXT PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_user ON telegram_link_codes (user_id);

-- ================= Migration 10: phone signup + password reset =================
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT UNIQUE;
CREATE TABLE IF NOT EXISTS password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_code ON password_resets (code);

-- ================= Migration 11: admin-managed coin packs =================
INSERT INTO app_config (key, value) VALUES
  ('coin_packs', '[1000, 5000, 20000]'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ================= Migration 12: payment proof on coin requests =================
ALTER TABLE coin_requests ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE coin_requests ADD COLUMN IF NOT EXISTS transaction_id TEXT;

-- ================= Migration 13: coin store claims + redeem reward codes =================
-- FREE daily coin-store packs (no payment anywhere — virtual coins only).
CREATE TABLE IF NOT EXISTS coin_store_claims (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coin_store_claims_user ON coin_store_claims (user_id, claimed_at);

-- Admin-created reward codes players redeem for free coins.
CREATE TABLE IF NOT EXISTS redeem_codes (
  code TEXT PRIMARY KEY,
  coins INTEGER NOT NULL CHECK (coins >= 1 AND coins <= 100000),
  max_uses INTEGER NOT NULL CHECK (max_uses >= 1 AND max_uses <= 100000),
  used_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS redeem_code_uses (
  code TEXT NOT NULL REFERENCES redeem_codes(code) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (code, user_id)
);
CREATE INDEX IF NOT EXISTS idx_redeem_code_uses_user ON redeem_code_uses (user_id);
