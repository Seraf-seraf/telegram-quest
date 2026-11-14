-- Preserve the final Ink scene after the active turn has been completed.
ALTER TABLE session ADD COLUMN final_scene_text TEXT;
ALTER TABLE session ADD COLUMN final_scene_tags_json TEXT CHECK (
    CASE
        WHEN final_scene_tags_json IS NULL THEN 1
        WHEN json_valid(final_scene_tags_json)
        THEN json_type(final_scene_tags_json) = 'array'
        ELSE 0
    END
);
