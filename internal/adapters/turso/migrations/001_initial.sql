-- Telegram Quest v1: initial SQLite/libSQL (Turso) schema.
-- Apply once to an empty database, inside a single SQL connection.
-- IMPORTANT: foreign_keys is connection-scoped; the runtime storage adapter
-- must also enable/check foreign-key enforcement for its connections.
PRAGMA foreign_keys = ON;

BEGIN;

-- Quest catalog. The contents of a compiled Ink story are not normalized here.
CREATE TABLE quest (
    id          TEXT PRIMARY KEY NOT NULL,
    title       TEXT NOT NULL CHECK (length(trim(title)) > 0),
    description TEXT NOT NULL,
    genre       TEXT NOT NULL,
    available   INTEGER NOT NULL DEFAULT 0 CHECK (available IN (0, 1))
);

-- story_ref points to an immutable, retrievable compiled .ink.json artifact.
-- The application checks story_hash before using a stored scenario version.
CREATE TABLE quest_version (
    id         TEXT PRIMARY KEY NOT NULL,
    quest_id   TEXT NOT NULL REFERENCES quest(id) ON DELETE RESTRICT,
    version    TEXT NOT NULL CHECK (length(version) > 0),
    story_ref  TEXT NOT NULL CHECK (length(story_ref) > 0),
    story_hash TEXT NOT NULL CHECK (length(story_hash) > 0),
    UNIQUE (quest_id, version)
);

-- owner_id is the Telegram chat ID for a group or the Telegram user ID for
-- a private session, represented as TEXT to preserve IDs exactly.
CREATE TABLE session (
    id               TEXT PRIMARY KEY NOT NULL,
    quest_version_id TEXT NOT NULL REFERENCES quest_version(id) ON DELETE RESTRICT,
    owner_type       TEXT NOT NULL CHECK (owner_type IN ('group', 'user')),
    owner_id         TEXT NOT NULL CHECK (length(owner_id) > 0),
    status           TEXT NOT NULL DEFAULT 'created'
                     CHECK (status IN ('created', 'active', 'paused', 'completed')),
    ink_state_json   TEXT CHECK (
                         CASE
                             WHEN ink_state_json IS NULL THEN 1
                             WHEN json_valid(ink_state_json)
                             THEN json_type(ink_state_json) = 'object'
                             ELSE 0
                         END
                     ),
    state_version    INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    outcome          TEXT,
    menu_message_id  INTEGER,
    -- An active or paused session must always be restorable.
    CHECK (status NOT IN ('active', 'paused') OR ink_state_json IS NOT NULL),
    CHECK (status <> 'completed' OR (outcome IS NOT NULL AND length(outcome) > 0)),
    CHECK (status = 'completed' OR outcome IS NULL)
);

-- A group can have only one unfinished session, including paused/created.
-- Historical completed sessions are allowed.
CREATE UNIQUE INDEX ux_session_unfinished_group
    ON session(owner_id)
    WHERE owner_type = 'group'
      AND status IN ('created', 'active', 'paused');

CREATE INDEX ix_session_owner ON session(owner_type, owner_id);
CREATE INDEX ix_session_quest_version ON session(quest_version_id);

-- One turn is one Ink decision point, not necessarily one paragraph or chapter.
-- On rollback, delete turns starting with the selected step and re-create that
-- step with a NEW turn ID, so callbacks from the old history become invalid.
CREATE TABLE turn (
    id                    TEXT PRIMARY KEY NOT NULL,
    session_id            TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    step_no               INTEGER NOT NULL CHECK (step_no >= 1),
    ink_checkpoint_json   TEXT NOT NULL CHECK (
                              CASE
                                  WHEN json_valid(ink_checkpoint_json)
                                  THEN json_type(ink_checkpoint_json) = 'object'
                                  ELSE 0
                              END
                          ),
    scene_text            TEXT NOT NULL,
    choices_json          TEXT NOT NULL CHECK (
                              CASE
                                  WHEN json_valid(choices_json)
                                  THEN json_type(choices_json) = 'array'
                                       AND json_array_length(choices_json) > 0
                                  ELSE 0
                              END
                          ),
    default_choice_index  INTEGER,
    vote_duration_ms      INTEGER,
    deadline_at_ms        INTEGER,
    remaining_ms          INTEGER,
    decision_choice_index INTEGER,
    interactive_message_id INTEGER,
    UNIQUE (session_id, step_no),
    CHECK (default_choice_index IS NULL OR (
        default_choice_index >= 0 AND
        default_choice_index < json_array_length(choices_json)
    )),
    CHECK (decision_choice_index IS NULL OR (
        decision_choice_index >= 0 AND
        decision_choice_index < json_array_length(choices_json)
    )),
    -- Timed group choices must have a configured default choice.
    CHECK (vote_duration_ms IS NULL OR (
        vote_duration_ms > 0 AND default_choice_index IS NOT NULL
    )),
    CHECK (deadline_at_ms IS NULL OR deadline_at_ms >= 0),
    CHECK (remaining_ms IS NULL OR remaining_ms >= 0),
    CHECK (deadline_at_ms IS NULL OR vote_duration_ms IS NOT NULL),
    CHECK (remaining_ms IS NULL OR vote_duration_ms IS NOT NULL),
    -- Running clock: deadline; paused clock: remaining duration; never both.
    CHECK (deadline_at_ms IS NULL OR remaining_ms IS NULL)
);

-- Decision is part of Turn: NULL means waiting for a final choice.
CREATE UNIQUE INDEX ux_turn_one_open_per_session
    ON turn(session_id)
    WHERE decision_choice_index IS NULL;

-- A voter has one counted ballot per turn; an explicit update of their ballot
-- is possible if/when the application's re-voting policy permits it.
CREATE TABLE vote (
    turn_id      TEXT NOT NULL REFERENCES turn(id) ON DELETE CASCADE,
    voter_id     TEXT NOT NULL CHECK (length(voter_id) > 0),
    choice_index INTEGER NOT NULL CHECK (choice_index >= 0),
    cast_at_ms   INTEGER NOT NULL CHECK (cast_at_ms >= 0),
    PRIMARY KEY (turn_id, voter_id)
);

-- Insert update_id IN THE SAME TRANSACTION as its accepted state change.
-- Otherwise a crash between separate writes can lose or duplicate an action.
CREATE TABLE processed_update (
    update_id       INTEGER PRIMARY KEY NOT NULL,
    processed_at_ms INTEGER NOT NULL CHECK (processed_at_ms >= 0)
);

COMMIT;
