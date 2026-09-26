CREATE TABLE access_readers (
                                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

                                location_id UUID NOT NULL
                                    REFERENCES locations(location_id)
                                        ON DELETE CASCADE,

                                name TEXT NOT NULL,
                                description TEXT,

    -- Examples: iloq, custom_nfc, salto, etc.
                                external_provider TEXT,
                                external_reader_id TEXT,

                                status TEXT NOT NULL DEFAULT 'active'
                                    CHECK (
                                        status IN (
                                                   'active',
                                                   'inactive',
                                                   'maintenance',
                                                   'offline'
                                            )
                                        ),

                                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

                                CONSTRAINT access_reader_name_not_empty
                                    CHECK (LENGTH(TRIM(name)) > 0)
);

CREATE INDEX idx_access_readers_location
    ON access_readers(location_id);

CREATE UNIQUE INDEX uq_access_reader_external
    ON access_readers(external_provider, external_reader_id)
    WHERE external_provider IS NOT NULL
      AND external_reader_id IS NOT NULL;
