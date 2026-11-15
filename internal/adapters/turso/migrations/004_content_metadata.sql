ALTER TABLE turn ADD COLUMN scene_tags_json TEXT NOT NULL DEFAULT '[]' CHECK (
    CASE
        WHEN json_valid(scene_tags_json)
        THEN json_type(scene_tags_json) = 'array'
        ELSE 0
    END
);

CREATE TABLE content_metadata (
    id       INTEGER PRIMARY KEY,
    quest_id TEXT NULL REFERENCES quest(id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    kind     TEXT NOT NULL CHECK (length(trim(kind)) > 0),
    value    TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_content_metadata_quest_name
    ON content_metadata(quest_id, name)
    WHERE quest_id IS NOT NULL;

CREATE UNIQUE INDEX ux_content_metadata_global_name
    ON content_metadata(name)
    WHERE quest_id IS NULL;
