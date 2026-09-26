CREATE TABLE access_credential_readers (
    credential_id UUID NOT NULL
        REFERENCES access_credentials(id)
        ON DELETE CASCADE,

    reader_id UUID NOT NULL
        REFERENCES access_readers(id)
        ON DELETE CASCADE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (credential_id, reader_id)
);

CREATE INDEX idx_access_credential_readers_reader
    ON access_credential_readers(reader_id);
