BEGIN;

ALTER TABLE feedback
    DROP CONSTRAINT feedback_message_check;

ALTER TABLE feedback
    ADD CONSTRAINT feedback_message_length_check
    CHECK (char_length(message) BETWEEN 8 AND 221);

COMMIT;
