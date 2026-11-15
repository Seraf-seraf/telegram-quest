-- Temporary tables used by the v2-to-v3 data migration. The migration code
-- copies and validates the rows, drops the old FK chain, then renames these
-- tables to their final names inside the same write transaction.
CREATE TABLE quest_new (
    id          TEXT PRIMARY KEY NOT NULL,
    title       TEXT NOT NULL CHECK (length(trim(title)) > 0),
    description TEXT NOT NULL,
    genre       TEXT NOT NULL,
    available   INTEGER NOT NULL DEFAULT 0 CHECK (available IN (0, 1)),
    story_json  TEXT NOT NULL CHECK (
                    CASE
                        WHEN json_valid(story_json)
                        THEN json_type(story_json) = 'object'
                        ELSE 0
                    END
                )
);

CREATE TABLE session_new (
    id               TEXT PRIMARY KEY NOT NULL,
    quest_id         TEXT NOT NULL REFERENCES quest_new(id) ON DELETE RESTRICT,
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
    final_scene_text TEXT,
    final_scene_tags_json TEXT CHECK (
                         CASE
                             WHEN final_scene_tags_json IS NULL THEN 1
                             WHEN json_valid(final_scene_tags_json)
                             THEN json_type(final_scene_tags_json) = 'array'
                             ELSE 0
                         END
                     ),
    CHECK (status NOT IN ('active', 'paused') OR ink_state_json IS NOT NULL),
    CHECK (status <> 'completed' OR (outcome IS NOT NULL AND length(outcome) > 0)),
    CHECK (status = 'completed' OR outcome IS NULL)
);

CREATE TABLE turn_new (
    id                    TEXT PRIMARY KEY NOT NULL,
    session_id            TEXT NOT NULL REFERENCES session_new(id) ON DELETE CASCADE,
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
    CHECK (vote_duration_ms IS NULL OR (
        vote_duration_ms > 0 AND default_choice_index IS NOT NULL
    )),
    CHECK (deadline_at_ms IS NULL OR deadline_at_ms >= 0),
    CHECK (remaining_ms IS NULL OR remaining_ms >= 0),
    CHECK (deadline_at_ms IS NULL OR vote_duration_ms IS NOT NULL),
    CHECK (remaining_ms IS NULL OR vote_duration_ms IS NOT NULL),
    CHECK (deadline_at_ms IS NULL OR remaining_ms IS NULL)
);

CREATE TABLE vote_new (
    turn_id      TEXT NOT NULL REFERENCES turn_new(id) ON DELETE CASCADE,
    voter_id     TEXT NOT NULL CHECK (length(voter_id) > 0),
    choice_index INTEGER NOT NULL CHECK (choice_index >= 0),
    cast_at_ms   INTEGER NOT NULL CHECK (cast_at_ms >= 0),
    PRIMARY KEY (turn_id, voter_id)
);

CREATE UNIQUE INDEX ux_session_unfinished_group
    ON session_new(owner_id)
    WHERE owner_type = 'group'
      AND status IN ('created', 'active', 'paused');
CREATE INDEX ix_session_owner ON session_new(owner_type, owner_id);
CREATE INDEX ix_session_quest ON session_new(quest_id);
CREATE UNIQUE INDEX ux_turn_one_open_per_session
    ON turn_new(session_id)
    WHERE decision_choice_index IS NULL;
